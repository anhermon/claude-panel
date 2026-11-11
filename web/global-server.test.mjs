import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TEST_TOKEN, startServer } from './testkit.mjs';

const dir = mkdtempSync(join(tmpdir(), 'global-server-'));
const procs = [];
after(() => { for (const p of procs) p.kill(); rmSync(dir, { recursive: true, force: true }); });

const SID = '00000001-1111-4111-8111-111111111111';
// A fake ~/.claude with one session of the last hour, handed to the server through CLAUDE_CONFIG_DIR.
const claude = join(dir, 'claude');
mkdirSync(join(claude, 'projects', '-Users-u-proj'), { recursive: true });
const transcript = join(claude, 'projects', '-Users-u-proj', `${SID}.jsonl`);
writeFileSync(transcript, [
  { type: 'ai-title', aiTitle: 'Global view fixture' },
  { type: 'user', timestamp: new Date().toISOString(), cwd: '/Users/u/proj', gitBranch: 'feature/DEV-7-x', message: { role: 'user', content: 'hello DEV-7' } },
].map((r) => JSON.stringify(r)).join('\n') + '\n');
utimesSync(transcript, new Date(), new Date());
const stateFile = join(dir, 'claude-panel', 'panel-x.json');
mkdirSync(join(dir, 'claude-panel'), { recursive: true });
writeFileSync(stateFile, '{}');
const start = (opts = {}) => startServer(stateFile, { procs, env: { CLAUDE_CONFIG_DIR: claude, HOME: dir }, ...opts });

test('/<token>/global serves the page with its own CSP (no inline script) and redirects to the slash form', async () => {
  const s = await start();
  const redirect = await s.api('/global');
  assert.equal(redirect.status, 308);
  assert.equal(redirect.headers.location, `/${TEST_TOKEN}/global/`);
  const page = await s.api('/global/');
  assert.equal(page.status, 200);
  assert.match(page.headers['content-type'], /text\/html/);
  const csp = page.headers['content-security-policy'];
  assert.match(csp, /script-src 'self'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.ok(!csp.includes('unsafe-inline') && !csp.includes('unsafe-eval'));
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(page.text), 'no inline script');
  assert.ok(!/\son[a-z]+\s*=/i.test(page.text), 'no inline handler');
  assert.equal(page.headers['cache-control'], 'no-store');
  for (const f of ['global.js', 'global.css']) assert.equal((await s.api(`/global/${f}`)).status, 200, f);
  assert.equal((await s.api('/global/index.html')).status, 404); // exact allow-list
  assert.equal((await s.api('/global/..%2Fserver.mjs')).status, 404);
  assert.equal((await s.api('/global/a/b')).status, 404);
  assert.equal((await s.api('/global/', { method: 'POST' })).status, 405);
  s.kill();
});

test('/<token>/global/state.json lists the sessions of the fake ~/.claude, and only GET/HEAD', async () => {
  const s = await start();
  const res = await s.api('/global/state.json');
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /application\/json/);
  const body = JSON.parse(res.text);
  assert.equal(body.totals.sessions, 1);
  assert.equal(body.sessions[0].title, 'Global view fixture');
  assert.equal(body.sessions[0].branch, 'feature/DEV-7-x');
  assert.deepEqual(body.jira.map((g) => g.key), ['DEV-7']);
  assert.equal((await s.api('/global/state.json', { method: 'HEAD' })).status, 200);
  assert.equal((await s.api('/global/state.json', { method: 'POST' })).status, 405);
  s.kill();
});

test('global routes follow the same token and Host rules as every other route', async () => {
  const s = await start();
  for (const p of ['/global', '/global/', '/global/state.json', '/global/global.js']) {
    assert.equal((await s.get(`/wrong${p}`)).status, 404, `wrong token ${p}`);
    assert.equal((await s.get(`/${TEST_TOKEN}x${p}`)).status, 404, `token prefix ${p}`);
    assert.equal((await s.get(`${p}`)).status, 404, `no token ${p}`);
    assert.equal((await s.api(p, { host: 'evil.example' })).status, 421, `host ${p}`); // DNS rebinding
  }
  assert.equal((await s.get(`/${TEST_TOKEN}/global/state.json`, { host: `localhost:${s.port}` })).status, 200);
  s.kill();
});
