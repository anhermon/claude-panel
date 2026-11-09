import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HERE, SERVER, TEST_TOKEN, startServer as start, rawRequest, socketStatus, sleep } from './testkit.mjs';

const SSE_DEADLINE_MS = 1000;
const SETTLE_MS = 800; // > 2 poll intervals

const dir = mkdtempSync(join(tmpdir(), 'panel-test-'));
const procs = [];
after(() => { for (const p of procs) p.kill(); rmSync(dir, { recursive: true, force: true }); });

const write = (file, v) => writeFileSync(file, typeof v === 'string' ? v : JSON.stringify(v));
const startS = (file, opts = {}) => start(file, { procs, ...opts });
const getState = async (s) => JSON.parse((await s.api('/state')).text);

// Resolves with the first SSE message whose parsed data satisfies `want`, or rejects after the deadline.
async function sseUntil(s, want, ms) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  const seen = [];
  try {
    const res = await fetch(s.base + '/events', { signal: ac.signal });
    assert.match(res.headers.get('content-type'), /text\/event-stream/);
    let buf = '';
    for await (const chunk of res.body) {
      buf += Buffer.from(chunk).toString();
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, i); buf = buf.slice(i + 2);
        if (!frame.startsWith('data: ')) continue;
        const obj = JSON.parse(frame.slice(6)); seen.push(obj);
        if (want(obj)) return obj;
      }
    }
  } catch (e) {
    if (e.name !== 'AbortError') throw e;
  } finally { clearTimeout(timer); ac.abort(); }
  throw new Error('SSE deadline passed; saw ' + JSON.stringify(seen));
}

test('prints exactly one PORT line; /state matches the file; the UI is served under the token', async () => {
  const file = join(dir, 'a.json');
  const state = { v: 1, rev: 1, status: 'working', task: { title: 'T', why: 'W' }, done: ['x'] };
  write(file, state);
  const s = await startS(file);
  assert.match(s.stdout(), /^PORT \d+\n$/);
  assert.deepEqual(await getState(s), state);
  const ui = await s.api('/');
  assert.equal(ui.status, 200);
  assert.match(ui.text, /<title>Panel/);
  assert.equal(ui.headers['cache-control'], 'no-store');
  assert.equal(ui.headers['x-content-type-options'], 'nosniff');
  assert.equal((await s.api('/nope')).status, 404);
  assert.equal((await s.api('/state', { method: 'POST' })).status, 405);
  assert.equal((await s.api('/state', { method: 'POST' })).headers.allow, 'GET, HEAD');
  s.kill();
});

test('token: required on every route (wrong, missing, prefix, encoded -> 404); /<token> redirects to /<token>/', async () => {
  const s = await startS(join(dir, 'tok.json'));
  for (const p of ['/', '/state', '/events', '/ui.js', '/s/x/', '/wrong/state', '/wrong/', `/${TEST_TOKEN}x/state`,
    `/${TEST_TOKEN.slice(0, -1)}/state`, '/%74esttoken0123456789/state', `//${TEST_TOKEN}/state`, '/state/' + TEST_TOKEN]) {
    assert.equal((await s.get(p)).status, 404, p);
  }
  const redirect = await s.get(`/${TEST_TOKEN}`);
  assert.equal(redirect.status, 308);
  assert.equal(redirect.headers.location, `/${TEST_TOKEN}/`);
  assert.equal((await s.get(`/${TEST_TOKEN}/state`)).status, 200);
  s.kill();
});

test('a minted token is used when --token is omitted, and it is reported on stderr only', async () => {
  const s = await startS(join(dir, 'minted.json'), { token: null });
  assert.match(s.stdout(), /^PORT \d+\n$/);
  const m = new RegExp(`${s.origin}/([0-9a-f]{32})/`).exec(s.stderr());
  assert.ok(m, 'stderr names the url: ' + s.stderr());
  assert.equal((await s.get(`/${m[1]}/state`)).status, 200);
  assert.equal((await s.get('/state')).status, 404);
  s.kill();
});

test('Host header: only 127.0.0.1:<port> and localhost:<port> are accepted, anything else is 421', async () => {
  const s = await startS(join(dir, 'host.json'));
  for (const host of [`127.0.0.1:${s.port}`, `localhost:${s.port}`, `LOCALHOST:${s.port}`]) {
    assert.equal((await s.api('/state', { host })).status, 200, host);
  }
  for (const host of ['evil.example', `evil.example:${s.port}`, `127.0.0.1:${s.port + 1}`, '127.0.0.1', 'localhost', `127.0.0.1.evil.example:${s.port}`]) {
    const r = await s.api('/state', { host });
    assert.equal(r.status, 421, JSON.stringify(host));
    assert.doesNotMatch(r.text, /\{/);
  }
  assert.equal((await s.get('/anything', { host: 'evil.example' })).status, 421); // 421 wins over 404
  // an empty Host, and no Host at all (HTTP/1.0), cannot be built with the http client: write them by hand
  assert.equal(await socketStatus(s.port, `GET /${TEST_TOKEN}/state HTTP/1.1\r\nHost:\r\n\r\n`), 421);
  assert.equal(await socketStatus(s.port, `GET /${TEST_TOKEN}/state HTTP/1.0\r\n\r\n`), 421);
  s.kill();
});

test('ACAO only on scene files: the UI, its assets, /state and /events never send it', async () => {
  const s = await startS(join(dir, 'cors.json'));
  for (const p of ['/', '/ui.js', '/ui.css', '/blocks.js', '/scenes.js', '/state']) {
    const r = await s.api(p);
    assert.equal(r.headers['access-control-allow-origin'], undefined, p);
    assert.equal(r.headers['x-content-type-options'], 'nosniff', p);
    assert.equal(r.headers['referrer-policy'], 'no-referrer', p);
  }
  const events = await new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port: s.port, path: `/${TEST_TOKEN}/events` }, (res) => { resolve(res.headers); res.destroy(); });
  });
  assert.equal(events['access-control-allow-origin'], undefined);
  s.kill();
});

test('SSE sends state on connect and pushes an update within 1s of a rewrite', async () => {
  const file = join(dir, 'b.json');
  write(file, { rev: 1 });
  const s = await startS(file);
  const first = await sseUntil(s, () => true, SSE_DEADLINE_MS);
  assert.equal(first.rev, 1);
  const pending = sseUntil(s, (o) => o.rev === 2, SSE_DEADLINE_MS + SETTLE_MS);
  await sleep(100); // let the stream attach
  const t0 = Date.now();
  write(file, { rev: 2 });
  await pending;
  assert.ok(Date.now() - t0 <= SSE_DEADLINE_MS, `update took ${Date.now() - t0}ms`);
  s.kill();
});

test('missing file: serves empty state, then picks the file up once it appears', async () => {
  const file = join(dir, 'missing.json');
  const s = await startS(file);
  assert.deepEqual(await getState(s), {});
  write(file, { rev: 5 });
  const got = await sseUntil(s, (o) => o.rev === 5, SSE_DEADLINE_MS + SETTLE_MS);
  assert.equal(got.rev, 5);
  s.kill();
});

test('partial/invalid file keeps last good state, recovers when fixed', async () => {
  const file = join(dir, 'c.json');
  write(file, { rev: 1, task: { title: 'good' } });
  const s = await startS(file);
  write(file, '{"rev": 2, "task": {"title": "tru');
  await sleep(SETTLE_MS);
  assert.equal((await getState(s)).rev, 1);
  write(file, '[1,2,3]'); // valid JSON but not an object
  await sleep(SETTLE_MS);
  assert.equal((await getState(s)).rev, 1);
  write(file, { rev: 3 });
  await sleep(SETTLE_MS);
  assert.equal((await getState(s)).rev, 3);
  s.kill();
});

test('static allow-list: the UI files are served with their types, everything else 404s', async () => {
  const s = await startS(join(dir, 'static.json'));
  const want = { '/': /text\/html/, '/ui.css': /text\/css/, '/ui.js': /text\/javascript/, '/blocks.js': /text\/javascript/, '/scenes.js': /text\/javascript/ };
  for (const [p, type] of Object.entries(want)) {
    const r = await s.api(p);
    assert.equal(r.status, 200, p);
    assert.match(r.headers['content-type'], type, p);
    assert.equal(r.headers['cache-control'], 'no-store', p);
    assert.ok(r.body.length > 100, p);
  }
  const html = (await s.api('/')).text;
  for (const ref of ['ui.css', 'blocks.js', 'scenes.js', 'ui.js']) assert.match(html, new RegExp(`(href|src)="${ref}"`), 'ui.html references ' + ref + ' relatively');
  assert.doesNotMatch(html, /(href|src)="\//, 'no absolute asset URLs: the page lives under /<token>/');
  assert.match(readFileSync(join(HERE, 'ui.js'), 'utf8'), /EVENTS_PATH = "events"/);
  // every flat .js/.css that ui.html references is served (new UI modules need no server change) ...
  const referenced = [...html.matchAll(/(?:src|href)="([a-z0-9][a-z0-9._-]*\.(?:js|css))"/g)].map((m) => m[1]);
  assert.ok(referenced.length >= 4, 'ui.html references its scripts: ' + referenced);
  for (const name of referenced) {
    const r = await s.api('/' + name);
    assert.equal(r.status, 200, name);
    assert.match(r.headers['content-type'], name.endsWith('.css') ? /text\/css/ : /text\/javascript/, name);
    assert.equal(r.headers['cache-control'], 'no-store', name);
    assert.equal(r.headers['access-control-allow-origin'], undefined, name);
  }
  // ... and only those: a name ui.html does not reference, or an unsafe one, is a 404 even if the file exists
  for (const p of ['/shot.js', '/unreferenced.js', '/unreferenced.css', '/shot.mjs', '/fake-dom.mjs', '/..%2fpackage.js', '/a%2fb.js', '/.hidden.js', '/ui.js.map', '/ui.css%00.js']) {
    assert.equal((await s.api(p)).status, 404, p);
  }
  for (const p of ['/server.mjs', '/server.test.mjs', '/sample-state.json', '/ui.html', '/../server.mjs', '/%2e%2e/server.mjs',
    '/..%2fserver.mjs', '/ui.js/..%2f..%2fserver.mjs', '//etc/passwd', '/ui.js%00', '/UI.JS', '/ui.js/', '/scene-files.mjs', '/testkit.mjs',
    '/s', '/s/', '/package.json']) {
    assert.equal((await s.api(p)).status, 404, p);
  }
  s.kill();
});

test('HEAD works on the UI and /state; other methods are 405', async () => {
  const s = await startS(join(dir, 'head.json'));
  const head = await s.api('/state', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.body.length, 0);
  assert.equal((await s.api('/ui.js', { method: 'HEAD' })).status, 200);
  for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH']) assert.equal((await s.api('/state', { method })).status, 405, method);
  s.kill();
});

test('CLI: --port is tried first, then it falls forward; bad arguments exit 2 with usage', async () => {
  const first = await startS(join(dir, 'p1.json'));
  const busy = spawn(process.execPath, [SERVER, join(dir, 'p2.json'), '--token', TEST_TOKEN, '--port', String(first.port)]);
  procs.push(busy);
  let out = '';
  const port = await new Promise((resolve, reject) => {
    busy.on('exit', (c) => reject(new Error('exited ' + c)));
    busy.stdout.on('data', (d) => { out += d; const m = /^PORT (\d+)$/m.exec(out); if (m) resolve(Number(m[1])); });
  });
  assert.notEqual(port, first.port);
  assert.equal((await rawRequest(port, `/${TEST_TOKEN}/state`)).status, 200);
  busy.kill();
  first.kill();

  for (const bad of [[], ['x.json', '--port'], ['x.json', '--port', 'abc'], ['x.json', '--token', 'a/b'], ['x.json', '--bogus'], ['x.json', 'y.json']]) {
    const p = spawn(process.execPath, [SERVER, ...bad]);
    const code = await new Promise((resolve) => p.on('exit', resolve));
    assert.equal(code, 2, JSON.stringify(bad));
  }
});

test('CLI: a port that is only busy for a moment (the old server of a mod reload) is waited for, so the link keeps its port', async () => {
  const old = await startS(join(dir, 'r1.json'));
  const next = spawn(process.execPath, [SERVER, join(dir, 'r2.json'), '--token', TEST_TOKEN, '--port', String(old.port)]);
  procs.push(next);
  let out = '';
  const bound = new Promise((resolve, reject) => {
    next.on('exit', (c) => reject(new Error('exited ' + c)));
    next.stdout.on('data', (d) => { out += d; const m = /^PORT (\d+)$/m.exec(out); if (m) resolve(Number(m[1])); });
  });
  await sleep(600); // the new server is already retrying: the old one is still listening
  old.kill();
  assert.equal(await bound, old.port);
  assert.equal((await rawRequest(old.port, `/${TEST_TOKEN}/state`)).status, 200);
  next.kill();
});

// A server of the same session (same state file and token) that still holds the port is asked to hand it over; any other is not.
const portOf = (child) => {
  let out = '';
  return new Promise((resolve, reject) => {
    child.on('exit', (c) => reject(new Error('exited ' + c)));
    child.stdout.on('data', (d) => { out += d; const m = /^PORT (\d+)$/m.exec(out); if (m) resolve(Number(m[1])); });
  });
};
const serverAt = (file, port) => {
  const child = spawn(process.execPath, [SERVER, file, '--token', TEST_TOKEN, '--port', String(port)]);
  procs.push(child);
  return child;
};

test('CLI: the older server of the same session hands its port over, so a reload keeps the link', async () => {
  const file = join(dir, 'h1.json');
  const old = await startS(file);
  const oldExit = new Promise((r) => procs[procs.length - 1].on('exit', r));
  const next = serverAt(file, old.port);
  assert.equal(await portOf(next), old.port);
  await oldExit;
  assert.equal((await rawRequest(old.port, `/${TEST_TOKEN}/state`)).status, 200); // answered by the new one
  next.kill();
});

test('CLI: a server of ANOTHER session (other state file) is never asked to quit nor displaced', async () => {
  const other = await startS(join(dir, 'h2.json'));
  const next = serverAt(join(dir, 'h3.json'), other.port);
  const port = await portOf(next);
  assert.notEqual(port, other.port); // it fell forward
  assert.equal((await rawRequest(other.port, `/${TEST_TOKEN}/state`)).status, 200); // the other one is still up
  const res = await rawRequest(other.port, `/${TEST_TOKEN}/handover`, { method: 'POST', headers: { 'x-panel-handover': 'wrong' } });
  assert.equal(res.status, 405); // wrong proof: just a POST nobody serves
  next.kill();
});
