#!/usr/bin/env node
// Live preview helper for the panel's CLI pane (T22). Zero dependencies, Node 22. Opens a LOCAL url in a headless
// Chrome, screencasts it and writes each kept frame as a PNG into a rotating set of 3 files, printing one JSON line
// per frame on stdout; the mod hands those files to the terminal. A control file is polled for commands.
//   node live.mjs <url> --out-dir DIR [--width 960] [--height 540] [--fps 8] [--chrome PATH] [--control FILE] [--state FILE --base URL --fallback PATH]
//                       [--hash '#/0'] [--max-minutes 60] [--quit-on-stdin-close]
// stdout (one JSON object per line): {"t":"ready"} after the first frame, then {"t":"frame","n","file","w","h"} per kept
// frame, {"t":"error","error"} on a failure. Exits 0 on SIGTERM / SIGINT / `quit` / Chrome dying / --max-minutes, 1 after
// a startup error. The control file takes lines {"cmd":"key","key":"ArrowRight"} | {"cmd":"hash","hash":"#/3"} |
// {"cmd":"host","scene":"agents-info","name":"open-agent","data":{"id":"x"}} (a message to that scene's iframe, delivered by the workspace page: the scene's panel.on(name)) | {"cmd":"reload"} | {"cmd":"size","w":720,"h":1280} | {"cmd":"scroll","steps":2,"pages":-1,"edge":"top"} (a mouse wheel over the hero tile, see scroll-math.mjs) | {"cmd":"quit"}; anything else is ignored. A static page produces few frames: that costs nothing.
import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseScroll, wheelDeltas } from './scroll-math.mjs';
import { SIZE_MAX, SIZE_MIN, blockNonLocal, clip, findChrome, isExecutable, isLocalUrl, launchChrome, pngSize, sleep } from './shot.mjs';

export const DEFAULTS = { width: 960, height: 540, fps: 8, maxMinutes: 60 };
export const PROFILE_PREFIX = 'claude-panel-live-'; // marker for pgrep / leftover checks (differs from shot.mjs's)
export const FRAME_SLOTS = 3; // live-0.png .. live-2.png: the file just announced is never the one written next
export const FPS_MIN = 1;
export const FPS_MAX = 30;
export const MAX_MINUTES_MAX = 1440;
export const CONTROL_POLL_MS = 100;
export const FIRST_FRAME_FALLBACK_MS = 1500;
export const LOAD_WAIT_MS = 5000;
export const WATCHDOG_POLL_S = 1;
export const HASH_PATTERN = /^#[A-Za-z0-9/._-]{0,40}$/; // the same as the scene tool's shot_at
const MS_PER_S = 1000;
const MS_PER_MIN = 60_000;
const CONTROL_READ_MAX = 64 * 1024;
// A `host` line: the same name rule and size cap as a scene's own panel.emit (workspace.js forwardEmit).
export const HOST_SCENE_RE = /^[a-z0-9-]{1,24}$/;
export const HOST_NAME_RE = /^[a-z0-9._-]{1,40}$/;
export const HOST_DATA_MAX = 2200;

// The keys a control line may press, as Input.dispatchKeyEvent wants them.
export const KEYS = {
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  PageUp: { key: 'PageUp', code: 'PageUp', vk: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', vk: 34 },
  Home: { key: 'Home', code: 'Home', vk: 36 },
  End: { key: 'End', code: 'End', vk: 35 },
  Space: { key: ' ', code: 'Space', vk: 32, text: ' ' },
  o: { key: 'o', code: 'KeyO', vk: 79, text: 'o' },
  Escape: { key: 'Escape', code: 'Escape', vk: 27 },
};
const FLAG_KEYS = {
  '--out-dir': 'outDir', '--width': 'width', '--height': 'height', '--fps': 'fps', '--chrome': 'chrome',
  '--control': 'control', '--hash': 'hash', '--max-minutes': 'maxMinutes', '--state': 'state', '--base': 'base', '--fallback': 'fallback',
};
const NUMERIC = { width: [SIZE_MIN, SIZE_MAX], height: [SIZE_MIN, SIZE_MAX], fps: [FPS_MIN, FPS_MAX], maxMinutes: [1, MAX_MINUTES_MAX] };

// ---------- pure helpers (exported for tests) ----------
const isViewSide = (n) => Number.isInteger(n) && n >= SIZE_MIN && n <= SIZE_MAX;

export function parseArgs(argv) {
  const o = { url: null, outDir: null, chrome: null, control: null, hash: '', state: null, base: null, fallback: null, quitOnStdinClose: false, ...DEFAULTS };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const key = FLAG_KEYS[a];
    if (a === '--quit-on-stdin-close') o.quitOnStdinClose = true;
    else if (key) {
      const v = argv[++i];
      if (v === undefined) return { error: `missing value for ${a}` };
      if (NUMERIC[key]) {
        const [lo, hi] = NUMERIC[key];
        if (!/^\d+$/.test(v) || Number(v) < lo || Number(v) > hi) return { error: `${a} must be a whole number from ${lo} to ${hi}` };
        o[key] = Number(v);
      } else o[key] = v;
    } else if (a.startsWith('--')) return { error: `unknown option ${a}` };
    else if (o.url === null) o.url = a;
    else return { error: 'only one url allowed' };
  }
  if (!o.url || !o.outDir) return { error: 'usage: live.mjs <url> --out-dir DIR [--width N] [--height N] [--fps N] [--chrome PATH] [--control FILE] [--hash #/0] [--state FILE --base URL --fallback PATH]' };
  if (o.hash !== '' && !HASH_PATTERN.test(o.hash)) return { error: '--hash must look like #/3' };
  return o;
}

const withSlash = (s) => (s.endsWith('/') ? s : `${s}/`);
const HTTP_ERROR_FROM = 400;
// Page.navigate can answer before Network.responseReceived is delivered (seen on a loaded machine: a 404 page was then taken for a working one).
// So the status of the navigation's document is waited for, up to this long, before deciding whether to move on to the next address.
const STATUS_WAIT_MS = 5000;
const STATUS_POLL_MS = 25;
// Page.startScreencast answers "Not attached to an active page" while the tab is between two documents (the 404 page being replaced by the fallback): try again a few times before giving up.
const CAST_TRIES_MAX = 20;
const CAST_RETRY_MS = 250;
const NAVIGATE_TRIES_MAX = 4;

/**
 * Where to open the page, in order. `url` lives under `base` (the server's address when this process started, `--base`);
 * `stateUrl` is the server's address now (the state file). After a server restart on another port the same page is tried
 * there, then the `fallback` page (a path under the base, `--fallback`, the hero scene alone) on whichever address is newest.
 */
export function candidateUrls({ url, base, stateUrl, fallback }) {
  const now = stateUrl && isLocalUrl(stateUrl) ? withSlash(stateUrl) : null;
  const old = base ? withSlash(base) : null;
  const out = [url];
  if (now && old && now !== old && url.startsWith(old)) out.push(now + url.slice(old.length));
  const at = now ?? old;
  if (fallback && at) out.push(at + fallback);
  return [...new Set(out)];
}

/** The `url` field of the state file, or null (missing, unreadable, not JSON). */
export function readStateUrl(file) {
  if (!file) return null;
  try { const u = JSON.parse(readFileSync(file, 'utf8')).url; return typeof u === 'string' ? u : null; } catch { return null; }
}

/** One control line as a command, or null for anything malformed, unknown or not allowed. Never throws. */
export function parseControlLine(line) {
  let v;
  try { v = JSON.parse(line); } catch { return null; }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  if (v.cmd === 'key') return typeof v.key === 'string' && Object.hasOwn(KEYS, v.key) ? { cmd: 'key', key: v.key } : null;
  if (v.cmd === 'hash') return typeof v.hash === 'string' && HASH_PATTERN.test(v.hash) ? { cmd: 'hash', hash: v.hash } : null;
  if (v.cmd === 'scroll') return parseScroll(v);
  if (v.cmd === 'host') {
    if (typeof v.scene !== 'string' || !HOST_SCENE_RE.test(v.scene) || typeof v.name !== 'string' || !HOST_NAME_RE.test(v.name)) return null;
    const data = v.data === undefined ? null : v.data;
    return JSON.stringify(data).length <= HOST_DATA_MAX ? { cmd: 'host', scene: v.scene, name: v.name, data } : null;
  }
  if (v.cmd === 'size') return isViewSide(v.w) && isViewSide(v.h) ? { cmd: 'size', w: v.w, h: v.h } : null;
  return v.cmd === 'reload' || v.cmd === 'quit' ? { cmd: v.cmd } : null;
}

/** New text appended to a control file -> its complete lines; the unfinished tail is carried to the next call. */
export function splitLines(carry, text) {
  const parts = (carry + text).split('\n');
  return { lines: parts.slice(0, -1).filter((l) => l.trim() !== ''), carry: parts[parts.length - 1] };
}

/** `<dir>/live-<n mod 3>.png` for the n-th kept frame (n counts from 1). */
export const slotFile = (dir, n) => join(dir, `live-${(n - 1) % FRAME_SLOTS}.png`);

export const frameLine = (n, file, size) => JSON.stringify({ t: 'frame', n, file, w: size.width, h: size.height });

// The frame gate: at most one frame per interval, and the NEWEST frame that arrived too early is held and written
// when the interval is over (trailing edge), so the last frame of a transition is never lost on a page that then
// goes quiet. A gate is `{ last, held }`; both functions return the next gate, the frame to write now (or null)
// and the ms to wait before `gateFlush` should run again (or null).
export const newGate = () => ({ last: Number.NEGATIVE_INFINITY, held: null });
export function gateOffer(g, frame, now, intervalMs) {
  if (now - g.last >= intervalMs) return { gate: { last: now, held: null }, write: frame, wait: null };
  return { gate: { last: g.last, held: frame }, write: null, wait: g.last + intervalMs - now };
}
export function gateFlush(g, now, intervalMs) {
  if (g.held === null) return { gate: g, write: null, wait: null };
  if (now - g.last >= intervalMs) return { gate: { last: now, held: null }, write: g.held, wait: null };
  return { gate: g, write: null, wait: g.last + intervalMs - now };
}

// ---------- control file ----------
// Reads what was appended since the last call. A missing file is empty; a file that shrank starts over.
function controlReader(file) {
  let offset = 0;
  let carry = '';
  return () => {
    let size;
    try { size = statSync(file).size; } catch { offset = 0; carry = ''; return []; }
    if (size < offset) { offset = 0; carry = ''; }
    if (size === offset) return [];
    const len = Math.min(size - offset, CONTROL_READ_MAX);
    const buf = Buffer.alloc(len);
    let fd;
    try { fd = openSync(file, 'r'); readSync(fd, buf, 0, len, offset); } catch { return []; } finally { if (fd !== undefined) closeSync(fd); }
    offset += len;
    const out = splitLines(carry, buf.toString('utf8'));
    carry = out.carry;
    return out.lines;
  };
}

const emit = (line, done) => process.stdout.write(`${line}\n`, done);
const sayError = (error) => emit(JSON.stringify({ t: 'error', error: clip(error) }), () => process.exit(1));

// ---------- run ----------
async function pressKey(cdp, name) {
  const k = KEYS[name];
  const base = { key: k.key, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk };
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base, ...(k.text ? { text: k.text } : {}) });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}

// The hero tile (the workspace page marks it data-hero; the bare scene page has none: the whole viewport) as a wheel target.
const TILE_BOX = `(() => { const t = document.querySelector('.tile[data-hero]'); const r = t ? t.getBoundingClientRect() : { left: 0, top: 0, width: innerWidth, height: innerHeight };
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, h: r.height }; })()`;
async function scrollHero(cdp, cmd) {
  const box = (await cdp.send('Runtime.evaluate', { expression: TILE_BOX, returnByValue: true })).result?.value;
  if (!box) return;
  for (const deltaY of wheelDeltas(cmd, box.h)) await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: box.x, y: box.y, deltaX: 0, deltaY });
}

// The workspace page owns the scene iframes: it posts the message (window.PanelWorkspace.hostCommand, workspace.js). A page without it (the bare scene page) ignores the line.
export const hostExpression = (cmd) => `window.PanelWorkspace && window.PanelWorkspace.hostCommand(${JSON.stringify(cmd.scene)}, ${JSON.stringify(cmd.name)}, ${JSON.stringify(cmd.data)})`;

// Backstop for a parent that dies without running any handler (SIGKILL): a detached shell that waits for our pid to
// vanish and then kills Chrome's process group and removes the profile. Its settings travel in the environment, so
// the profile marker appears in Chrome's command line only.
function startWatchdog(chromePid, profile) {
  const script = `while kill -0 "$LIVE_PID" 2>/dev/null; do sleep ${WATCHDOG_POLL_S}; done; kill -9 -- "-$LIVE_PGID" 2>/dev/null; rm -rf "$LIVE_PROFILE"`;
  const env = { ...process.env, LIVE_PID: String(process.pid), LIVE_PGID: String(chromePid), LIVE_PROFILE: profile };
  const dog = spawn('sh', ['-c', script], { env, stdio: 'ignore', detached: true });
  dog.unref();
  return dog;
}

export async function main(argv, env = process.env) {
  const o = parseArgs(argv);
  if (o.error) return sayError(o.error);
  if (!isLocalUrl(o.url)) return sayError('only local urls');
  const chrome = findChrome({ chrome: o.chrome, env, exists: isExecutable, pathDirs: (env.PATH ?? '').split(delimiter).filter(Boolean) });
  if (!chrome) return sayError('chrome not found');

  const outDir = resolve(o.outDir);
  const interval = Math.round(MS_PER_S / o.fps);
  const res = {};
  const timers = [];
  let dog = null;
  let isStopping = false;
  let seq = 0;
  let gate = newGate();
  let flushTimer = null;

  // Fast and total: no grace period for a throwaway browser. The exit waits for the last stdout line.
  const stop = (code, error) => {
    if (isStopping) return;
    isStopping = true;
    timers.forEach(clearInterval);
    clearTimeout(flushTimer);
    try { if (res.proc?.pid) process.kill(-res.proc.pid, 'SIGKILL'); } catch { /* group already gone */ }
    try { if (dog?.pid) process.kill(-dog.pid, 'SIGKILL'); } catch { /* already gone */ }
    if (res.profile) { try { rmSync(res.profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* the watchdog or the OS tmp cleaner gets it */ } }
    if (error) emit(JSON.stringify({ t: 'error', error: clip(error) }), () => process.exit(code));
    else process.stdout.write('', () => process.exit(code));
    setTimeout(() => process.exit(code), 1000).unref(); // a stdout nobody reads must not hold the exit
  };
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.once(sig, () => stop(0));
  process.stdout.on('error', () => stop(0)); // EPIPE: whoever read our lines is gone
  for (const ev of ['unhandledRejection', 'uncaughtException']) process.on(ev, (e) => stop(1, String(e?.message ?? e)));
  if (o.quitOnStdinClose) { process.stdin.on('end', () => stop(0)); process.stdin.on('close', () => stop(0)); process.stdin.resume(); }

  const write = (buf) => {
    const size = pngSize(buf);
    if (!size) return;
    seq += 1;
    const file = slotFile(outDir, seq);
    writeFileSync(`${file}.tmp`, buf);
    renameSync(`${file}.tmp`, file); // the terminal reads the file when told: it never sees a half-written one
    if (seq === 1) emit(JSON.stringify({ t: 'ready' }));
    emit(frameLine(seq, file, size));
  };
  const flush = () => {
    flushTimer = null;
    const next = gateFlush(gate, Date.now(), interval);
    gate = next.gate;
    if (next.write) write(next.write);
    if (next.wait !== null) flushTimer = setTimeout(flush, next.wait);
  };
  const offer = (buf) => {
    const next = gateOffer(gate, buf, Date.now(), interval);
    gate = next.gate;
    if (next.write) write(next.write);
    else if (flushTimer === null) flushTimer = setTimeout(flush, next.wait);
  };

  try {
    mkdirSync(outDir, { recursive: true });
    await launchChrome(chrome, o, res, { prefix: PROFILE_PREFIX, onDisconnect: () => (res.cdp ? stop(0) : stop(1, 'devtools connect failed')) });
    res.proc.once('exit', () => stop(0));
    dog = startWatchdog(res.proc.pid, res.profile);
    const cdp = res.cdp;
    for (const d of ['Page', 'Runtime']) await cdp.send(`${d}.enable`);
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
    blockNonLocal(cdp);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: o.width, height: o.height, deviceScaleFactor: 1, mobile: false });
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
    cdp.on('Page.screencastFrame', (p) => {
      // Acked at once, kept or not. (Holding the ack back saves CPU but Chrome then never re-sends the last frame of a
      // transition on a page that goes quiet: web/live.test.mjs pins this.)
      cdp.send('Page.screencastFrameAck', { sessionId: p.sessionId }).catch(() => {});
      offer(Buffer.from(p.data, 'base64'));
    });
    // The screencast starts once the page has loaded (else the first picture is the blank tab), or after LOAD_WAIT_MS.
    // A page that then never paints a change still gets one picture, from an ordinary screenshot.
    let isCasting = false;
    const view = { width: o.width, height: o.height }; // what `size` changes; the screencast is capped at it
    const cast = async () => {
      for (let n = 1; ; n++) {
        try {
          return await cdp.send('Page.startScreencast', { format: 'png', everyNthFrame: 1, maxWidth: view.width, maxHeight: view.height });
        } catch (e) {
          if (isStopping) return;
          if (n >= CAST_TRIES_MAX || !/not attached/i.test(e.message)) return stop(1, e.message);
          await sleep(CAST_RETRY_MS);
        }
      }
    };
    const startCast = () => {
      if (isCasting || isStopping) return;
      isCasting = true;
      cast();
      sleep(FIRST_FRAME_FALLBACK_MS).then(async () => {
        if (seq > 0 || isStopping) return;
        const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }).catch(() => null);
        if (shot && seq === 0) offer(Buffer.from(shot.data ?? '', 'base64'));
      });
    };
    cdp.on('Page.loadEventFired', startCast);
    setTimeout(startCast, LOAD_WAIT_MS).unref();
    // The page opens at the first address that answers: a refused connection or an HTTP error moves on to the next
    // candidate, read afresh from the state file (the server may have restarted on another port; the workspace page may not exist).
    const statuses = new Map();
    cdp.on('Network.responseReceived', (e) => { if (e.type === 'Document') statuses.set(e.loaderId, e.response.status); });
    await cdp.send('Network.enable');
    const tried = new Set();
    for (let n = 0; n < NAVIGATE_TRIES_MAX; n++) {
      const next = candidateUrls({ url: o.url, base: o.base, stateUrl: readStateUrl(o.state), fallback: o.fallback }).find((u) => !tried.has(u));
      if (!next) break;
      tried.add(next);
      const at = new URL(next);
      if (next === o.url && o.hash !== '') at.hash = o.hash;
      const nav = await cdp.send('Page.navigate', { url: at.href });
      for (let t = 0; !nav.errorText && nav.loaderId && !statuses.has(nav.loaderId) && t < STATUS_WAIT_MS; t += STATUS_POLL_MS) await sleep(STATUS_POLL_MS);
      if (!nav.errorText && !((statuses.get(nav.loaderId) ?? 0) >= HTTP_ERROR_FROM)) break;
    }

    const takeLines = controlReader(o.control ? resolve(o.control) : join(outDir, '.no-control'));
    const startedBy = process.ppid;
    // The page keeps running: only the viewport and the screencast's cap change (a cap smaller than the viewport would crop).
    const resize = async (width, height) => {
      if (width === view.width && height === view.height) return;
      view.width = width;
      view.height = height;
      await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
      if (!isCasting) return; // not casting yet: the start will use the new size
      await cdp.send('Page.stopScreencast').catch(() => {});
      await cast();
    };
    const run = async (cmd) => {
      if (cmd.cmd === 'quit') return stop(0);
      if (cmd.cmd === 'key') return pressKey(cdp, cmd.key);
      if (cmd.cmd === 'scroll') return scrollHero(cdp, cmd);
      if (cmd.cmd === 'host') return cdp.send('Runtime.evaluate', { expression: hostExpression(cmd) });
      if (cmd.cmd === 'reload') return cdp.send('Page.reload');
      if (cmd.cmd === 'size') return resize(cmd.w, cmd.h);
      return cdp.send('Runtime.evaluate', { expression: `location.hash = ${JSON.stringify(cmd.hash)}` });
    };
    // `quit` acts at once; the other commands wait for the first picture (the page is up by then), in order.
    const queued = [];
    let isBusy = false;
    timers.push(setInterval(async () => {
      if (process.ppid !== startedBy) return stop(0); // the parent is gone: do not outlive it
      if (isBusy || isStopping) return;
      isBusy = true;
      try {
        for (const line of takeLines()) {
          const cmd = parseControlLine(line);
          if (cmd?.cmd === 'quit') return stop(0);
          if (cmd) queued.push(cmd);
        }
        while (seq > 0 && queued.length > 0) await run(queued.shift()).catch(() => {});
      } finally { isBusy = false; }
    }, CONTROL_POLL_MS));
    setTimeout(() => stop(0), o.maxMinutes * MS_PER_MIN).unref();
  } catch (e) {
    stop(1, e?.message ?? String(e));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));
