// node --test web/shot.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROFILE_PREFIX, TEXT_MAX, buildResult, clip, findChrome, isAllowedRequest, isLocalUrl, parseArgs, pngSize, safeUrl } from './shot.mjs';

const SHOT = fileURLToPath(new URL('./shot.mjs', import.meta.url));
const TEST_W = 800;
const TEST_H = 450;
const TEST_WAIT_MS = 600;
const TEST_TIMEOUT_MS = 20000;
const CHROME_MAC = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

test('parseArgs: defaults, flags, errors', () => {
  const d = parseArgs(['http://127.0.0.1:1/']);
  assert.deepEqual([d.width, d.height, d.wait, d.timeout, d.out, d.chrome], [1280, 720, 1500, 30000, null, null]);
  const o = parseArgs(['http://localhost:2/x', '--out', 'a.png', '--width', '640', '--height', '480', '--wait', '10', '--chrome', '/c', '--timeout', '999']);
  assert.deepEqual([o.url, o.out, o.width, o.height, o.wait, o.chrome, o.timeout], ['http://localhost:2/x', 'a.png', 640, 480, 10, '/c', 999]);
  for (const bad of [[], ['u', '--width'], ['u', '--width', 'abc'], ['u', '--nope', '1'], ['a', 'b'], ['u', '--width', '5'], ['u', '--height', '99999']]) {
    assert.ok(parseArgs(bad).error, JSON.stringify(bad));
  }
});

test('isLocalUrl: allows only http local with port', () => {
  for (const ok of ['http://127.0.0.1:8080/', 'http://localhost:3000/s/a?x=1', 'http://127.0.0.1:1/tok/s/deck/index.html#/2']) assert.ok(isLocalUrl(ok), ok);
  for (const bad of [
    'http://127.0.0.1.evil.com:80/', 'http://127.0.0.1@evil.com/', 'http://127.0.0.1:80@evil.com/', 'http://evil.com:80/?h=127.0.0.1',
    'http://localhost.evil.com:80/', 'http://127.0.0.1/', 'https://127.0.0.1:443/', 'file:///etc/passwd', 'javascript:alert(1)',
    'data:text/html,hi', 'ftp://127.0.0.1:21/', 'http://user:pw@127.0.0.1:80/', 'http://0.0.0.0:80/', 'http://[::1]:80/', '', 'not a url', null, undefined,
  ]) assert.ok(!isLocalUrl(bad), String(bad));
});

test('isAllowedRequest: local http plus inline schemes only', () => {
  for (const ok of ['http://127.0.0.1:5/a.js', 'data:image/png;base64,AA', 'blob:http://127.0.0.1:5/x', 'about:blank']) assert.ok(isAllowedRequest(ok), ok);
  for (const bad of ['https://cdn.example.com/x.js', 'http://evil.com/', 'file:///x', 'http://127.0.0.1.evil.com:80/']) assert.ok(!isAllowedRequest(bad), bad);
});

test('findChrome: discovery order with injected exists()', () => {
  const have = (...paths) => (p) => paths.includes(p);
  const pathDirs = ['/usr/bin', '/opt/bin'];
  const env = { CHROME: '/env/chrome' };
  assert.equal(findChrome({ chrome: '/flag/chrome', env, exists: have('/flag/chrome', '/env/chrome', CHROME_MAC), pathDirs }), '/flag/chrome');
  assert.equal(findChrome({ chrome: '/flag/chrome', env, exists: have('/env/chrome', CHROME_MAC), pathDirs }), '/env/chrome');
  assert.equal(findChrome({ env, exists: have(CHROME_MAC, '/usr/bin/chromium'), pathDirs }), CHROME_MAC);
  const chromium = '/Applications/Chromium.app/Contents/MacOS/Chromium';
  assert.equal(findChrome({ env: {}, exists: have(chromium, '/usr/bin/chromium'), pathDirs }), chromium);
  assert.equal(findChrome({ env: {}, exists: have('/opt/bin/chrome', '/usr/bin/chromium'), pathDirs }), '/usr/bin/chromium');
  assert.equal(findChrome({ env: {}, exists: have('/usr/bin/google-chrome', '/usr/bin/chromium'), pathDirs }), '/usr/bin/google-chrome');
  assert.equal(findChrome({ env: {}, exists: have('/opt/bin/chrome'), pathDirs }), '/opt/bin/chrome');
  assert.equal(findChrome({ env: {}, exists: () => false, pathDirs }), null);
});

test('clip / safeUrl', () => {
  assert.equal(clip('abc'), 'abc');
  const long = clip('x'.repeat(500));
  assert.equal(long.length, TEXT_MAX);
  assert.ok(long.endsWith('…'));
  assert.equal(clip(undefined), '');
  assert.equal(safeUrl('http://127.0.0.1:9/a/b.js?token=secret#h'), '127.0.0.1:9/a/b.js');
});

test('buildResult / pngSize: JSON line shape', () => {
  const ok = buildResult(true, { png: '/x.png', width: 1, height: 2, bytes: 3 }, { console: [{ level: 'error', text: 't' }], errors: ['e'] }, 7);
  assert.deepEqual(Object.keys(ok), ['ok', 'png', 'width', 'height', 'bytes', 'console', 'errors', 'ms']);
  const bad = buildResult(false, { error: 'e'.repeat(999) }, { loadTimedOut: true }, 5);
  assert.equal(bad.ok, false);
  assert.equal(bad.error.length, TEXT_MAX);
  assert.deepEqual([bad.console, bad.errors, bad.loadTimedOut], [[], [], true]);
  assert.equal(pngSize(Buffer.from('nope')), null);
});

test('CLI: bad inputs print exactly one JSON line and exit 0', () => {
  const run = (...a) => spawnSync(process.execPath, [SHOT, ...a], { encoding: 'utf8' });
  for (const [args, err] of [[['file:///etc/passwd'], 'only local urls'], [['http://127.0.0.1.evil.com:80/'], 'only local urls'], [[], 'usage']]) {
    const r = run(...args);
    assert.equal(r.status, 0);
    const lines = r.stdout.trim().split('\n');
    assert.equal(lines.length, 1);
    const j = JSON.parse(lines[0]);
    assert.equal(j.ok, false);
    assert.ok(j.error.startsWith(err), j.error);
  }
});

// ---- integration (skipped without chrome) ----
const chromePath = findChrome({ env: process.env, exists: (p) => { try { return existsSync(p); } catch { return false; } }, pathDirs: (process.env.PATH ?? '').split(delimiter) });
const PAGE = `<!doctype html><meta charset=utf-8><body style="margin:0;background:#123">
<canvas id=c width=200 height=100></canvas>
<iframe sandbox srcdoc="<p>sandboxed</p>" width=100 height=50></iframe>
<script>
const g=document.getElementById('c').getContext('2d'); g.fillStyle='#e33'; g.fillRect(10,10,150,60);
console.error('boom');
setTimeout(()=>{ throw new Error('uncaught-after-load'); }, 50);
</script>`;

const runShot = (args, env) => new Promise((resolve) => {
  let out = '';
  const c = spawn(process.execPath, [SHOT, ...args], { env, stdio: ['ignore', 'pipe', 'inherit'] });
  c.stdout.on('data', (d) => { out += d; });
  c.on('close', (code) => resolve({ code, out }));
});

test('integration: real chrome shot of a local page', { skip: chromePath ? false : 'chrome not found', timeout: TEST_TIMEOUT_MS * 2 }, async () => {
  const server = createServer((req, res) => { res.setHeader('content-type', 'text/html'); res.end(PAGE); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const tmp = mkdtempSync(join(tmpdir(), 'shot-test-')); // child TMPDIR: unique, so pgrep/readdir see only our profile
  const png = join(tmp, 'out.png');
  try {
    const { code, out } = await runShot(
      [`http://127.0.0.1:${server.address().port}/`, '--out', png, '--width', String(TEST_W), '--height', String(TEST_H), '--wait', String(TEST_WAIT_MS), '--timeout', String(TEST_TIMEOUT_MS)],
      { ...process.env, TMPDIR: tmp });
    assert.equal(code, 0);
    assert.equal(out.trim().split('\n').length, 1);
    const j = JSON.parse(out);
    assert.equal(j.ok, true, out);
    assert.equal(j.png, png);
    const buf = readFileSync(png);
    assert.equal(j.bytes, buf.length);
    assert.deepEqual(pngSize(buf), { width: TEST_W, height: TEST_H });
    assert.deepEqual([j.width, j.height], [TEST_W, TEST_H]);
    assert.ok(j.console.some((c) => c.level === 'error' && c.text.includes('boom')), out);
    assert.ok(j.errors.some((e) => e.includes('uncaught-after-load')), out);
    assert.ok(!j.loadTimedOut);
    assert.deepEqual(readdirSync(tmp).filter((n) => n.startsWith(PROFILE_PREFIX)), [], 'temp profile removed');
    const left = spawnSync('pgrep', ['-f', tmp], { encoding: 'utf8' });
    assert.equal(left.stdout.trim(), '', 'no chrome left running');
  } finally { server.close(); rmSync(tmp, { recursive: true, force: true }); }
});
