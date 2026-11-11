#!/usr/bin/env node
// Panel web server: zero-dependency, READ-ONLY.
//
//   node web/server.mjs <stateFile> [--token T] [--port P] [--root DIR]... [--kit DIR]
//
//   --token T   unguessable first path segment of every route (URL-safe chars only). Minted with crypto when
//               omitted, so the sample fixture works standalone (the URL is then printed on stderr).
//   --port P    port to try first; if busy, the next 19 ports, then any free port. `0` = any free port.
//               Default: $CLAUDE_PANEL_PORT, else 4717.
//   --root DIR  (repeatable) scene dirs must lie inside one of these (realpath'd). No --root at all = unrestricted.
//               A root that does not exist is skipped with a warning; if every given root is missing, NO scene is served.
//   --kit DIR   the vendored kit (libraries + house files + manifest.json, see scene-kit.mjs). Default: <web>/kit.
//               A missing kit or manifest is not fatal: scenes still load, with only the house import specifiers.
//
// stdout carries exactly one line, `PORT <n>`, once the server is listening. Everything else goes to stderr.
//
// Routes (all under /<token>/, anything else is 404; non-GET/HEAD is 405 except POST /event; a Host other than
// 127.0.0.1:<port> or localhost:<port> is 421, which defends against DNS rebinding):
//   /                  the UI              /ui.css /ui.js /blocks.js /scenes.js   static allow-list
//   /state             JSON                /events                                SSE: state on connect + on change
//   /s/<id>/           scene entry document (wrapped + kit head injected, see scene-doc.mjs)
//   /s/<id>/<path...>  scene files (rules and residual risks: see scene-files.mjs)
//   /workspace/        the workspace page (builtin/workspace/): every main scene as a tile of one grid. The terminal's live preview
//                      screencasts it; /workspace/<file> serves its three assets (an exact allow-list). Own CSP: it frames /s/<id>/.
//   /global/           the GLOBAL view (global/): a read-only overview of every Claude Code session of this machine active in the last
//                      48 h (global/view.mjs); /global/state.json is its JSON (computed on request, cached ~2 s). Own CSP, no inline script.
//   /kit/<path...>     vendored kit files (scene-kit.mjs): same file rules, smaller type list, no scene CSP
//   POST /event        the return channel from the host page to Claude (scene-events.mjs)
// The state sent to the page has scenes reduced to a whitelist (scene-registry.mjs); `dir` never leaves this process.
//
// RESIDUAL RISK: this server serves model-written code (scenes). It is contained, not trusted: scenes run in a
// sandboxed iframe (no same-origin) under a strict CSP, but while ALLOW_CDN is on (scene-files.mjs) the allow-listed
// CDNs (cdn.jsdelivr.net serves arbitrary GitHub content, unpkg and cdnjs similar) can deliver any script into a
// scene, and scene code runs with the user's browser capabilities minus same-origin (CPU, GPU, audio, requests to
// those CDNs). Do not put secrets in a scene folder or in anything it can fetch. Details: scene-files.mjs.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { handleSceneRequest } from './scene-files.mjs';
import { createSceneRegistry, SCENE_ID_RE } from './scene-registry.mjs';
import { createKit, KIT_SEGMENT } from './scene-kit.mjs';
import { createGlobalView } from './global/view.mjs';
import { createEventHandler, createEventLog, eventsFileFor, EVENT_SEGMENT } from './scene-events.mjs';

const HOST = '127.0.0.1';
const LOCAL_NAME = 'localhost';
const PORT_ENV = 'CLAUDE_PANEL_PORT';
const DEFAULT_PORT = 4717;
const PORT_TRIES = 20;
const FIRST_PORT_RETRIES = 12;
const FIRST_PORT_RETRY_MS = 250;
const HANDOVER_SEGMENT = 'handover';
const HANDOVER_HEADER = 'x-panel-handover';
const HANDOVER_EXIT_MS = 50; // lets the 200 reach the asker before the process goes
const HANDOVER_ASK_MS = 1000;
const ANY_PORT = 0;
const MAX_PORT = 65535;
const POLL_MS = 300;
const KEEPALIVE_MS = 15000;
const TOKEN_BYTES = 16;
const TOKEN_RE = /^[A-Za-z0-9._~-]+$/; // URL-unreserved characters: never needs escaping, can never contain '/'
const WEB_DIR = path.dirname(fileURLToPath(import.meta.url));
const HTML_TYPE = 'text/html; charset=utf-8';
const JS_TYPE = 'text/javascript; charset=utf-8';
const TEXT_TYPE = 'text/plain; charset=utf-8';
// Static files, by exact name below the token. Anything not listed is a 404 (no path joins from the request).
// Besides these, a flat `<name>.js|css` is served when ui.html itself references it (UI modules such as stage.js
// need no server change); see sendUiAsset.
const UI_ASSET_RE = /^[a-z0-9][a-z0-9._-]*\.(js|css)$/;
const UI_ASSET_TYPES = { js: JS_TYPE, css: 'text/css; charset=utf-8' };
const STATIC_FILES = new Map([
  ['', { file: 'ui.html', type: HTML_TYPE }],
  ['ui.css', { file: 'ui.css', type: 'text/css; charset=utf-8' }],
  ['ui.js', { file: 'ui.js', type: JS_TYPE }],
  ['blocks.js', { file: 'blocks.js', type: JS_TYPE }],
  ['scenes.js', { file: 'scenes.js', type: JS_TYPE }],
]);
const SCENE_SEGMENT = 's';
const WORKSPACE_SEGMENT = 'workspace';
const WORKSPACE_DIR = path.join(WEB_DIR, 'builtin', WORKSPACE_SEGMENT);
const WORKSPACE_FILES = new Map([
  ['', { file: 'index.html', type: HTML_TYPE }],
  ['layout.js', { file: 'layout.js', type: JS_TYPE }],
  ['workspace.js', { file: 'workspace.js', type: JS_TYPE }],
  ['workspace.css', { file: 'workspace.css', type: 'text/css; charset=utf-8' }],
]);
// The workspace page is the server's own code (not model-written), so it may read /state and /events (same origin) and frame the
// scenes; each scene is still sandboxed by the CSP it is served with. Nothing else may load.
const WORKSPACE_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-src 'self'; img-src data:; base-uri 'none'; form-action 'none'";
// The global page is the server's own code: it reads only /global/state.json (same origin) and nothing may load besides its own files.
const GLOBAL_SEGMENT = 'global';
const GLOBAL_DIR = path.join(WEB_DIR, GLOBAL_SEGMENT);
const GLOBAL_STATE_FILE = 'state.json';
const GLOBAL_FILES = new Map([
  ['', { file: 'index.html', type: HTML_TYPE }],
  ['global.js', { file: 'global.js', type: JS_TYPE }],
  ['global.css', { file: 'global.css', type: 'text/css; charset=utf-8' }],
]);
const GLOBAL_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const NO_STORE = 'no-store';
const PORT_LINE_PREFIX = 'PORT ';
const EMPTY_STATE = Object.freeze({});
const USAGE = 'usage: node server.mjs <stateFile> [--token T] [--port P] [--root DIR]... [--kit DIR]\n';
const DEFAULT_KIT_DIR = path.join(WEB_DIR, 'kit');
// Safe on every response (the UI, its assets, /state, /events). Deliberately NO access-control-allow-origin here.
const BASE_HEADERS = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'cache-control': NO_STORE };
const SSE_HEADERS = {
  ...BASE_HEADERS,
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache, no-transform',
  connection: 'keep-alive',
};

function die(message, code = 2) {
  process.stderr.write(`${message}\n${code === 2 ? USAGE : ''}`);
  process.exit(code);
}

function parseArgs(argv) {
  const out = { stateFile: null, token: null, port: null, roots: [], kit: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--token' || a === '--port' || a === '--root' || a === '--kit') {
      const v = argv[++i];
      if (v === undefined) die(`${a} needs a value`);
      if (a === '--root') out.roots.push(v);
      else out[a.slice(2)] = v;
    } else if (a.startsWith('--')) {
      die(`unknown option ${a}`);
    } else if (out.stateFile === null) {
      out.stateFile = a;
    } else {
      die(`unexpected argument ${a}`);
    }
  }
  if (out.stateFile === null) die('missing <stateFile>');
  if (out.token !== null && !TOKEN_RE.test(out.token)) die('--token must be non-empty and URL-safe ([A-Za-z0-9._~-])');
  const rawPort = out.port ?? process.env[PORT_ENV];
  out.port = rawPort === undefined || rawPort === '' ? DEFAULT_PORT : Number(rawPort);
  if (!Number.isInteger(out.port) || out.port < 0 || out.port > MAX_PORT) die('--port must be an integer 0..65535');
  return out;
}

const args = parseArgs(process.argv.slice(2));
const stateFile = path.resolve(args.stateFile);
const token = args.token ?? crypto.randomBytes(TOKEN_BYTES).toString('hex');
const tokenBuf = Buffer.from(token);
// null = unrestricted; an array (possibly empty after dropping missing roots) = restricted: an empty one denies everything
const roots = args.roots.length === 0 ? null : args.roots.flatMap((r) => {
  try {
    return [fs.realpathSync(r)];
  } catch {
    process.stderr.write(`panel server: --root ${r} does not exist, ignoring it\n`);
    return [];
  }
});
const registry = createSceneRegistry({ stateFile, roots });
const kit = createKit({ dir: path.resolve(args.kit ?? DEFAULT_KIT_DIR), token });
// The panel's state folder is the one holding the state file (`<tmp>/claude-panel/`): the boards of the other sessions are in it.
const globalView = createGlobalView({ claudeDir: process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), stateDir: path.dirname(stateFile) });
let boundPort = 0;
let origin = '';
const eventHandler = createEventHandler({ registry, log: createEventLog(eventsFileFor(stateFile)), getOrigin: () => origin, headers: BASE_HEADERS });

// Last good state (raw, as written by the mod) and the JSON the page gets (scenes reduced). One string feeds /state and SSE.
let rawState = EMPTY_STATE;
let stateJson = JSON.stringify(EMPTY_STATE);
let lastSig = '';
const clients = new Set();

function publish() {
  const next = JSON.stringify(registry.publicState(rawState));
  if (next === stateJson) return;
  stateJson = next;
  const msg = `data: ${stateJson}\n\n`;
  for (const res of clients) res.write(msg);
}

function poll() {
  let st;
  try {
    st = fs.statSync(stateFile);
  } catch {
    st = null; // missing file: keep last good state (scene dirs below are still watched)
  }
  if (st && `${st.mtimeMs}:${st.size}` !== lastSig) {
    try {
      const obj = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      if (obj !== null && typeof obj === 'object' && !Array.isArray(obj)) {
        lastSig = `${st.mtimeMs}:${st.size}`;
        rawState = obj;
        registry.load(obj);
      } // partial/invalid: keep last good state, retry next tick (lastSig not advanced)
    } catch { /* partial write */ }
  }
  registry.refresh();
  publish();
}

function tokenMatches(candidate) {
  const buf = Buffer.from(candidate);
  return buf.length === tokenBuf.length && crypto.timingSafeEqual(buf, tokenBuf);
}

function hostAllowed(host) {
  const h = String(host || '').toLowerCase();
  return h === `${HOST}:${boundPort}` || h === `${LOCAL_NAME}:${boundPort}`;
}

const plain = (res, status, text, extra) => res.writeHead(status, { ...BASE_HEADERS, ...extra, 'content-type': TEXT_TYPE }).end(text);
const notFound = (res) => plain(res, 404, 'not found');

function sendStatic(req, res, asset) {
  fs.readFile(path.join(WEB_DIR, asset.file), (err, body) => {
    if (err) return plain(res, 500, `${asset.file} missing`);
    res.writeHead(200, { ...BASE_HEADERS, 'content-type': asset.type }).end(req.method === 'HEAD' ? undefined : body);
  });
}

// An asset the page references: a safe flat `.js`/`.css` name that ui.html names in a src/href attribute. The check
// reads ui.html per request, so the allow-list is exactly the page's own assets and nothing else in web/ is reachable.
function sendUiAsset(req, res, name) {
  const match = UI_ASSET_RE.exec(name);
  if (!match) return notFound(res);
  return fs.readFile(path.join(WEB_DIR, STATIC_FILES.get('').file), 'utf8', (err, html) => {
    if (err || !(html.includes(`src="${name}"`) || html.includes(`href="${name}"`))) return notFound(res);
    return sendStatic(req, res, { file: name, type: UI_ASSET_TYPES[match[1]] });
  });
}

function sendWorkspace(req, res, name) {
  const asset = WORKSPACE_FILES.get(name);
  if (!asset) return notFound(res);
  return fs.readFile(path.join(WORKSPACE_DIR, asset.file), (err, body) => {
    if (err) return plain(res, 500, `${asset.file} missing`);
    res.writeHead(200, { ...BASE_HEADERS, 'content-type': asset.type, 'content-security-policy': WORKSPACE_CSP }).end(req.method === 'HEAD' ? undefined : body);
  });
}

function sendGlobal(req, res, name) {
  const headers = { ...BASE_HEADERS, 'content-security-policy': GLOBAL_CSP };
  if (name === GLOBAL_STATE_FILE) {
    if (req.method === 'HEAD') return res.writeHead(200, { ...headers, 'content-type': 'application/json; charset=utf-8' }).end();
    return globalView.json().then(
      (json) => res.writeHead(200, { ...headers, 'content-type': 'application/json; charset=utf-8' }).end(json),
      () => plain(res, 500, 'global view failed', { 'content-security-policy': GLOBAL_CSP }),
    );
  }
  const asset = GLOBAL_FILES.get(name);
  if (!asset) return notFound(res);
  return fs.readFile(path.join(GLOBAL_DIR, asset.file), (err, body) => {
    if (err) return plain(res, 500, `${asset.file} missing`);
    res.writeHead(200, { ...headers, 'content-type': asset.type }).end(req.method === 'HEAD' ? undefined : body);
  });
}

function handle(req, res) {
  if (!hostAllowed(req.headers.host)) return plain(res, 421, 'misdirected request');
  if (typeof req.url !== 'string' || !req.url.startsWith('/')) return plain(res, 400, 'bad request');
  const rawPath = req.url.split(/[?#]/, 1)[0];
  const [, first, ...rest] = rawPath.split('/'); // rawPath starts with '/', so the leading item is ''
  if (!tokenMatches(first)) return notFound(res);
  if (rest.length === 1 && rest[0] === EVENT_SEGMENT) { // the only route that takes a body: its own method rules
    eventHandler(req, res);
    return undefined;
  }
  if (rest.length === 1 && rest[0] === HANDOVER_SEGMENT && req.method === 'POST' && req.headers[HANDOVER_HEADER] === encodeURIComponent(stateFile)) {
    return handover(res); // a newer server of the SAME session (same state file; another session's server never yields) wants the port: a custom header means a browser page cannot send it
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return plain(res, 405, 'method not allowed', { allow: 'GET, HEAD' });
  if (rest.length === 0) return plain(res, 308, '', { location: `/${token}/` }); // keep relative URLs working

  if (rest[0] === SCENE_SEGMENT && rest.length >= 2) {
    const id = rest[1];
    const scene = SCENE_ID_RE.test(id) ? registry.get(id) : undefined;
    if (!scene) return notFound(res);
    if (rest.length === 2) return plain(res, 308, '', { location: `/${token}/${SCENE_SEGMENT}/${id}/` });
    handleSceneRequest(req, res, { scene, restSegments: rest.slice(2), origin, roots, kit });
    return undefined;
  }
  if (rest[0] === WORKSPACE_SEGMENT) {
    if (rest.length === 1) return plain(res, 308, '', { location: `/${token}/${WORKSPACE_SEGMENT}/` });
    return rest.length === 2 ? sendWorkspace(req, res, rest[1]) : notFound(res);
  }
  if (rest[0] === GLOBAL_SEGMENT) {
    if (rest.length === 1) return plain(res, 308, '', { location: `/${token}/${GLOBAL_SEGMENT}/` }); // relative asset urls need the slash
    return rest.length === 2 ? sendGlobal(req, res, rest[1]) : notFound(res);
  }
  if (rest[0] === KIT_SEGMENT && rest.length >= 2) {
    kit.handle(req, res, rest.slice(1));
    return undefined;
  }
  if (rest.length > 1) return notFound(res);
  let name;
  try {
    name = decodeURIComponent(rest[0]);
  } catch {
    return notFound(res);
  }
  const asset = STATIC_FILES.get(name);
  if (asset) return sendStatic(req, res, asset);
  if (name === 'state') return res.writeHead(200, { ...BASE_HEADERS, 'content-type': 'application/json; charset=utf-8' }).end(stateJson);
  if (name === 'events') {
    res.writeHead(200, SSE_HEADERS);
    res.write(`data: ${stateJson}\n\n`);
    clients.add(res);
    const drop = () => clients.delete(res);
    req.on('close', drop);
    res.on('error', drop);
    return undefined;
  }
  return sendUiAsset(req, res, name);
}

// The older server of the same token (a mod reload starts the new one before the engine has stopped the old): it lets go of
// its port and quits, so the new server takes the SAME port and the link in the browser keeps working.
let activeServer = null;
function handover(res) {
  plain(res, 200, 'bye');
  setTimeout(() => {
    activeServer?.closeAllConnections();
    process.exit(0);
  }, HANDOVER_EXIT_MS);
  return undefined;
}

// Asks whoever holds `port` to hand it over. Only a server with this token answers (every other route is a 404); errors are ignored.
function askHandover(port) {
  const req = http.request({ host: HOST, port, path: `/${token}/${HANDOVER_SEGMENT}`, method: 'POST', headers: { host: `${HOST}:${port}`, [HANDOVER_HEADER]: encodeURIComponent(stateFile) }, timeout: HANDOVER_ASK_MS });
  req.on('error', () => {});
  req.on('timeout', () => req.destroy());
  req.end();
}

// Ports: `first`, then the next PORT_TRIES-1 ones, then whatever the OS gives us.
// The preferred port is tried FIRST_PORT_RETRIES times, FIRST_PORT_RETRY_MS apart, before the next one: the old server of this
// token is asked to hand it over (above), or may still be letting go of it anyway.
function listen(candidates, retries = FIRST_PORT_RETRIES) {
  const [port, ...more] = candidates;
  const server = http.createServer(handle);
  const onError = (err) => {
    if (err.code === 'EADDRINUSE' && retries > 0 && port !== ANY_PORT) {
      askHandover(port);
      return void setTimeout(() => listen(candidates, retries - 1), FIRST_PORT_RETRY_MS);
    }
    if (more.length === 0) die(`panel server: cannot listen (${err.message})`, 1);
    listen(more, 0);
  };
  server.once('error', onError);
  server.listen(port, HOST, () => {
    server.off('error', onError);
    activeServer = server;
    boundPort = server.address().port;
    origin = `http://${HOST}:${boundPort}`;
    poll();
    setInterval(poll, POLL_MS);
    setInterval(() => { for (const res of clients) res.write(':keepalive\n\n'); }, KEEPALIVE_MS);
    if (args.token === null) process.stderr.write(`panel server: ${origin}/${token}/\n`);
    process.stdout.write(`${PORT_LINE_PREFIX}${boundPort}\n`);
  });
}

const tries = args.port === ANY_PORT ? 0 : PORT_TRIES;
listen([
  ...Array.from({ length: tries }, (_, i) => args.port + i).filter((p) => p <= MAX_PORT),
  ANY_PORT,
]);
