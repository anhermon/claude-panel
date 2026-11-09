#!/usr/bin/env node
// Self-check screenshot helper for panel v4 (spec section 5). Zero dependencies, Node 22.
// node shot.mjs <url> [--out file.png] [--width 1280] [--height 720] [--wait 1500] [--chrome PATH] [--timeout 30000]
// Prints exactly one JSON line on stdout, exits 0 whenever it printed. Local urls only.
import { spawn } from 'node:child_process';
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const DEFAULTS = { width: 1280, height: 720, wait: 1500, timeout: 30000 };
export const PROFILE_PREFIX = 'claude-panel-shot-'; // marker for pgrep / leftover checks
export const PORT_FILE_WAIT_MS = 5000;
export const POLL_MS = 50;
export const KILL_GRACE_MS = 2000;
export const TEXT_MAX = 200;
export const ENTRIES_MAX = 20;
export const LOAD_RESERVE_MS = 3000; // left for the settle wait + screenshot when the page never loads
export const MIN_LOAD_WAIT_MS = 1000;
export const SIZE_MIN = 100;
export const SIZE_MAX = 4000;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_IHDR_WIDTH_OFFSET = 16;
const PNG_IHDR_HEIGHT_OFFSET = 20;
const LOCAL_HOSTS = ['127.0.0.1', 'localhost'];
const KNOWN_CHROMES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
];
const PATH_NAMES = ['google-chrome', 'chromium', 'chrome', 'google-chrome-stable', 'chromium-browser'];
export const HEADLESS_FLAGS = [
  '--headless=new', '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check',
  '--disable-extensions', '--hide-scrollbars', '--mute-audio',
];
const FLAG_KEYS = { '--out': 'out', '--width': 'width', '--height': 'height', '--wait': 'wait', '--chrome': 'chrome', '--timeout': 'timeout' };
const NUMERIC_KEYS = ['width', 'height', 'wait', 'timeout'];

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dbg = (...a) => { if (process.env.SHOT_DEBUG === '1') console.error('[shot]', ...a); };

// ---------- pure helpers (exported for tests) ----------
export function parseArgs(argv) {
  const o = { url: null, out: null, chrome: null, ...DEFAULTS };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const key = FLAG_KEYS[a];
    if (key) {
      const v = argv[++i];
      if (v === undefined) return { error: `missing value for ${a}` };
      if (NUMERIC_KEYS.includes(key)) {
        if (!/^\d+$/.test(v)) return { error: `bad value for ${a}` };
        o[key] = Number(v);
      } else o[key] = v;
    } else if (a.startsWith('--')) return { error: `unknown option ${a}` };
    else if (o.url === null) o.url = a;
    else return { error: 'only one url allowed' };
  }
  if (!o.url) return { error: 'usage: shot.mjs <url> [--out f.png] [--width N] [--height N] [--wait ms] [--chrome PATH] [--timeout ms]' };
  for (const k of ['width', 'height']) if (o[k] < SIZE_MIN || o[k] > SIZE_MAX) return { error: `${k} out of range` };
  if (o.timeout < 1) return { error: 'timeout must be positive' };
  return o;
}

// http(s) on 127.0.0.1 / localhost with an explicit port, no credentials. The URL parser makes
// `http://127.0.0.1@evil.com` -> host evil.com and `127.0.0.1.evil.com` a different hostname.
export function isLocalUrl(s) {
  let u;
  try { u = new URL(String(s)); } catch { return false; }
  return u.protocol === 'http:' && LOCAL_HOSTS.includes(u.hostname) && u.port !== '' && !u.username && !u.password;
}

// Requests the page may make while we look at it: local http, or inline data/blob/about.
export function isAllowedRequest(s) {
  return isLocalUrl(s) || /^(data|blob|about):/i.test(String(s));
}

export function clip(s, n = TEXT_MAX) {
  s = String(s ?? '');
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

export function safeUrl(s) {
  try { const u = new URL(s); return u.host + u.pathname; } catch { return clip(s, 80); }
}

// Candidate order: --chrome, env CHROME, known macOS apps, then PATH (Linux: google-chrome, chromium, chrome, google-chrome-stable, chromium-browser). exists() is injected.
export function findChrome({ chrome, env = {}, exists, pathDirs = [] }) {
  const cands = [chrome, env.CHROME, ...KNOWN_CHROMES];
  for (const d of pathDirs) for (const n of PATH_NAMES) cands.push(join(d, n));
  return cands.find((c) => c && exists(c)) ?? null;
}

export const isExecutable = (p) => { try { if (!existsSync(p)) return false; accessSync(p, constants.X_OK); return true; } catch { return false; } };

export function buildResult(ok, fields, st = {}, ms = 0) {
  const base = ok ? { ok: true, ...fields } : { ok: false, error: clip(fields.error, TEXT_MAX) };
  const out = { ...base, console: st.console ?? [], errors: st.errors ?? [], ms };
  if (st.loadTimedOut) out.loadTimedOut = true;
  return out;
}

export function pngSize(buf) {
  if (buf.length < 24 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  return { width: buf.readUInt32BE(PNG_IHDR_WIDTH_OFFSET), height: buf.readUInt32BE(PNG_IHDR_HEIGHT_OFFSET) };
}

// ---------- chrome + CDP ----------
export async function readPortFile(profile, proc) {
  const file = join(profile, 'DevToolsActivePort');
  const end = Date.now() + PORT_FILE_WAIT_MS;
  while (Date.now() < end) {
    if (proc.exitCode !== null || proc.signalCode) throw new Error('chrome exited early');
    try {
      const lines = readFileSync(file, 'utf8').split('\n');
      if (lines.length >= 2 && /^\d+$/.test(lines[0])) return Number(lines[0]);
    } catch { /* not there yet */ }
    await sleep(POLL_MS);
  }
  throw new Error('devtools port file never appeared');
}

// `onDisconnect` (optional) is called once when the browser connection closes after it was open.
export function cdpConnect(wsUrl, onDisconnect) {
  return new Promise((ok, fail) => {
    const ws = new WebSocket(wsUrl);
    const pending = new Map();
    const handlers = new Map();
    let id = 0;
    let closed = false;
    const onClose = () => {
      closed = true;
      for (const p of pending.values()) p.reject(new Error('chrome connection closed'));
      pending.clear();
    };
    ws.addEventListener('error', () => fail(new Error('devtools connect failed')));
    ws.addEventListener('close', () => { onClose(); fail(new Error('devtools connect failed')); onDisconnect?.(); });
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.id && pending.has(m.id)) {
        const p = pending.get(m.id); pending.delete(m.id);
        m.error ? p.reject(new Error(`${p.method}: ${m.error.message}`)) : p.resolve(m.result);
      } else if (m.method) (handlers.get(m.method) ?? []).forEach((h) => h(m.params));
    });
    ws.addEventListener('open', () => ok({
      send: (method, params = {}) => new Promise((resolve, reject) => {
        if (closed) return reject(new Error('chrome connection closed'));
        const n = ++id; pending.set(n, { resolve, reject, method });
        ws.send(JSON.stringify({ id: n, method, params }));
      }),
      on: (method, fn) => handlers.set(method, [...(handlers.get(method) ?? []), fn]),
      close: () => { try { ws.close(); } catch { /* already gone */ } },
    }));
  });
}

export async function killTree(proc) {
  if (!proc?.pid) return;
  const sig = (s) => { try { process.kill(-proc.pid, s); } catch { /* group already gone */ } };
  if (proc.exitCode === null && !proc.signalCode) {
    const exited = new Promise((r) => proc.once('exit', r));
    sig('SIGTERM');
    await Promise.race([exited, sleep(KILL_GRACE_MS)]);
  }
  sig('SIGKILL'); // helpers (gpu/renderer) that outlived the browser process
}

export async function cleanup(res) {
  res.cdp?.close();
  await killTree(res.proc);
  if (res.profile) { try { rmSync(res.profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch (e) { dbg('rm failed', e.message); } }
}

// ---------- capture ----------
function collect(cdp, st, res) {
  const add = (list, v) => { if (list.length < ENTRIES_MAX && !(typeof v === 'string' && list.includes(v))) list.push(v); };
  cdp.on('Runtime.consoleAPICalled', (p) => {
    if (p.type !== 'error' && p.type !== 'warning') return;
    const text = (p.args ?? []).map((a) => a.value ?? a.description ?? a.type).join(' ');
    if (st.console.length < ENTRIES_MAX) st.console.push({ level: p.type, text: clip(text) });
  });
  cdp.on('Runtime.exceptionThrown', (p) => {
    const d = p.exceptionDetails ?? {};
    add(st.errors, clip((d.exception?.description ?? d.text ?? 'exception').split('\n')[0]));
  });
  cdp.on('Log.entryAdded', (p) => {
    const e = p.entry ?? {};
    if (e.level !== 'error') return;
    add(st.errors, clip(e.url ? `${e.text} ${safeUrl(e.url)}` : e.text));
  });
  blockNonLocal(cdp, (url) => add(st.errors, clip(`blocked non-local request ${safeUrl(url)}`)));
}

// Keep the page local: block any request that leaves 127.0.0.1/localhost (redirects, subresources).
// The caller still sends `Fetch.enable` (patterns '*'). `onBlocked(url)` is told about each refusal.
export function blockNonLocal(cdp, onBlocked = () => {}) {
  cdp.on('Fetch.requestPaused', (p) => {
    if (isAllowedRequest(p.request.url)) return cdp.send('Fetch.continueRequest', { requestId: p.requestId }).catch(() => {});
    onBlocked(p.request.url);
    cdp.send('Fetch.failRequest', { requestId: p.requestId, errorReason: 'BlockedByClient' }).catch(() => {});
  });
}

// Start a headless Chrome in its own process group with a throwaway profile named `<prefix>XXXXXX`, open one
// blank tab and connect to it. Everything is recorded on `res` (profile, proc, cdp) as soon as it exists, so
// `cleanup(res)` works from any failure. `onDisconnect` is passed to cdpConnect. Returns the debugging port.
export async function launchChrome(chrome, { width, height }, res, { prefix = PROFILE_PREFIX, onDisconnect } = {}) {
  res.profile = mkdtempSync(join(tmpdir(), prefix));
  const args = [...HEADLESS_FLAGS, `--user-data-dir=${res.profile}`, `--window-size=${width},${height}`, 'about:blank'];
  res.proc = spawn(chrome, args, { stdio: 'ignore', detached: true });
  res.proc.on('error', (e) => dbg('spawn error', e.message));
  res.proc.unref();
  const port = await readPortFile(res.profile, res.proc);
  dbg('port', port);
  const tab = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
  res.cdp = await cdpConnect(tab.webSocketDebuggerUrl, onDisconnect);
  return port;
}

async function capture(o, chrome, st, res, t0) {
  await launchChrome(chrome, o, res);
  const cdp = res.cdp;
  collect(cdp, st, res);
  for (const d of ['Page', 'Runtime', 'Log']) await cdp.send(`${d}.enable`);
  await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: o.width, height: o.height, deviceScaleFactor: 1, mobile: false });
  let loaded;
  const loadFired = new Promise((r) => { loaded = r; });
  cdp.on('Page.loadEventFired', () => loaded(true));
  const nav = await cdp.send('Page.navigate', { url: o.url });
  if (nav.errorText) throw new Error(`navigation failed: ${nav.errorText}`);
  const loadWait = Math.max(MIN_LOAD_WAIT_MS, o.timeout - (Date.now() - t0) - o.wait - LOAD_RESERVE_MS);
  if (!(await Promise.race([loadFired, sleep(loadWait).then(() => false)]))) st.loadTimedOut = true;
  await sleep(o.wait);
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  const buf = Buffer.from(shot.data ?? '', 'base64');
  const size = pngSize(buf);
  if (!size || !size.width || !size.height) throw new Error('empty screenshot');
  const png = resolve(o.out ?? join(tmpdir(), 'claude-panel', 'shots', `shot-${Date.now()}.png`));
  mkdirSync(dirname(png), { recursive: true });
  writeFileSync(png, buf);
  return { png, width: size.width, height: size.height, bytes: buf.length };
}

export async function main(argv, env = process.env) {
  const t0 = Date.now();
  const st = { console: [], errors: [] };
  const fail = (error) => buildResult(false, { error }, st, Date.now() - t0);
  const o = parseArgs(argv);
  if (o.error) return fail(o.error);
  if (!isLocalUrl(o.url)) return fail('only local urls');
  const chrome = findChrome({ chrome: o.chrome, env, exists: isExecutable, pathDirs: (env.PATH ?? '').split(delimiter).filter(Boolean) });
  if (!chrome) return fail('chrome not found');
  const res = {};
  let timer;
  const onSignal = () => cleanup(res).finally(() => process.exit(1));
  process.once('SIGTERM', onSignal); process.once('SIGINT', onSignal);
  try {
    const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`timeout after ${o.timeout}ms`)), o.timeout); });
    const work = capture(o, chrome, st, res, t0);
    work.catch(() => {}); // loses the race on timeout; cleanup below makes it reject
    const fields = await Promise.race([work, timeout]);
    return buildResult(true, fields, st, Date.now() - t0);
  } catch (e) {
    return fail(e.message);
  } finally {
    clearTimeout(timer);
    process.off('SIGTERM', onSignal); process.off('SIGINT', onSignal);
    await cleanup(res);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((r) => { process.stdout.write(JSON.stringify(r) + '\n'); process.exit(0); });
}
