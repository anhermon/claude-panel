import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fleetConfig } from './config.mjs';
import { createFeed } from './feed.mjs';
import { parsePs } from './registry.mjs';
import { createFleetServer } from './server.mjs';
import { ORIGIN_PREFIX } from './commands.mjs';
import { FAKE_KEY, jl, mkTmp, sampleRows, SID } from './fixtures.mjs';

const NOW = Date.now();
const LSTART = 'Thu Nov  5 09:34:30 2026';
const TOKEN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718';
const PAGE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'page');

async function boot({ hubOnline = true } = {}) {
  const root = mkTmp('fleet-srv-');
  const cfg = fleetConfig({ HOME: root, CLAUDE_CONFIG_DIR: path.join(root, '.claude'), CLAUDE_FLEET_DIR: path.join(root, 'state'), CLAUDE_FLEET_DISCOVER_EVERY_MS: '1', CLAUDE_FLEET_PS_EVERY_MS: '1' });
  fs.mkdirSync(cfg.sessionsDir, { recursive: true });
  const dir = path.join(cfg.projectsDir, '-Users-alice-proj');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${SID.A}.jsonl`), jl(sampleRows(NOW)));
  fs.writeFileSync(path.join(cfg.sessionsDir, '100.json'), JSON.stringify({ pid: 100, sessionId: SID.A, cwd: '/Users/alice/proj', procStart: LSTART, status: 'busy' }));
  fs.mkdirSync(cfg.stateDir, { recursive: true });
  if (hubOnline) fs.writeFileSync(cfg.hubFile, JSON.stringify({ ts: Date.now(), sessionId: 'hub-session' }));
  const feed = createFeed({ cfg, now: () => NOW, scan: async () => parsePs(` 100     1 ${LSTART} claude --session-id ${SID.A}`) });
  await feed.tick();
  const app = createFleetServer({ cfg, token: TOKEN, feed });
  const port = await app.listen(0);
  const base = `http://127.0.0.1:${port}`;
  return { cfg, app, port, base, root, close: () => app.close() };
}

/** A raw request, so a test can set Host / Origin / Content-Type exactly. */
function raw(port, { method = 'GET', url, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: url, headers }, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(body);
  });
}
const post = (s, body, headers = {}) => raw(s.port, { method: 'POST', url: `/${TOKEN}/send`, headers: { host: `127.0.0.1:${s.port}`, 'content-type': 'application/json', origin: s.base, ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });

test('the token gates every route; a wrong Host is 421; traversal and unknown methods are refused', async () => {
  const s = await boot();
  try {
    const host = `127.0.0.1:${s.port}`;
    assert.equal((await raw(s.port, { url: `/${TOKEN}/state`, headers: { host } })).status, 200);
    assert.equal((await raw(s.port, { url: '/wrong/state', headers: { host } })).status, 404);
    assert.equal((await raw(s.port, { url: '/state', headers: { host } })).status, 404);
    assert.equal((await raw(s.port, { url: `/${TOKEN}/state`, headers: { host: 'evil.example:80' } })).status, 421);
    assert.equal((await raw(s.port, { url: `/${TOKEN}/../../etc/passwd`, headers: { host } })).status, 404);
    assert.equal((await raw(s.port, { url: `/${TOKEN}/%2e%2e/config.mjs`, headers: { host } })).status, 404);
    assert.equal((await raw(s.port, { method: 'DELETE', url: `/${TOKEN}/state`, headers: { host } })).status, 405);
    const page = await raw(s.port, { url: `/${TOKEN}/`, headers: { host } });
    assert.equal(page.status, 200);
    assert.match(page.headers['content-security-policy'], /script-src 'self'/);
    assert.doesNotMatch(page.headers['content-security-policy'], /script-src[^;]*unsafe-inline/);
  } finally { s.close(); }
});

test('a secret planted in a transcript is masked in the state, the drill-down and the served page assets', async () => {
  const s = await boot();
  try {
    const host = `127.0.0.1:${s.port}`;
    const state = (await raw(s.port, { url: `/${TOKEN}/state`, headers: { host } })).text;
    const detail = (await raw(s.port, { url: `/${TOKEN}/session/${SID.A}?limit=600`, headers: { host } })).text;
    assert.ok(state.includes(SID.A));
    assert.ok(detail.includes('"events"'));
    for (const body of [state, detail, fs.readFileSync(s.cfg.stateFile, 'utf8')]) {
      assert.ok(!body.includes(FAKE_KEY), 'the fake key must be masked');
      assert.ok(!body.includes('hunter22secret'), 'the password must be masked');
    }
    // text is data, never markup: the page assets contain no HTML sink at all
    for (const f of fs.readdirSync(PAGE_DIR).filter((n) => n.endsWith('.js'))) {
      assert.doesNotMatch(fs.readFileSync(path.join(PAGE_DIR, f), 'utf8'), /innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function/, f);
    }
  } finally { s.close(); }
});

test('POST /send: JSON only, same origin only, size capped, validated against the live state, queued for the hub', async () => {
  const s = await boot();
  try {
    const ok = { sessionId: SID.A, text: 'fleet send test, ignore' };
    assert.equal((await post(s, ok, { 'content-type': 'text/plain' })).status, 415);
    assert.equal((await post(s, ok, { origin: 'http://evil.example' })).status, 403);
    assert.equal((await post(s, '{not json')).status, 400);
    assert.equal((await post(s, { sessionId: 'nope', text: 'x' })).status, 422);
    assert.equal((await post(s, { sessionId: SID.B, text: 'x' })).status, 422); // not in the fleet
    assert.equal((await post(s, { sessionId: SID.A, text: ' ' })).status, 422);
    assert.equal((await post(s, { sessionId: SID.A, text: 'x'.repeat(s.cfg.messageMaxChars + 1) })).status, 422);
    assert.equal((await post(s, { sessionId: SID.A, text: `${ORIGIN_PREFIX} hi` })).status, 422);
    assert.equal((await post(s, { sessionId: SID.A, text: 'x', pad: 'y'.repeat(s.cfg.commandBodyMaxBytes) })).status, 413);
    assert.equal(fs.existsSync(s.cfg.commandsDir), false, 'nothing refused may reach the commands folder');
    const accepted = await post(s, ok);
    assert.equal(accepted.status, 202);
    const { id } = JSON.parse(accepted.text);
    const file = path.join(s.cfg.commandsDir, `${id}.json`);
    const command = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual({ sessionId: command.sessionId, pid: command.pid, text: command.text, origin: command.origin }, { sessionId: SID.A, pid: 100, text: ok.text, origin: 'fleet-ui' });
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    // the result: pending until the hub writes one
    const host = `127.0.0.1:${s.port}`;
    assert.equal(JSON.parse((await raw(s.port, { url: `/${TOKEN}/result/${id}`, headers: { host } })).text).status, 'pending');
    fs.mkdirSync(s.cfg.resultsDir, { recursive: true });
    fs.writeFileSync(path.join(s.cfg.resultsDir, `${id}.json`), JSON.stringify({ id, status: 'queued', reason: null, ts: 1 }));
    assert.equal(JSON.parse((await raw(s.port, { url: `/${TOKEN}/result/${id}`, headers: { host } })).text).status, 'queued');
    assert.equal((await raw(s.port, { url: `/${TOKEN}/result/not-an-id`, headers: { host } })).status, 404);
  } finally { s.close(); }
});

test('POST /send is 503 while no hub is online (hub.json missing or stale)', async () => {
  const s = await boot({ hubOnline: false });
  try {
    const res = await post(s, { sessionId: SID.A, text: 'hello' });
    assert.equal(res.status, 503);
    assert.match(JSON.parse(res.text).reason, /no hub is online/);
    fs.writeFileSync(s.cfg.hubFile, JSON.stringify({ ts: Date.now() - 60_000 }));
    assert.equal((await post(s, { sessionId: SID.A, text: 'hello' })).status, 503);
    const state = JSON.parse((await raw(s.port, { url: `/${TOKEN}/state`, headers: { host: `127.0.0.1:${s.port}` } })).text);
    assert.equal(state.hub.online, false);
  } finally { s.close(); }
});

test('the server binds 127.0.0.1 only', async () => {
  const s = await boot();
  try { assert.equal(s.app.server.address().address, '127.0.0.1'); } finally { s.close(); }
});
