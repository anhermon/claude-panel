// Scene serving against the real server process: positive controls first, then every escape we know of.
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, utimesSync, truncateSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SCENE_EXTENSIONS, MAX_FILE_BYTES, ALLOW_CDN, sceneCsp } from './scene-files.mjs';
import { startServer, firstSseMessage, sleep, TEST_TOKEN, makeKitFixture } from './testkit.mjs';

const MTIME_WAIT_MS = 2600; // one scan interval (1s) + poll (0.3s) + margin
const root = realpathSync(mkdtempSync(join(tmpdir(), 'panel-scene-')));
const procs = [];
const scene = join(root, 'scene');
const outside = join(root, 'outside');
const stateFile = join(root, 'state.json');
const kitDir = join(root, 'kit');
const CHOICES = [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }];
const BYTES = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
const ENTRY_FRAGMENT = '<h1 id="frag">hello</h1><script>window.panel.fit()</script>';
const SECRET = 'TOP-SECRET';
let s;

const scenes = [
  { id: 'demo', title: 'Demo', dir: scene, alt: 'demo scene', span: 2, height: 300, rev: 3, term: { art: ['a'], image: '/etc/hosts' } },
  { id: 'full', dir: join(root, 'full'), alt: 'full doc', rev: 1, entry: 'main.html', layout: 'stage' },
  { id: 'rel', dir: 'relative-scene', alt: 'resolved against the state file dir', rev: 1 },
  { id: 'lonely', dir: join(root, 'does-not-exist'), alt: 'missing dir', rev: 1 },
];

before(async () => {
  for (const d of [scene, outside, join(scene, 'sub', 'deep'), join(scene, '.hidden'), join(root, 'full'), join(root, 'relative-scene')]) mkdirSync(d, { recursive: true });
  writeFileSync(join(scene, 'index.html'), ENTRY_FRAGMENT);
  writeFileSync(join(scene, 'data.json'), '{"ok":true}');
  writeFileSync(join(scene, 'bytes.bin'), BYTES);
  writeFileSync(join(scene, 'sub', 'deep', 'note.txt'), 'deep note');
  writeFileSync(join(scene, 'script.mjs'), 'export default 1');
  writeFileSync(join(scene, 'note.exe'), 'MZ');
  writeFileSync(join(scene, 'noext'), 'x');
  writeFileSync(join(scene, '.env'), SECRET);
  writeFileSync(join(scene, '.hidden', 'a.txt'), SECRET);
  writeFileSync(join(scene, 'empty.txt'), '');
  writeFileSync(join(scene, 'huge.bin'), '');
  truncateSync(join(scene, 'huge.bin'), MAX_FILE_BYTES + 1); // sparse
  writeFileSync(join(outside, 'secret.txt'), SECRET);
  writeFileSync(join(outside, 'secret.html'), SECRET);
  mkdirSync(join(outside, 'dir'));
  writeFileSync(join(outside, 'dir', 'inner.txt'), SECRET);
  symlinkSync(join(outside, 'secret.txt'), join(scene, 'link-out.txt'));
  symlinkSync(outside, join(scene, 'linkdir'));
  symlinkSync('/etc/hosts', join(scene, 'link-hosts.txt'));
  symlinkSync(join(scene, 'data.json'), join(scene, 'link-in.json')); // positive control: stays inside
  symlinkSync(join(scene, '.env'), join(scene, 'link-to-dot.txt'));
  writeFileSync(join(root, 'full', 'main.html'), '<!doctype html><html><head><title>t</title></head><body><p id="x">full</p></body></html>');
  writeFileSync(join(root, 'relative-scene', 'index.html'), '<p>relative</p>');
  makeKitFixture(kitDir);
  writeFileSync(stateFile, JSON.stringify({ v: 4, rev: 1, scenes, choices: CHOICES }));
  s = await startServer(stateFile, { procs, extraArgs: ['--kit', kitDir] });
});
after(() => { for (const p of procs) p.kill(); rmSync(root, { recursive: true, force: true }); });

const get = (path, opts) => s.api(`/s/demo/${path}`, opts);

test('positive controls: entry, files, nested files, in-dir symlinks, relative scene dirs all serve', async () => {
  const entry = await s.api('/s/demo/');
  assert.equal(entry.status, 200);
  assert.match(entry.headers['content-type'], /^text\/html/);
  assert.match(entry.text, /id="frag"/);
  const json = await get('data.json');
  assert.equal(json.status, 200);
  assert.match(json.headers['content-type'], /^application\/json/);
  assert.equal(json.text, '{"ok":true}');
  assert.equal((await get('sub/deep/note.txt')).text, 'deep note');
  assert.equal((await get('link-in.json')).text, '{"ok":true}'); // symlink that stays inside the dir
  assert.match((await get('script.mjs')).headers['content-type'], /^text\/javascript/);
  assert.equal((await get('empty.txt')).body.length, 0);
  assert.equal((await s.api('/s/full/')).status, 200);
  assert.match((await s.api('/s/rel/')).text, /relative/); // dir relative to the state file's directory
  assert.equal((await s.api('/s/demo')).status, 308); // missing trailing slash would break relative URLs
  assert.equal((await s.api('/s/demo')).headers.location, `/${TEST_TOKEN}/s/demo/`);
});

test('every scene response carries the security headers; the CSP names the real origin, never relies on self', async () => {
  for (const r of [await s.api('/s/demo/'), await get('data.json'), await get('missing.json'), await get('note.exe')]) {
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
    assert.equal(r.headers['referrer-policy'], 'no-referrer');
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.equal(r.headers['access-control-allow-origin'], '*');
    assert.equal(r.headers['cross-origin-resource-policy'], 'cross-origin');
    const csp = r.headers['content-security-policy'];
    assert.equal(csp, sceneCsp(s.origin), 'the header is the CSP builder output for the real origin (whichever ALLOW_CDN says)');
    assert.equal(ALLOW_CDN, false, 'CDN allow-list is retired: the kit is local');
    assert.ok(csp.includes(`script-src 'unsafe-inline' blob: ${s.origin};`), csp);
    assert.ok(csp.includes(`img-src ${s.origin} data: blob:`), csp);
    assert.ok(csp.includes(`connect-src ${s.origin} blob: data:`), csp);
    assert.ok(!csp.includes('unsafe-eval'), 'no eval in the shipped CSP');
    assert.doesNotMatch(csp, /https:\/\/(?!127)/, 'no CDN host in the shipped CSP');
    assert.ok(csp.endsWith('sandbox allow-scripts'), csp);
    assert.doesNotMatch(csp, /(^|[ ;])'self'[^;]*(script|img|connect|style|font|media)-src/);
  }
});

test('path traversal: dot segments, encoded dots and slashes, backslashes, NUL, double encoding', async () => {
  const attempts = ['../outside/secret.txt', '%2e%2e/outside/secret.txt', '%2E%2E/outside/secret.txt', '..%2foutside%2fsecret.txt',
    '..%2Foutside/secret.txt', 'sub/../../outside/secret.txt', 'sub/%2e%2e/%2e%2e/outside/secret.txt', '..%5coutside%5csecret.txt',
    'sub%2f..%2f..%2foutside%2fsecret.txt', 'data.json%00.png', '%2e%2e%2f%2e%2e%2foutside%2fsecret.txt', './data.json', 'sub/./deep/note.txt',
    '%252e%252e/outside/secret.txt', '....//outside/secret.txt', '/etc/passwd', '%2fetc%2fpasswd', 'data.json/', 'sub/', 'sub'];
  for (const a of attempts) {
    const r = await get(a);
    assert.equal(r.status, 404, a);
    assert.ok(!r.text.includes(SECRET), a);
  }
  // also against another route shape: traversal through the scene id and out of /s/
  for (const p of ['/s/../state', '/s/%2e%2e/state', '/s/demo/../demo/data.json', '/s/..%2fdemo/data.json']) assert.equal((await s.api(p)).status, 404, p);
});

test('dotfiles and dot directories are never served, not even through a symlink or an encoded dot', async () => {
  for (const p of ['.env', '%2eenv', '.hidden/a.txt', '.hidden', 'sub/.env', 'link-to-dot.txt']) {
    const r = await get(p);
    assert.equal(r.status, 404, p);
    assert.ok(!r.text.includes(SECRET), p);
  }
});

test('symlink escapes: a symlinked file and a symlinked directory pointing outside the scene dir are 404', async () => {
  for (const p of ['link-out.txt', 'link-hosts.txt', 'linkdir/secret.txt', 'linkdir/dir/inner.txt', 'linkdir/secret.html', 'linkdir']) {
    const r = await get(p);
    assert.equal(r.status, 404, p);
    assert.ok(!r.text.includes(SECRET), p);
    assert.ok(!r.text.includes('localhost'), p);
  }
});

test('extension allow-list: disallowed and missing extensions are 404; the allow-list is exactly the spec list', async () => {
  for (const p of ['note.exe', 'noext', 'index.html.bak', 'server.mjs', 'script.mjs.map']) assert.equal((await get(p)).status, 404, p);
  assert.equal(new Set(SCENE_EXTENSIONS).size, SCENE_EXTENSIONS.length);
  assert.deepEqual([...SCENE_EXTENSIONS], ('html htm css js mjs json csv txt png jpg jpeg gif webp avif svg ico mp3 wav ogg oga m4a aac flac ' +
    'mp4 webm glb gltf bin obj stl hdr ktx2 woff2').split(' '));
});

test('not a regular file, no listings, unknown scene, bad scene id, missing dir', async () => {
  for (const p of ['sub', 'sub/', 'sub/deep', 'sub/deep/', 'sub//deep/note.txt', '.']) assert.equal((await get(p)).status, 404, p);
  for (const p of ['/s/nope/', '/s/NOPE/', '/s/demo%2f/', '/s/%64emo/', '/s//', '/s/lonely/', '/s/lonely/index.html', '/s/demo/index.html/x']) {
    assert.equal((await s.api(p)).status, 404, p);
  }
});

test('file size cap: a file over 64 MiB is refused', async () => {
  const r = await get('huge.bin');
  assert.equal(r.status, 413);
  assert.equal(r.body.length < 100, true);
});

test('Range: 206 with the right bytes and Content-Range; open-ended, suffix and out-of-range forms; 416', async () => {
  const full = await get('bytes.bin');
  assert.equal(full.status, 200);
  assert.equal(full.headers['accept-ranges'], 'bytes');
  assert.equal(full.headers['content-length'], '256');
  assert.deepEqual(full.body, BYTES);

  const mid = await get('bytes.bin', { headers: { range: 'bytes=10-19' } });
  assert.equal(mid.status, 206);
  assert.equal(mid.headers['content-range'], 'bytes 10-19/256');
  assert.equal(mid.headers['content-length'], '10');
  assert.deepEqual(mid.body, BYTES.subarray(10, 20));

  const open = await get('bytes.bin', { headers: { range: 'bytes=250-' } });
  assert.equal(open.status, 206);
  assert.equal(open.headers['content-range'], 'bytes 250-255/256');
  assert.deepEqual(open.body, BYTES.subarray(250));

  const suffix = await get('bytes.bin', { headers: { range: 'bytes=-4' } });
  assert.equal(suffix.headers['content-range'], 'bytes 252-255/256');
  assert.deepEqual(suffix.body, BYTES.subarray(252));

  const clipped = await get('bytes.bin', { headers: { range: 'bytes=200-9999' } });
  assert.equal(clipped.headers['content-range'], 'bytes 200-255/256');

  for (const bad of ['bytes=256-', 'bytes=999-1000', 'bytes=-0']) {
    const r = await get('bytes.bin', { headers: { range: bad } });
    assert.equal(r.status, 416, bad);
    assert.equal(r.headers['content-range'], 'bytes */256', bad);
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
  }
  // ignored forms: whole file
  for (const ignored of ['bytes=0-1,5-6', 'items=1-2', 'bytes=9-3', 'garbage']) {
    const r = await get('bytes.bin', { headers: { range: ignored } });
    assert.equal(r.status, 200, ignored);
    assert.equal(r.body.length, 256, ignored);
  }
  assert.equal((await get('empty.txt', { headers: { range: 'bytes=0-1' } })).status, 416);
});

test('HEAD: headers and length, no body, for files, ranges and the wrapped entry', async () => {
  const head = await get('bytes.bin', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.headers['content-length'], '256');
  assert.equal(head.body.length, 0);
  const part = await get('bytes.bin', { method: 'HEAD', headers: { range: 'bytes=0-9' } });
  assert.equal(part.status, 206);
  assert.equal(part.body.length, 0);
  const entry = await s.api('/s/demo/', { method: 'HEAD' });
  assert.equal(entry.status, 200);
  assert.equal(entry.body.length, 0);
  assert.ok(Number(entry.headers['content-length']) > ENTRY_FRAGMENT.length);
  assert.equal((await get('data.json', { method: 'POST' })).status, 405);
});

test('entry wrapping over HTTP: fragments get the base stylesheet + kit head, full documents only the kit head', async () => {
  const kitHead = `<script type="importmap">`;
  const frag = (await s.api('/s/demo/')).text;
  assert.match(frag, /^<!doctype html><html><head><script type="importmap">/i);
  assert.match(frag, /color-scheme: light dark/);
  assert.match(frag, /prefers-color-scheme: dark/);
  assert.match(frag, /window\.panel = \{ fit: fit \}/);
  assert.ok(frag.indexOf('window.panel = ') < frag.indexOf('id="frag"'), 'helper is defined before the fragment runs');
  assert.ok(frag.includes(ENTRY_FRAGMENT));
  assert.ok(frag.includes(`<script src="/${TEST_TOKEN}/kit/panel/panel.js"></script>`));
  // the same file requested by its own name is wrapped too
  assert.match((await get('index.html')).text, /window\.panel = /);

  const full = (await s.api('/s/full/')).text;
  assert.match(full, /^<!doctype html><html><head><script type="importmap">/);
  assert.ok(full.includes('<title>t</title></head><body><p id="x">full</p></body></html>'), 'the author document is intact after the injected head');
  assert.ok(full.includes(kitHead));
  assert.doesNotMatch(full, /color-scheme: light dark/, 'a full document keeps its own styling');
  // non-entry html is served as-is
  writeFileSync(join(scene, 'other.html'), '<p>plain</p>');
  assert.equal((await get('other.html')).text, '<p>plain</p>');
});

test('/state and /events carry only whitelisted scene fields: never dir, entry, term.image or html', async () => {
  const state = JSON.parse((await s.api('/state')).text);
  const raw = (await s.api('/state')).text;
  assert.deepEqual(state.scenes.map((x) => x.id), ['demo', 'full', 'rel', 'lonely']);
  for (const sc of state.scenes) {
    for (const key of Object.keys(sc)) assert.ok(['id', 'title', 'span', 'height', 'pin', 'layout', 'alt', 'term', 'rev', 'mtime'].includes(key), `leaked key ${key}`);
    assert.equal(typeof sc.mtime, 'number');
  }
  assert.deepEqual(state.scenes[0].term, { art: ['a'] });
  assert.equal(state.scenes[0].rev, 3);
  assert.equal(state.scenes[0].span, 2);
  assert.equal(state.scenes[0].layout, undefined, 'no layout in the file, none invented');
  assert.equal(state.scenes[1].layout, 'stage');
  assert.deepEqual(state.choices, CHOICES, 'top-level choices reach the page');
  assert.equal(state.v, 4);
  assert.ok(state.scenes[0].mtime > 0);
  assert.equal(state.scenes[3].mtime, 0, 'a missing dir has mtime 0');
  for (const forbidden of [scene, root, 'relative-scene', 'main.html', '/etc/hosts', 'image', '"dir"', '"entry"', '"html"']) {
    assert.ok(!raw.includes(forbidden), `/state leaks ${forbidden}`);
  }
  const sse = await firstSseMessage(s.port, `/${TEST_TOKEN}/events`);
  for (const forbidden of [scene, root, '/etc/hosts', '"dir"', '"entry"', '"html"', 'image']) assert.ok(!sse.includes(forbidden), `/events leaks ${forbidden}`);
  assert.deepEqual(JSON.parse(sse.slice(6)).scenes, state.scenes);
  assert.deepEqual(JSON.parse(sse.slice(6)).choices, CHOICES);
});

test('live reload: touching a file in the scene dir changes that scene mtime in /state and over SSE; unrelated scenes keep theirs', async () => {
  const before = JSON.parse((await s.api('/state')).text).scenes;
  const seen = []; // every SSE message from here on
  const sse = http.get({ host: '127.0.0.1', port: s.port, path: `/${TEST_TOKEN}/events` }, (res) => {
    let buf = '';
    res.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n\n')) >= 0) { const f = buf.slice(0, i); buf = buf.slice(i + 2); if (f.startsWith('data: ')) seen.push(JSON.parse(f.slice(6))); } });
  });
  await sleep(200);
  const t = new Date(Date.now() + 60_000);
  utimesSync(join(scene, 'sub', 'deep', 'note.txt'), t, t);
  await sleep(MTIME_WAIT_MS);
  const after = JSON.parse((await s.api('/state')).text).scenes;
  const was = (id, list) => list.find((x) => x.id === id).mtime;
  assert.ok(was('demo', after) > was('demo', before), `demo mtime ${was('demo', before)} -> ${was('demo', after)}`);
  assert.ok(Math.abs(was('demo', after) - t.getTime()) <= 2, 'mtime is the touched file time');
  sse.destroy();
  assert.ok(seen.length >= 2 && was('demo', seen[0].scenes) === was('demo', before), 'SSE sent the old mtime on connect');
  assert.equal(was('demo', seen.at(-1).scenes), was('demo', after), 'SSE pushed the new mtime');
  assert.equal(was('full', after), was('full', before));
  // a dotfile change is ignored by the scan
  const dot = new Date(Date.now() + 120_000);
  utimesSync(join(scene, '.env'), dot, dot);
  await sleep(MTIME_WAIT_MS);
  assert.equal(was('demo', JSON.parse((await s.api('/state')).text).scenes), was('demo', after), 'dotfiles are skipped');
  // adding a file bumps the dir mtime and with it the scene mtime
  writeFileSync(join(root, 'full', 'late.txt'), 'new');
  await sleep(MTIME_WAIT_MS);
  assert.ok(was('full', JSON.parse((await s.api('/state')).text).scenes) > was('full', after), 'a new file moves the scene mtime');
  assert.equal((await s.api('/s/full/late.txt')).text, 'new');
});

test('--root: a missing root is skipped (server still starts); if every root is missing nothing is served', async () => {
  const gone = join(root, 'no-such-root');
  const some = await startServer(stateFile, { procs, extraArgs: ['--root', gone, '--root', join(root, 'full')] });
  assert.match(some.stderr(), /--root .*no-such-root.* does not exist/);
  assert.equal((await some.api('/s/full/')).status, 200);
  assert.equal((await some.api('/s/demo/')).status, 404);
  some.kill();
  const none = await startServer(stateFile, { procs, extraArgs: ['--root', gone, '--root', '/nonexistent-panel-root'] });
  assert.equal((await none.api('/state')).status, 200, 'the server itself is up');
  for (const id of ['demo', 'full', 'rel']) {
    assert.equal((await none.api(`/s/${id}/`)).status, 404, id);
  }
  assert.ok(JSON.parse((await none.api('/state')).text).scenes.every((x) => x.mtime === 0), 'nothing is watched either');
  none.kill();
});

test('--root: scene dirs outside every given root are neither served nor watched', async () => {
  const allowedRoot = join(root, 'full');
  const r = await startServer(stateFile, { procs, extraArgs: ['--root', allowedRoot] });
  assert.equal((await r.api('/s/full/')).status, 200);
  assert.equal((await r.api('/s/demo/')).status, 404);
  assert.equal((await r.api('/s/demo/data.json')).status, 404);
  const scenesOut = JSON.parse((await r.api('/state')).text).scenes;
  assert.equal(scenesOut.find((x) => x.id === 'demo').mtime, 0);
  assert.ok(scenesOut.find((x) => x.id === 'full').mtime > 0);
  assert.equal((await r.api('/s/rel/')).status, 404);
  r.kill();
});
