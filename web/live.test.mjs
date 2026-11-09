// node --test web/live.test.mjs
// Unit tests for the pure parts of live.mjs, and (skipped without Chrome) real runs against a local page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import { findChrome, isExecutable, pngSize } from './shot.mjs';
import {
  DEFAULTS, FRAME_SLOTS, HASH_PATTERN, KEYS, PROFILE_PREFIX, frameLine, gateFlush, gateOffer, newGate, candidateUrls, readStateUrl, parseArgs, parseControlLine, hostExpression, HOST_DATA_MAX, slotFile, splitLines,
} from './live.mjs';

const LIVE = fileURLToPath(new URL('./live.mjs', import.meta.url));
const TEST_W = 800;
const TEST_H = 450;
const TEST_FPS = 6;
// Timeouts are generous on purpose: they bound a hang, they do not measure speed. This machine is often loaded far beyond its cores
// (load average ~100 on 10 cores with other builds and a live pane running; seen to push a Chrome start past 15 s), and a graceful
// stop alone can take KILL_GRACE_MS (2 s, shot.mjs) before Chrome is killed. A test fails on a wrong result, not on a slow machine.
const EXIT_WITHIN_MS = 12000;
const WAIT_STEP_MS = 50;
const WAIT_MAX_MS = 45000;
const PHASE_WAIT_MS = 20000; // a step that follows a running page: a resize, the final state, Chrome and its profile going away
const TEST_TIMEOUT_MS = 240000; // up to three Chrome runs per test, each allowed WAIT_MAX_MS to start
const CHROME = findChrome({ env: process.env, exists: isExecutable, pathDirs: (process.env.PATH ?? '').split(delimiter).filter(Boolean) });
const NO_CHROME = CHROME ? false : 'no Chrome on this machine';
// Every run here gets its own TMPDIR: its Chrome profile lives under it, so "is anything left" looks at this file's runs
// only (another live view running on the machine, e.g. a person's, is not ours and must not fail these tests).
const SCRATCH = mkdtempSync(join(tmpdir(), 'live-test-root-'));
const MARK = join(SCRATCH, PROFILE_PREFIX);
process.on('exit', () => rmSync(SCRATCH, { recursive: true, force: true }));

// ---------- pure ----------
test('parseArgs: defaults, flags, errors', () => {
  const d = parseArgs(['http://127.0.0.1:1/', '--out-dir', '/o']);
  assert.deepEqual([d.width, d.height, d.fps, d.maxMinutes, d.hash, d.control, d.chrome, d.quitOnStdinClose], [DEFAULTS.width, DEFAULTS.height, DEFAULTS.fps, 60, '', null, null, false]);
  assert.deepEqual([DEFAULTS.width, DEFAULTS.height, DEFAULTS.fps], [960, 540, 8]);
  const o = parseArgs(['http://localhost:2/x', '--out-dir', 'd', '--width', '640', '--height', '360', '--fps', '5', '--chrome', '/c', '--control', 'f', '--hash', '#/2', '--max-minutes', '3', '--quit-on-stdin-close']);
  assert.deepEqual([o.url, o.outDir, o.width, o.height, o.fps, o.chrome, o.control, o.hash, o.maxMinutes, o.quitOnStdinClose], ['http://localhost:2/x', 'd', 640, 360, 5, '/c', 'f', '#/2', 3, true]);
  const bad = [
    [], ['u'], ['--out-dir', 'd'], ['u', '--out-dir'], ['u', '--out-dir', 'd', '--fps', '0'], ['u', '--out-dir', 'd', '--fps', '99'], ['u', '--out-dir', 'd', '--fps', 'x'],
    ['u', '--out-dir', 'd', '--width', '5'], ['u', '--out-dir', 'd', '--nope', '1'], ['a', 'b', '--out-dir', 'd'], ['u', '--out-dir', 'd', '--hash', '3'],
    ['u', '--out-dir', 'd', '--hash', '#/' + 'x'.repeat(41)], ['u', '--out-dir', 'd', '--max-minutes', '0'],
  ];
  for (const argv of bad) assert.ok(parseArgs(argv).error, JSON.stringify(argv));
});

test('parseControlLine host: a message for one scene, with the same name rule and size cap as panel.emit', () => {
  const ok = { cmd: 'host', scene: 'agents-info', name: 'open-agent', data: { id: 't44' } };
  assert.deepEqual(parseControlLine(JSON.stringify(ok)), ok);
  assert.deepEqual(parseControlLine('{"cmd":"host","scene":"agents-info","name":"close"}'), { cmd: 'host', scene: 'agents-info', name: 'close', data: null });
  for (const bad of [
    { cmd: 'host', name: 'close' }, { cmd: 'host', scene: 'Agents Info', name: 'close' }, { cmd: 'host', scene: 'a', name: 'No Way' },
    { cmd: 'host', scene: 'a', name: 'x', data: 'y'.repeat(HOST_DATA_MAX) }, { cmd: 'host', scene: 1, name: 'x' },
  ]) assert.equal(parseControlLine(JSON.stringify(bad)), null, JSON.stringify(bad));
});

test('hostExpression quotes every part (a scene or name cannot break out of the call)', () => {
  const e = hostExpression({ scene: 'a', name: 'tab', data: { name: '");alert(1);("' } });
  assert.equal(e, String.raw`window.PanelWorkspace && window.PanelWorkspace.hostCommand("a", "tab", {"name":"\");alert(1);(\""})`);
  assert.doesNotThrow(() => new Function('window', e)({}));
});

test('parseControlLine: the four commands, an allow-list of keys, and nothing else', () => {
  assert.deepEqual(parseControlLine('{"cmd":"key","key":"ArrowRight"}'), { cmd: 'key', key: 'ArrowRight' });
  assert.deepEqual(parseControlLine('{"cmd":"hash","hash":"#/3"}'), { cmd: 'hash', hash: '#/3' });
  assert.deepEqual(parseControlLine('{"cmd":"reload"}'), { cmd: 'reload' });
  assert.deepEqual(parseControlLine('{"cmd":"quit","extra":1}'), { cmd: 'quit' });
  assert.deepEqual(parseControlLine('{"cmd":"size","w":720,"h":1600}'), { cmd: 'size', w: 720, h: 1600 });
  for (const bad of ['{"cmd":"size"}', '{"cmd":"size","w":720}', '{"cmd":"size","w":"720","h":900}', '{"cmd":"size","w":99,"h":900}', '{"cmd":"size","w":720,"h":4001}',
    '{"cmd":"size","w":720.5,"h":900}', '{"cmd":"size","w":-1,"h":900}', '{"cmd":"size","w":null,"h":900}'])
    assert.equal(parseControlLine(bad), null, bad);
  for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', 'Space', 'o', 'Escape']) {
    assert.deepEqual(parseControlLine(JSON.stringify({ cmd: 'key', key })), { cmd: 'key', key }, key);
  }
  assert.equal(Object.keys(KEYS).length, 11);
  const refused = [
    '', 'not json', '[]', 'null', '7', '{}', '{"cmd":"key"}', '{"cmd":"key","key":"Delete"}', '{"cmd":"key","key":"a"}', '{"cmd":"key","key":"Enter"}',
    '{"cmd":"key","key":"constructor"}', '{"cmd":"key","key":"__proto__"}', '{"cmd":"key","key":" "}', '{"cmd":"key","key":["ArrowLeft"]}',
    '{"cmd":"hash","hash":"3"}', '{"cmd":"hash","hash":"#a b"}', '{"cmd":"hash","hash":"javascript:alert(1)"}', `{"cmd":"hash","hash":"#${'a'.repeat(41)}"}`,
    '{"cmd":"hash"}', '{"cmd":"eval","code":"1"}', '{"cmd":"nav","url":"http://evil.com/"}',
  ];
  for (const line of refused) assert.equal(parseControlLine(line), null, line);
  assert.ok(HASH_PATTERN.test('#') && HASH_PATTERN.test('#/12') && HASH_PATTERN.test('#a.b_c-d/e'));
});

test('splitLines: complete lines out, the unfinished tail carried, blanks dropped', () => {
  assert.deepEqual(splitLines('', 'a\nb\n'), { lines: ['a', 'b'], carry: '' });
  assert.deepEqual(splitLines('', 'a\nb'), { lines: ['a'], carry: 'b' });
  assert.deepEqual(splitLines('b', 'c\n\n  \nd'), { lines: ['bc'], carry: 'd' });
  assert.deepEqual(splitLines('x', ''), { lines: [], carry: 'x' });
});

test('slotFile: three files in rotation, never the same twice in a row', () => {
  const names = Array.from({ length: 9 }, (_, i) => slotFile('/d', i + 1));
  assert.deepEqual(names.slice(0, 4), ['/d/live-0.png', '/d/live-1.png', '/d/live-2.png', '/d/live-0.png']);
  assert.equal(new Set(names).size, FRAME_SLOTS);
  for (let i = 1; i < names.length; i++) assert.notEqual(names[i], names[i - 1]);
  assert.deepEqual(JSON.parse(frameLine(7, '/d/live-0.png', { width: 960, height: 540 })), { t: 'frame', n: 7, file: '/d/live-0.png', w: 960, h: 540 });
});

test('gate: one frame per interval, the newest early frame is held and flushed on the trailing edge', () => {
  const I = 125; // 8 fps
  let g = newGate();
  let r = gateOffer(g, 'f1', 1000, I);
  assert.equal(r.write, 'f1'); g = r.gate;
  r = gateOffer(g, 'f2', 1010, I);
  assert.deepEqual([r.write, r.wait], [null, 115]); g = r.gate;
  r = gateOffer(g, 'f3', 1050, I); // newer replaces f2
  assert.deepEqual([r.write, r.wait], [null, 75]); g = r.gate;
  r = gateFlush(g, 1100, I); // too early: nothing, ask again later
  assert.deepEqual([r.write, r.wait], [null, 25]); g = r.gate;
  r = gateFlush(g, 1125, I);
  assert.deepEqual([r.write, r.wait], ['f3', null]); g = r.gate;
  assert.equal(gateFlush(g, 5000, I).write, null); // nothing held: a quiet page writes nothing
  r = gateOffer(g, 'f4', 1130, I); // 5 ms after the flush: held again
  assert.equal(r.write, null);
  assert.equal(gateOffer(g, 'f5', 1125 + I, I).write, 'f5'); // exactly one interval after the last write: kept
});

test('gate: a burst keeps the rate at or below fps and the final frame always comes out', () => {
  const I = Math.round(1000 / TEST_FPS);
  let g = newGate();
  const written = [];
  const take = (r, now) => { g = r.gate; if (r.write) written.push([now, r.write]); };
  for (let t = 0; t < 1000; t += 16) take(gateOffer(g, `f${t}`, t, I), t); // 60 fps source for one second
  const lastIn = `f${Math.floor(999 / 16) * 16}`;
  for (let t = 1000; written.at(-1)[1] !== lastIn && t < 2000; t += 5) take(gateFlush(g, t, I), t);
  assert.equal(written.at(-1)[1], lastIn);
  for (let i = 1; i < written.length; i++) assert.ok(written[i][0] - written[i - 1][0] >= I, `gap before write ${i}`);
  assert.ok(written.length <= Math.ceil(1000 / I) + 2);
});

// ---------- integration (a real Chrome) ----------
// The page animates a canvas all the time and tells the test server what it saw. /flip is a quiet page: a key press
// fades its background from red to green over 300 ms and then nothing moves again.
const ANIMATED = `<!doctype html><meta charset=utf-8><body style="margin:0;background:#123">
<canvas id=c width=${TEST_W} height=${TEST_H}></canvas><script>
const tell = (q) => fetch('/seen?' + q).catch(() => {});
tell('load');
addEventListener('hashchange', () => tell('hash=' + encodeURIComponent(location.hash)));
addEventListener('keydown', (e) => tell('key=' + encodeURIComponent(e.key)));
const g = document.getElementById('c').getContext('2d');
(function draw(t) { g.fillStyle = '#123'; g.fillRect(0, 0, ${TEST_W}, ${TEST_H}); g.fillStyle = '#fc0'; g.fillRect((t / 4) % ${TEST_W}, 100, 80, 80); requestAnimationFrame(draw); })(0);
</script>`;
const FLIP = `<!doctype html><meta charset=utf-8><body style="margin:0;background:rgb(200,0,0)"><script>
addEventListener('keydown', () => { const t0 = performance.now();
  (function step(t) { const k = Math.min(1, (t - t0) / 300); document.body.style.background = 'rgb(' + Math.round(200 * (1 - k)) + ',' + Math.round(200 * k) + ',0)'; if (k < 1) requestAnimationFrame(step); })(t0); });
</script>`;

async function withPage(fn) {
  const seen = [];
  const server = createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/seen') { seen.push(u.search.slice(1)); res.end('ok'); return; }
    if (u.pathname.startsWith('/missing')) { res.statusCode = 404; res.end('nope'); return; }
    res.setHeader('content-type', 'text/html');
    res.end(u.pathname === '/flip' ? FLIP : ANIMATED);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const dir = mkdtempSync(join(SCRATCH, 'page-'));
  try { return await fn({ base, dir, seen, control: join(dir, 'control.jsonl') }); } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function startLive(args, opts = {}) {
  const child = spawn(process.execPath, [LIVE, ...args], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, TMPDIR: SCRATCH, ...opts.env } });
  const lines = [];
  const stderr = []; // kept for failure messages: a run that never produced a picture should say why
  child.stderr.on('data', (d) => stderr.push(String(d)));
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d;
    const parts = buf.split('\n');
    buf = parts.pop();
    for (const l of parts) lines.push(JSON.parse(l));
  });
  const exited = new Promise((r) => child.on('exit', (code, signal) => r({ code, signal })));
  return { child, lines, exited, stderr };
}

async function until(pred, ms = WAIT_MAX_MS) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (pred()) return true; await new Promise((r) => setTimeout(r, WAIT_STEP_MS)); }
  return pred();
}
const within = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(() => r('late'), ms))]);
const leftovers = () => spawnSync('pgrep', ['-f', MARK], { encoding: 'utf8' }).stdout.trim().split('\n').filter(Boolean);
const profiles = () => readdirSync(SCRATCH).filter((n) => n.startsWith(PROFILE_PREFIX));
const frames = (lines) => lines.filter((l) => l.t === 'frame');
/** What a run printed, for the message of a wait that timed out (a Chrome that never started says so on stderr or as an error line). */
const why = (run) => `lines ${JSON.stringify(run.lines.slice(-3))}, stderr ${run.stderr.join('').slice(-300)}`;

// First pixel of a PNG: the one pixel every filter type leaves raw.
function firstPixel(buf) {
  const idat = [];
  for (let off = 8; off < buf.length;) {
    const len = buf.readUInt32BE(off);
    if (buf.toString('ascii', off + 4, off + 8) === 'IDAT') idat.push(buf.subarray(off + 8, off + 8 + len));
    off += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  return [raw[1], raw[2], raw[3]];
}

// The profile folder is removed after Chrome is gone (a moment later than its last process): wait for that, then check.
async function profilesGone(before) {
  const left = () => profiles().filter((n) => !before.includes(n));
  await until(() => left().length === 0, PHASE_WAIT_MS);
  assert.deepEqual(left(), [], 'a temp profile is left');
}

async function settled(label) {
  assert.ok(await until(() => leftovers().length === 0, PHASE_WAIT_MS), `${label}: a process with ${PROFILE_PREFIX} is still running`);
}

test('live: frames at the asked rate, valid PNGs, control file (hash, key, junk), quit exits 0 and leaves nothing', { skip: NO_CHROME, timeout: TEST_TIMEOUT_MS }, async () => {
  const before = profiles();
  await withPage(async ({ base, dir, seen, control }) => {
    const out = join(dir, 'frames');
    const run = startLive([`${base}/`, '--out-dir', out, '--control', control, '--fps', String(TEST_FPS), '--width', String(TEST_W), '--height', String(TEST_H), '--chrome', CHROME]);
    try {
      assert.ok(await until(() => run.lines.length > 0), `no output: ${why(run)}`);
      assert.deepEqual(run.lines[0], { t: 'ready' }, 'the first line is ready');
      const t0 = Date.now();
      const n0 = frames(run.lines).length;
      await new Promise((r) => setTimeout(r, 3000));
      const seconds = (Date.now() - t0) / 1000;
      const got = frames(run.lines);
      assert.ok(got.length - n0 >= 3, `only ${got.length - n0} frames in 3 s`);
      assert.ok((got.length - n0) / seconds <= TEST_FPS + 1, `${(got.length - n0) / seconds} fps is above ${TEST_FPS}`);
      got.forEach((f, i) => assert.equal(f.n, i + 1));
      const last = got.at(-1);
      assert.deepEqual([last.w, last.h], [TEST_W, TEST_H]);
      for (const f of got.slice(-FRAME_SLOTS)) {
        assert.ok(f.file.startsWith(out) && /live-[0-2]\.png$/.test(f.file));
        assert.deepEqual(pngSize(readFileSync(f.file)), { width: TEST_W, height: TEST_H });
      }
      assert.equal(new Set(got.map((f) => f.file)).size, FRAME_SLOTS);
      assert.equal(existsSync(`${last.file}.tmp`), false, 'no half-written file is left');

      appendFileSync(control, '{"cmd":"hash","hash":"#/3"}\nnot json\n{"cmd":"key","key":"Delete"}\n{"cmd":"key","key":"ArrowRight"}\n{"cmd":"hash","hash":"jav');
      assert.ok(await until(() => seen.includes('hash=%23%2F3') && seen.includes('key=ArrowRight')), `the page saw ${JSON.stringify(seen)}`);
      await new Promise((r) => setTimeout(r, 300));
      assert.ok(!seen.some((s) => s.includes('Delete')), 'a key outside the allow-list reached the page');
      assert.equal(seen.filter((s) => s.startsWith('hash=')).length, 1, 'the unfinished line was not run');

      appendFileSync(control, 'ascript:alert(1)"}\n{"cmd":"quit"}\n');
      const done = await within(run.exited, EXIT_WITHIN_MS);
      assert.deepEqual(done, { code: 0, signal: null });
    } finally {
      run.child.kill('SIGKILL');
    }
  });
  await settled('after quit');
  await profilesGone(before);
});

test('live: `size` changes the viewport in place: new frame size, the page is not reloaded, frames go on, bad sizes are ignored', { skip: NO_CHROME, timeout: TEST_TIMEOUT_MS }, async () => {
  await withPage(async ({ base, dir, seen, control }) => {
    const run = startLive([`${base}/`, '--out-dir', dir, '--control', control, '--fps', String(TEST_FPS), '--width', String(TEST_W), '--height', String(TEST_H), '--chrome', CHROME, '--quit-on-stdin-close']);
    try {
      assert.ok(await until(() => frames(run.lines).length > 0), `no frame: ${why(run)}`);
      const sizeOf = (f) => [f.w, f.h];
      assert.deepEqual(sizeOf(frames(run.lines).at(-1)), [TEST_W, TEST_H]);
      const [portraitW, portraitH] = [TEST_W, TEST_H * 2];
      appendFileSync(control, JSON.stringify({ cmd: 'size', w: portraitW, h: portraitH }) + '\n');
      assert.ok(await until(() => { const f = frames(run.lines).at(-1); return f.w === portraitW && f.h === portraitH; }, PHASE_WAIT_MS), 'no frame at the new size');
      const afterGrow = frames(run.lines).length;
      assert.ok(await until(() => frames(run.lines).length > afterGrow + 1), 'frames did not go on after the resize');
      const f = frames(run.lines).at(-1);
      assert.deepEqual(pngSize(readFileSync(f.file)), { width: portraitW, height: portraitH });
      appendFileSync(control, '{"cmd":"size","w":5,"h":5}\n{"cmd":"size","w":' + TEST_W + ',"h":' + TEST_H + '}\n'); // the first is ignored, the second shrinks back
      assert.ok(await until(() => { const g = frames(run.lines).at(-1); return g.w === TEST_W && g.h === TEST_H; }, PHASE_WAIT_MS), 'no frame at the original size again');
      assert.equal(seen.filter((s) => s === 'load').length, 1, 'the page was reloaded by a resize');
      run.child.stdin.end();
      assert.deepEqual(await within(run.exited, EXIT_WITHIN_MS), { code: 0, signal: null });
    } finally {
      run.child.kill('SIGKILL');
    }
  });
  await settled('after size');
});

test('live: a quiet page that changes once shows its final state (the last frame is not lost)', { skip: NO_CHROME, timeout: TEST_TIMEOUT_MS }, async () => {
  await withPage(async ({ base, dir, control }) => {
    const run = startLive([`${base}/flip`, '--out-dir', dir, '--control', control, '--fps', '2', '--width', String(TEST_W), '--height', String(TEST_H), '--chrome', CHROME, '--quit-on-stdin-close']);
    try {
      assert.ok(await until(() => frames(run.lines).length > 0), `no frame: ${why(run)}`);
      const red = firstPixel(readFileSync(frames(run.lines).at(-1).file));
      assert.ok(red[0] > 150 && red[1] < 50, `first picture is not red: ${red}`);
      appendFileSync(control, '{"cmd":"key","key":"Space"}\n');
      const isGreen = () => { const f = frames(run.lines).at(-1); const p = firstPixel(readFileSync(f.file)); return p[1] > 150 && p[0] < 50; };
      assert.ok(await until(isGreen, PHASE_WAIT_MS), 'the live picture never reached the final (green) state');
      run.child.stdin.end(); // --quit-on-stdin-close
      assert.deepEqual(await within(run.exited, EXIT_WITHIN_MS), { code: 0, signal: null });
    } finally {
      run.child.kill('SIGKILL');
    }
  });
  await settled('after stdin close');
});

test('live: SIGTERM exits 0; Chrome dying ends it; a killed parent does not leave Chrome behind', { skip: NO_CHROME, timeout: TEST_TIMEOUT_MS }, async () => {
  const before = profiles();
  await withPage(async ({ base, dir }) => {
    const args = [`${base}/`, '--out-dir', dir, '--width', String(TEST_W), '--height', String(TEST_H), '--chrome', CHROME];
    let run = startLive(args);
    assert.ok(await until(() => frames(run.lines).length > 0), `no frame: ${why(run)}`);
    run.child.kill('SIGTERM');
    assert.deepEqual(await within(run.exited, EXIT_WITHIN_MS), { code: 0, signal: null });
    await settled('after SIGTERM');

    run = startLive(args);
    assert.ok(await until(() => frames(run.lines).length > 0), `no frame: ${why(run)}`);
    const [browser] = leftovers().map(Number);
    spawnSync('kill', ['-9', String(browser)]);
    assert.deepEqual(await within(run.exited, EXIT_WITHIN_MS), { code: 0, signal: null }, 'Chrome died: live.mjs should end');
    await settled('after Chrome died');

    run = startLive(args);
    assert.ok(await until(() => frames(run.lines).length > 0), `no frame: ${why(run)}`);
    assert.ok(leftovers().length > 0);
    run.child.kill('SIGKILL'); // no handler runs: the watchdog has to do the cleaning
    await run.exited;
    assert.ok(await until(() => leftovers().length === 0, PHASE_WAIT_MS), 'Chrome outlived a SIGKILLed live.mjs');
  });
  await profilesGone(before);
});

test('candidateUrls: the url, then the same page on the server\'s current address, then the fallback page there', () => {
  const [old, now] = ['http://127.0.0.1:1/t/', 'http://127.0.0.1:2/t'];
  const url = `${old}workspace/?hero=board`;
  const table = [
    [{ url }, [url]], // no recovery flags: just the url
    [{ url, base: old, stateUrl: old, fallback: 's/board/' }, [url, `${old}s/board/`]], // same address: only the fallback is new
    [{ url, base: old, stateUrl: now, fallback: 's/board/' }, [url, 'http://127.0.0.1:2/t/workspace/?hero=board', 'http://127.0.0.1:2/t/s/board/']],
    [{ url, base: old, stateUrl: null, fallback: 's/board/' }, [url, `${old}s/board/`]], // state file unreadable
    [{ url, base: old, stateUrl: 'https://evil.example/', fallback: 's/board/' }, [url, `${old}s/board/`]], // a non-local address is never followed
  ];
  for (const [input, want] of table) assert.deepEqual(candidateUrls(input), want);
});

test('readStateUrl: the url of the state file; null for missing, broken or url-less files', () => {
  const file = join(SCRATCH, 'state.json');
  assert.equal(readStateUrl(null), null);
  assert.equal(readStateUrl(join(SCRATCH, 'nope.json')), null);
  writeFileSync(file, '{not json');
  assert.equal(readStateUrl(file), null);
  writeFileSync(file, '{"url":null}');
  assert.equal(readStateUrl(file), null);
  writeFileSync(file, '{"url":"http://127.0.0.1:9/t/"}');
  assert.equal(readStateUrl(file), 'http://127.0.0.1:9/t/');
});

// A server that restarted on another port (mod reload) and a workspace page that is missing both end in a picture, not a blank.
for (const [name, pick] of [
  ['the port changed: it re-reads the state file and opens the page on the new address', ({ base }) => ({ url: 'http://127.0.0.1:1/t/', state: base })],
  ['the workspace page is a 404: it falls back to the hero scene alone', ({ base }) => ({ url: `${base}/missing/`, state: base })],
]) {
  test(`live: ${name}`, { skip: NO_CHROME, timeout: TEST_TIMEOUT_MS }, async () => {
    await withPage(async (page) => {
      const { base, dir, seen, control } = page;
      const { url, state } = pick(page);
      const stateFile = join(dir, 'state.json');
      writeFileSync(stateFile, JSON.stringify({ url: `${state}/` }));
      const run = startLive([url, '--out-dir', dir, '--control', control, '--fps', String(TEST_FPS), '--width', String(TEST_W), '--height', String(TEST_H), '--chrome', CHROME,
        '--state', stateFile, '--base', url.startsWith(base) ? `${base}/` : 'http://127.0.0.1:1/t/', '--fallback', 'fallback/', '--quit-on-stdin-close']);
      try {
        assert.ok(await until(() => frames(run.lines).length > 0 && seen.includes('load')), `no picture of a working page: lines ${JSON.stringify(run.lines.slice(-3))}, page saw ${JSON.stringify(seen)}, stderr ${run.stderr.join('').slice(-300)}`);
        run.child.stdin.end();
        assert.deepEqual(await within(run.exited, EXIT_WITHIN_MS), { code: 0, signal: null });
      } finally {
        run.child.kill('SIGKILL');
      }
    });
    await settled(`after ${name}`);
  });
}

test('live: refuses a non-local url and bad arguments with one error line and exit 1, no Chrome started', async () => {
  const before = leftovers();
  for (const args of [['http://example.com:80/', '--out-dir', '/tmp/x'], ['file:///etc/passwd', '--out-dir', '/tmp/x'], ['http://127.0.0.1:1/'], ['http://127.0.0.1:1/', '--out-dir', '/tmp/x', '--fps', '0']]) {
    const run = startLive(args);
    assert.deepEqual(await within(run.exited, EXIT_WITHIN_MS), { code: 1, signal: null }, args.join(' '));
    assert.equal(run.lines.length, 1);
    assert.equal(run.lines[0].t, 'error');
    assert.equal(typeof run.lines[0].error, 'string');
  }
  assert.deepEqual(leftovers(), before);
});
