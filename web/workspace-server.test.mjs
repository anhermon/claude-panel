// The server's workspace route (/<token>/workspace/) and what the page may see of a scene (builtin, slot).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HERE, startServer, TEST_TOKEN } from './testkit.mjs';

const dir = mkdtempSync(join(tmpdir(), 'panel-ws-'));
const procs = [];
after(() => { for (const p of procs) p.kill(); rmSync(dir, { recursive: true, force: true }); });

const sceneDir = join(dir, 'deck');
mkdirSync(sceneDir);
writeFileSync(join(sceneDir, 'index.html'), '<p>deck</p>');
const state = {
  v: 4, rev: 1, status: 'working', scenes: [
    { id: 'board', dir: sceneDir, alt: 'b', rev: 1, layout: 'stage', builtin: true, pin: true },
    { id: 'deck', dir: sceneDir, alt: 'd', rev: 1, layout: 'stage', slot: 'big' },
    { id: 'odd', dir: sceneDir, alt: 'o', rev: 1, layout: 'stage', slot: 'huge' },
  ],
};
const file = join(dir, 'state.json');
writeFileSync(file, JSON.stringify(state));
const server = () => startServer(file, { procs });

test('/workspace/ serves the page with a CSP that frames only this origin; the redirect keeps the trailing slash', async () => {
  const s = await server();
  const page = await s.api('/workspace/');
  assert.equal(page.status, 200);
  assert.match(page.headers['content-type'], /text\/html/);
  assert.match(page.text, /<script src="layout.js"><\/script>\s*<script src="workspace.js">/);
  const csp = page.headers['content-security-policy'];
  assert.match(csp, /frame-src 'self'/);
  assert.match(csp, /connect-src 'self'/);
  assert.match(csp, /default-src 'none'/);
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|sandbox/);
  assert.equal(page.headers['cache-control'], 'no-store');
  const redirect = await s.api('/workspace');
  assert.equal(redirect.status, 308);
  assert.equal(redirect.headers.location, `/${TEST_TOKEN}/workspace/`);
});

test('/workspace/<file> serves exactly the three assets; everything else is a 404', async () => {
  const s = await server();
  for (const [name, type] of [['layout.js', /javascript/], ['workspace.js', /javascript/], ['workspace.css', /text\/css/]]) {
    const r = await s.api(`/workspace/${name}`);
    assert.equal(r.status, 200, name);
    assert.match(r.headers['content-type'], type);
    assert.equal(r.text, readFileSync(join(HERE, 'builtin', 'workspace', name), 'utf8'));
  }
  for (const bad of ['/workspace/index.html', '/workspace/nope.js', '/workspace/../ui.js', '/workspace/%2e%2e/ui.js', '/workspace/a/b', '/workspace/layout.test.mjs']) {
    assert.equal((await s.api(bad)).status, 404, bad);
  }
  assert.equal((await s.api('/workspace/', { method: 'POST' })).status, 405);
  assert.equal((await s.get('/workspace/')).status, 404, 'no token, no page');
  assert.equal((await s.api('/workspace/', { host: 'evil.example' })).status, 421);
});

test('the browser page and the workspace page share one layout file', async () => {
  const s = await server();
  assert.match((await s.api('/')).text, /<script src="workspace\/layout.js" defer>/);
  assert.equal((await s.api('/workspace/layout.js')).status, 200);
});

test('/state tells the page which scene is built in and its slot; an unknown slot is dropped', async () => {
  const s = await server();
  const scenes = JSON.parse((await s.api('/state')).text).scenes;
  const by = Object.fromEntries(scenes.map((x) => [x.id, x]));
  assert.equal(by.board.builtin, true);
  assert.equal(by.deck.builtin, undefined);
  assert.equal(by.deck.slot, 'big');
  assert.equal(by.odd.slot, undefined);
  assert.equal(by.board.dir, undefined, 'dir never leaves the server');
});
