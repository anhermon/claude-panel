// The return channel: `POST /<token>/event` appends what the user did in the browser to an events file the mod
// reads (spec v4 section 4). Only the HOST page may call it: scene frames are sandboxed (opaque origin), so their
// requests carry `Origin: null` and are refused; the host page forwards a frame's `panel-emit` after validating it
// and tags the scene id itself. That is why `_ask` answers cannot be forged from scene code.
//
// Route rules, in this order: method POST (else 405) · Origin (403) · global rate limit (429) · Content-Type
// application/json (415) · body <= 4 KiB (413) · JSON object with a valid `name` (400) · scene id known or `_ask`
// (400/404) · `data` re-serialised, replaced by {"_clipped":true} when over 2 KiB. No ACAO header, no OPTIONS handling.
//
// Events file: the state file path with a trailing `.json` replaced by `.events.jsonl`. One JSON line per event:
// `{n, t, scene, name, data}`. `n` is monotonic and survives trimming (the file is cut to its last 200 lines once it
// passes 1000), so consumers must track the last `n` they delivered, NOT a line count.
import fs from 'node:fs';
import { SCENE_ID_RE } from './scene-registry.mjs';

export const EVENT_SEGMENT = 'event';
export const ASK_SCENE = '_ask';
export const EVENT_NAME_RE = /^[a-z0-9._-]{1,40}$/;
export const MAX_BODY_BYTES = 4096;
export const MAX_DATA_BYTES = 2048;
export const RATE_LIMIT_PER_WINDOW = 20;
export const RATE_WINDOW_MS = 1000;
export const TRIM_ABOVE_LINES = 1000;
export const KEEP_LINES = 200;
export const CLIPPED_DATA = Object.freeze({ _clipped: true });
const EVENTS_SUFFIX = '.events.jsonl';
const JSON_SUFFIX = '.json';
const FILE_MODE = 0o600; // clicks and answers are the user's own data
const JSON_RESPONSE_TYPE = 'application/json; charset=utf-8';
const JSON_TYPE_RE = /^application\/json\s*(;|$)/i;
const SAME_ORIGIN = 'same-origin';
const MS_PER_SECOND = 1000;

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const splitLines = (text) => text.split('\n').filter((l) => l !== '');

/** State file path -> events file path. */
export function eventsFileFor(stateFile) {
  return (stateFile.endsWith(JSON_SUFFIX) ? stateFile.slice(0, -JSON_SUFFIX.length) : stateFile) + EVENTS_SUFFIX;
}

/** Sliding-window limiter: at most `limit` hits in any `windowMs`. */
export function createRateLimiter({ limit = RATE_LIMIT_PER_WINDOW, windowMs = RATE_WINDOW_MS, now = Date.now } = {}) {
  const stamps = [];
  return () => {
    const t = now();
    while (stamps.length && t - stamps[0] >= windowMs) stamps.shift();
    if (stamps.length >= limit) return false;
    stamps.push(t);
    return true;
  };
}

/**
 * Append-only event log with trimming. The mod may append its own lines (terminal ask buttons), so before every
 * append the file size is compared with what we wrote last; a mismatch re-reads the file for `n` and the line count.
 */
export function createEventLog(file, { now = Date.now } = {}) {
  let size = -1; // -1 = never looked
  let lines = 0;
  let lastN = 0;
  let glue = ''; // '\n' when the file does not end with one

  const sizeOnDisk = () => {
    try {
      return fs.statSync(file).size;
    } catch {
      return 0;
    }
  };
  const rescan = () => {
    let text = '';
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch { /* no file yet */ }
    const all = splitLines(text);
    lines = all.length;
    lastN = lines;
    try {
      const n = JSON.parse(all[all.length - 1]).n;
      if (Number.isSafeInteger(n) && n > 0) lastN = n;
    } catch { /* empty or unparsable tail: fall back to the line count */ }
    glue = text !== '' && !text.endsWith('\n') ? '\n' : '';
    size = sizeOnDisk();
  };
  const trim = () => {
    const keep = splitLines(fs.readFileSync(file, 'utf8')).slice(-KEEP_LINES);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, `${keep.join('\n')}\n`, { mode: FILE_MODE });
    fs.renameSync(tmp, file); // readers see the old or the new file, never half of one
    lines = keep.length;
    size = sizeOnDisk();
  };

  return {
    /** Appends one event, returns its `n`. Throws on I/O errors. */
    append({ scene, name, data }) {
      if (sizeOnDisk() !== size) rescan();
      const n = lastN + 1;
      fs.appendFileSync(file, `${glue}${JSON.stringify({ n, t: now(), scene, name, data })}\n`, { mode: FILE_MODE });
      glue = '';
      lastN = n;
      lines += 1;
      size = sizeOnDisk();
      if (lines > TRIM_ABOVE_LINES) trim();
      return n;
    },
  };
}

/** Body -> `Buffer`, or `null` when it is larger than `limit` bytes (the rest is discarded, not buffered). */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    if (Number(req.headers['content-length']) > limit) {
      resolve(null);
      return;
    }
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > limit) resolve(null);
      else chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks))); // a no-op after an overflow resolve(null)
    req.on('error', reject);
  });
}

/** Origin rule: exactly the server's own origin. A missing Origin is allowed only without browser fetch metadata (curl). */
function originAllowed(headers, origin) {
  if (headers.origin !== undefined) return headers.origin === origin;
  const site = headers['sec-fetch-site'];
  return site === undefined || site === SAME_ORIGIN;
}

/**
 * Request handler for the event route (after the server's Host and token checks).
 * `registry.get(id)` tells whether a scene exists; `headers` = the server's base response headers.
 */
export function createEventHandler({ registry, log, getOrigin, headers, rateOk = createRateLimiter() }) {
  const send = (res, status, body, extra = {}) => {
    const text = JSON.stringify(body);
    res.writeHead(status, { ...headers, ...extra, 'content-type': JSON_RESPONSE_TYPE, 'content-length': Buffer.byteLength(text) });
    res.end(text);
  };
  const fail = (res, status, error, extra) => send(res, status, { error }, extra);

  async function handleEvent(req, res) {
    if (req.method !== 'POST') return fail(res, 405, 'method not allowed', { allow: 'POST' });
    if (!originAllowed(req.headers, getOrigin())) return fail(res, 403, 'forbidden origin');
    if (!rateOk()) return fail(res, 429, 'too many events', { 'retry-after': String(Math.ceil(RATE_WINDOW_MS / MS_PER_SECOND)) });
    if (!JSON_TYPE_RE.test(req.headers['content-type'] || '')) return fail(res, 415, 'content-type must be application/json');
    const raw = await readBody(req, MAX_BODY_BYTES).catch(() => undefined);
    if (raw === undefined) return fail(res, 400, 'unreadable body', { connection: 'close' });
    if (raw === null) return fail(res, 413, `body over ${MAX_BODY_BYTES} bytes`, { connection: 'close' });

    let body;
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      return fail(res, 400, 'body is not JSON');
    }
    if (!isObj(body)) return fail(res, 400, 'body must be a JSON object');
    const { scene, name } = body;
    if (typeof name !== 'string' || !EVENT_NAME_RE.test(name)) return fail(res, 400, 'bad event name');
    if (typeof scene !== 'string' || (scene !== ASK_SCENE && !SCENE_ID_RE.test(scene))) return fail(res, 400, 'bad scene id');
    if (scene !== ASK_SCENE && !registry.get(scene)) return fail(res, 404, 'unknown scene');

    let data = body.data === undefined ? null : body.data;
    if (Buffer.byteLength(JSON.stringify(data)) > MAX_DATA_BYTES) data = CLIPPED_DATA;
    try {
      return send(res, 200, { n: log.append({ scene, name, data }) });
    } catch (err) {
      process.stderr.write(`panel server: cannot write the events file (${err && err.code ? err.code : err})\n`);
      return fail(res, 500, 'cannot store the event');
    }
  }

  // The server calls this without awaiting: nothing may escape as an unhandled rejection.
  return (req, res) => handleEvent(req, res).catch((err) => {
    process.stderr.write(`panel server: event request failed (${err && err.code ? err.code : err})\n`);
    if (!res.headersSent) fail(res, 500, 'error');
    else res.destroy();
  });
}
