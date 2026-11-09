// Serving of scene files: the part of the panel server that hands model-written code to the browser.
//
// RESIDUAL RISK (read before loosening anything):
//  - Scene code is untrusted. It runs in a sandboxed iframe (opaque origin: no cookies, storage or access to the
//    panel page), but with the user's browser capabilities minus same-origin: it can burn CPU, play audio, use the
//    GPU, and talk to the allow-listed CDNs below.
//  - The allow-listed CDNs (jsdelivr in particular, which serves arbitrary GitHub content) can serve ANY script to a
//    scene, so the CSP limits where code and data may go, it does not vouch for what runs. Exfiltration to other
//    origins is blocked (default-src 'none', no remote images or fetches), but a scene can still encode data into
//    requests to those CDNs. Do not put secrets in a scene folder or in anything a scene can read.
//  - Scene responses carry `Access-Control-Allow-Origin: *` (the sandboxed frame has an opaque origin, so every
//    fetch of its own files is cross-origin). Only scene files get that header; the UI, /state and /events do not,
//    so scene code can send requests to them but can never read the answers.
//  - Every file under a scene dir that passes the checks below is readable by every scene (they share one server).
//
// File rules: the requested path may not contain dot segments or encoded separators; the real path (symlinks
// resolved) must stay inside the real scene dir; regular files only; extension in SCENE_FILE_TYPES; <= 64 MiB;
// no directory listings. Range is supported (audio/video seeking).
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream';
import { wrapEntry } from './scene-doc.mjs';

/**
 * THE allow-list: extension -> Content-Type. The skill docs mirror `SCENE_EXTENSIONS` (derived below).
 * Anything not listed is a 404.
 */
export const SCENE_FILE_TYPES = Object.freeze({
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  csv: 'text/plain; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  flac: 'audio/flac',
  mp4: 'video/mp4',
  webm: 'video/webm',
  glb: 'model/gltf-binary',
  gltf: 'model/gltf+json',
  bin: 'application/octet-stream',
  obj: 'text/plain; charset=utf-8',
  stl: 'model/stl',
  hdr: 'application/octet-stream',
  ktx2: 'image/ktx2',
  woff2: 'font/woff2',
});
export const SCENE_EXTENSIONS = Object.freeze(Object.keys(SCENE_FILE_TYPES));

export const MAX_FILE_BYTES = 64 * 1024 * 1024;
export const DEFAULT_ENTRY = 'index.html';
const WRAPPED_EXTENSIONS = new Set(['html', 'htm']);
const TEXT_TYPE = 'text/plain; charset=utf-8';
const DOT = '.';

// CDN transition (spec v4 addendum): while ALLOW_CDN is true the three CDN hosts stay in the script/style/font/connect
// lists and 'unsafe-eval' stays too, so the v3 recipes that load libraries from jsdelivr keep running. T21 flips it
// to false once the skill and recipes use the local kit; that removes every CDN host AND 'unsafe-eval' (the CDN
// exfiltration path). `sceneCsp` follows the constant, `buildSceneCsp` takes the flag so tests can pin both.
export const ALLOW_CDN = false;
const CDN_SCRIPT_STYLE = ['https://cdnjs.cloudflare.com', 'https://cdn.jsdelivr.net'];
const CDN_ALL = [...CDN_SCRIPT_STYLE, 'https://unpkg.com'];
const GOOGLE_FONTS_CSS = 'https://fonts.googleapis.com';
const GOOGLE_FONTS_FILES = 'https://fonts.gstatic.com';

/**
 * The scene CSP, built with the server's REAL origin: the iframe is sandboxed (opaque origin), so 'self' would
 * match nothing. No remote images/fetches on purpose: remote images must be downloaded into the scene folder.
 */
export function buildSceneCsp(origin, allowCdn) {
  const cdn = (hosts) => (allowCdn ? hosts : []);
  const directives = [
    ['default-src', "'none'"],
    ['script-src', "'unsafe-inline'", ...(allowCdn ? ["'unsafe-eval'"] : []), 'blob:', origin, ...cdn(CDN_ALL)],
    ['style-src', "'unsafe-inline'", origin, ...cdn([GOOGLE_FONTS_CSS, ...CDN_SCRIPT_STYLE])],
    ['font-src', 'data:', origin, ...cdn([GOOGLE_FONTS_FILES, ...CDN_SCRIPT_STYLE])],
    ['img-src', origin, 'data: blob:'],
    ['media-src', origin, 'data: blob:'],
    ['connect-src', origin, 'blob: data:', ...cdn(CDN_ALL)],
    ['worker-src', 'blob:', origin],
    ['frame-src', "'none'"],
    ['form-action', "'none'"],
    ['base-uri', "'self'"],
    ['sandbox', 'allow-scripts'],
  ];
  return directives.map((d) => d.join(' ')).join('; ');
}

export const sceneCsp = (origin) => buildSceneCsp(origin, ALLOW_CDN);

/** Headers on every scene response (files, entry documents, and the errors of the scene routes). */
export function sceneHeaders(origin) {
  return {
    'content-security-policy': sceneCsp(origin),
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    'cross-origin-resource-policy': 'cross-origin',
  };
}

/** True when `child` lies inside `parent` (or equals it when `orEqual`). Both must be absolute, resolved paths. */
export function isWithin(parent, child, orEqual = false) {
  const rel = path.relative(parent, child);
  if (rel === '') return orEqual;
  return rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
}

/**
 * Raw (still percent-encoded) path segments -> decoded segments, or null when any is unsafe: bad encoding,
 * an encoded separator or NUL, or a dot segment ('.', '..', dotfiles, dot directories).
 */
export function decodeSegments(rawSegments) {
  const out = [];
  for (const raw of rawSegments) {
    let seg;
    try {
      seg = decodeURIComponent(raw);
    } catch {
      return null;
    }
    if (seg.includes('/') || seg.includes('\\') || seg.includes('\0') || seg.startsWith(DOT)) return null;
    out.push(seg);
  }
  return out;
}

/**
 * Range header -> `null` (no/ignored range: send everything), `{ start, end }` (inclusive), or `'unsatisfiable'`.
 * Multiple ranges, other units and malformed headers are ignored (RFC 9110 allows serving the full file).
 */
export function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header || '').trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  if (m[1] === '') {
    const suffix = Number(m[2]);
    if (suffix === 0 || size === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(m[1]);
  const end = m[2] === '' ? size - 1 : Number(m[2]);
  if (m[2] !== '' && end < start) return null; // last-pos < first-pos is invalid syntax
  if (start >= size) return 'unsatisfiable';
  return { start, end: Math.min(end, size - 1) };
}

function reply(req, res, status, headers, body) {
  const length = body === undefined ? 0 : Buffer.byteLength(body);
  res.writeHead(status, { ...headers, 'content-length': length });
  res.end(req.method === 'HEAD' ? undefined : body);
}

/** Real path of a regular, allowed file inside the scene dir, or null. Never throws. */
export async function resolveFile(sceneDir, segments, roots) {
  try {
    const root = await fs.promises.realpath(sceneDir);
    if (roots && !roots.some((r) => isWithin(r, root, true))) return null;
    const real = await fs.promises.realpath(path.join(root, ...segments));
    if (!isWithin(root, real)) return null; // symlink (file or directory) pointing outside
    if (path.relative(root, real).split(path.sep).some((s) => s.startsWith(DOT))) return null;
    return (await fs.promises.stat(real)).isFile() ? real : null;
  } catch {
    return null;
  }
}

/**
 * Streams one resolved file. `type` = Content-Type. `transform` (optional, async text -> text) is applied to the
 * whole file instead of streaming it, with no Range support (used for the entry document).
 */
export async function sendFile(req, res, real, type, headers, transform = null) {
  const fh = await fs.promises.open(real, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)); // refuse a swap to a symlink after the check
  let streaming = false;
  try {
    const st = await fh.stat();
    if (!st.isFile()) return reply(req, res, 404, { ...headers, 'content-type': TEXT_TYPE }, 'not found');
    if (st.size > MAX_FILE_BYTES) return reply(req, res, 413, { ...headers, 'content-type': TEXT_TYPE }, 'file too large');
    if (transform) return reply(req, res, 200, { ...headers, 'content-type': type }, await transform(await fh.readFile('utf8')));

    const range = parseRange(req.headers.range, st.size);
    if (range === 'unsatisfiable') {
      return reply(req, res, 416, { ...headers, 'content-type': TEXT_TYPE, 'content-range': `bytes */${st.size}` }, 'range not satisfiable');
    }
    const partial = range !== null;
    const start = partial ? range.start : 0;
    const end = partial ? range.end : st.size - 1;
    const outHeaders = { ...headers, 'content-type': type, 'accept-ranges': 'bytes', 'content-length': st.size === 0 ? 0 : end - start + 1 };
    if (partial) outHeaders['content-range'] = `bytes ${start}-${end}/${st.size}`;
    res.writeHead(partial ? 206 : 200, outHeaders);
    if (req.method === 'HEAD' || st.size === 0) return void res.end();
    streaming = true; // the stream owns (and closes) the handle from here on
    pipeline(fh.createReadStream({ start, end }), res, () => {});
    return undefined;
  } finally {
    if (!streaming) await fh.close().catch(() => {});
  }
}

/**
 * Serve one request for a file below `dir`. `restSegments` are the raw (still percent-encoded) URL segments below the
 * route; `[ '' ]` means the entry document when `entry` is given. `types` = the extension allow-list (ext -> type),
 * `roots` = realpath'd allowed roots for `dir` (null = unrestricted, [] = nothing). `entryTransform(text)` is applied to
 * the entry document only (and only for `WRAPPED_EXTENSIONS`). Never throws; answers 404 for anything unsafe.
 */
export async function handleDirRequest(req, res, { dir, restSegments, roots, types, headers, entry = null, entryTransform = null }) {
  const notFound = () => reply(req, res, 404, { ...headers, 'content-type': TEXT_TYPE }, 'not found');
  try {
    const entrySegments = entry === null ? null : decodeSegments(entry.split('/'));
    const isEntryUrl = entry !== null && restSegments.length === 1 && restSegments[0] === '';
    const segments = isEntryUrl ? entrySegments : decodeSegments(restSegments);
    if (!segments || !segments.length || segments.some((s) => s === '')) return notFound(); // also: no directory URLs
    const ext = path.extname(segments[segments.length - 1]).slice(1).toLowerCase();
    if (!Object.hasOwn(types, ext)) return notFound();
    const real = await resolveFile(dir, segments, roots);
    if (!real) return notFound();
    const isEntry = isEntryUrl || (entrySegments !== null && entrySegments.join('/') === segments.join('/'));
    const transform = isEntry && entryTransform && WRAPPED_EXTENSIONS.has(ext) ? entryTransform : null;
    return await sendFile(req, res, real, types[ext], headers, transform);
  } catch (err) {
    process.stderr.write(`panel server: file request failed (${err && err.code ? err.code : err})\n`);
    if (!res.headersSent) return reply(req, res, 500, { ...headers, 'content-type': TEXT_TYPE }, 'error');
    res.destroy();
    return undefined;
  }
}

/**
 * Serve one request below `/s/<id>/`.
 * `restSegments` are the raw segments after the id: `['']` means the entry document (`/s/<id>/`), otherwise the
 * path of a file. `scene` = `{ dir (absolute), entry }`; `roots` = realpath'd allowed roots for `dir`, or null for
 * unrestricted (an EMPTY array allows nothing). `kit` = `{ url, importMap() }` (see scene-kit.mjs): the entry
 * document gets the kit head injected (importmap, panel.css, panel.js); without it only the window.panel fallback.
 */
export function handleSceneRequest(req, res, { scene, restSegments, origin, roots, kit = null }) {
  const entryTransform = async (text) => wrapEntry(text, kit && { url: kit.url, imports: await kit.importMap() });
  return handleDirRequest(req, res, {
    dir: scene.dir, restSegments, roots, types: SCENE_FILE_TYPES, headers: sceneHeaders(origin),
    entry: scene.entry || DEFAULT_ENTRY, entryTransform,
  });
}
