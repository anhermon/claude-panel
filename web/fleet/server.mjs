#!/usr/bin/env node
// Fleet web server: ONE always-on local process that shows every Claude Code session on this machine. Zero dependencies.
//
//   node web/fleet/server.mjs [--port P] [--feed external]
//
// Binds 127.0.0.1 only. The URL token is read from <stateDir>/token (0600, never on argv); every route is /<token>/....
// A Host other than 127.0.0.1:<port> / localhost:<port> is 421 (DNS rebinding). stdout carries one line, `PORT <n>`.
//   GET  /                   the page          GET /<asset>      allow-listed page files (web/fleet/page) and kit/ui/{core,pure}.js
//   GET  /state              state JSON        GET /events       SSE: the state on connect and at every change / heartbeat
//   GET  /session/<id>       drill-down: ?before=<n>&limit=<n> -> { session, events[], next, metrics }
//   POST /send               {sessionId, text} -> {id}   (JSON only; Origin must match; queued for the mod's hub)
//   GET  /result/<id>        {status: pending|queued|refused|failed, reason}
// Everything shown comes from state.json / transcripts after secret masking; the page builds DOM from text nodes only and
// a CSP forbids inline script, so transcript text can never run as code.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DIR_MODE, FILE_MODE, fleetConfig } from './config.mjs';
import { createFeed } from './feed.mjs';
import { pageOf, readEvents } from './detail.mjs';
import { bucketList } from './transcript.mjs';
import { checkSend, enqueue, readResult } from './commands.mjs';
import { isSessionId } from './registry.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PAGE_DIR = path.join(HERE, 'page');
const KIT_UI_DIR = path.join(HERE, '..', 'kit', 'ui');
const KIT_UI_FILES = new Set(['core.js', 'pure.js']);
const KIND_META_FILE = path.join(HERE, '..', 'builtin', 'board', 'kind-meta.mjs');
const HUB_FRESH_MS = 15000; // the hub rewrites hub.json every few seconds; older than this it is offline
const ASSET_RE = /^[a-z0-9][a-z0-9-]*\.(js|css)$/;
const TYPES = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', json: 'application/json; charset=utf-8' };
const TOKEN_RE = /^[A-Za-z0-9._~-]{16,}$/;
const TOKEN_BYTES = 24;
const MAX_PORT = 65535;
const PORT_LINE = 'PORT ';
const NO_STORE = 'no-store';
const DETAIL_LIMIT_MAX = 600;
// The page is our own code. Styles may be inline (the kit injects a <style>), scripts never.
const PAGE_CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const BASE = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'cache-control': NO_STORE, 'cross-origin-resource-policy': 'same-origin' };

const cfg = fleetConfig();

function readOrMintToken() {
  try {
    const t = fs.readFileSync(cfg.tokenFile, 'utf8').trim();
    if (TOKEN_RE.test(t)) return t;
  } catch { /* none yet */ }
  const t = crypto.randomBytes(TOKEN_BYTES).toString('hex');
  fs.mkdirSync(cfg.stateDir, { recursive: true, mode: DIR_MODE });
  fs.writeFileSync(cfg.tokenFile, `${t}\n`, { mode: FILE_MODE });
  return t;
}

export function createFleetServer({ cfg: c = cfg, token, feed, log = () => {} }) {
  const tokenBuf = Buffer.from(token);
  const clients = new Set();
  const state = { port: 0 };
  const origin = () => `http://${c.host}:${state.port}`;

  const tokenOk = (cand) => { const b = Buffer.from(cand ?? ''); return b.length === tokenBuf.length && crypto.timingSafeEqual(b, tokenBuf); };
  const hostOk = (host) => { const h = String(host ?? '').toLowerCase(); return h === `${c.host}:${state.port}` || h === `localhost:${state.port}`; };
  const send = (res, status, body, type = 'text/plain; charset=utf-8', extra = {}) => res.writeHead(status, { ...BASE, ...extra, 'content-type': type }).end(body);
  const json = (res, status, obj) => send(res, status, JSON.stringify(obj), TYPES.json);

  function hubInfo() {
    try {
      const h = JSON.parse(fs.readFileSync(c.hubFile, 'utf8'));
      return { online: Date.now() - h.ts < HUB_FRESH_MS, sessionId: typeof h.sessionId === 'string' ? h.sessionId : null };
    } catch { return { online: false, sessionId: null }; }
  }
  const publicState = () => ({ ...feed.state, hub: hubInfo(), limits: { messageMaxChars: c.messageMaxChars, resultWaitMs: c.resultWaitMs } });

  function pushState() {
    const msg = `data: ${JSON.stringify(publicState())}\n\n`;
    for (const res of clients) res.write(msg);
  }

  function sendFile(req, res, file, type, extra = {}) {
    fs.readFile(file, (err, body) => (err ? send(res, 404, 'not found') : res.writeHead(200, { ...BASE, ...extra, 'content-type': type }).end(req.method === 'HEAD' ? undefined : body)));
  }

  function detail(res, id, query) {
    const session = feed.state.sessions.find((s) => s.id === id);
    const file = feed.fileOf(id);
    if (session === undefined || file === null) return send(res, 404, 'unknown session');
    const before = query.get('before') === null ? undefined : Number(query.get('before'));
    const limit = Math.min(Math.max(Number(query.get('limit')) || c.detailPageSize, 1), DETAIL_LIMIT_MAX);
    try {
      const { events, isPartial } = readEvents(file, c);
      const tr = feed.trackers.get(id);
      const page = pageOf(events, before, limit);
      return json(res, 200, {
        session, ...page, isPartial,
        metrics: tr === undefined ? null : { tokens: bucketList(tr.acc), bucketMs: c.bucketMs, toolMix: tr.acc.tools.byName, kinds: tr.acc.tools.byKind, turns: tr.acc.turns },
      });
    } catch (err) { return send(res, 500, `cannot read the transcript (${err.code ?? 'error'})`); }
  }

  function postSend(req, res) {
    const ct = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    const org = req.headers.origin;
    if (ct !== 'application/json') return json(res, 415, { ok: false, reason: 'content-type must be application/json' });
    if (org !== undefined && org !== origin()) return json(res, 403, { ok: false, reason: 'cross-origin request refused' });
    const chunks = [];
    let size = 0;
    let isOver = false;
    req.on('data', (d) => {
      if (isOver) return;
      size += d.length;
      if (size <= c.commandBodyMaxBytes) { chunks.push(d); return; }
      isOver = true; // answer at once, then drop the connection: the rest of the body is never read into memory
      chunks.length = 0;
      res.on('finish', () => req.destroy());
      send(res, 413, JSON.stringify({ ok: false, reason: 'body too large' }), TYPES.json, { connection: 'close' });
    });
    req.on('error', () => {});
    req.on('end', () => {
      if (isOver) return undefined;
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return json(res, 400, { ok: false, reason: 'body is not JSON' }); }
      const checked = checkSend(body, feed.state, c);
      if (!checked.ok) return json(res, 422, checked);
      if (!hubInfo().online) return json(res, 503, { ok: false, reason: 'no hub is online: a Claude Code session with the panel mod loaded must be running to deliver messages' });
      const queued = enqueue(c, checked.session, checked.text);
      return json(res, queued.ok ? 202 : 503, queued);
    });
  }

  function handle(req, res) {
    if (!hostOk(req.headers.host)) return send(res, 421, 'misdirected request');
    if (typeof req.url !== 'string' || !req.url.startsWith('/')) return send(res, 400, 'bad request');
    const [rawPath, rawQuery = ''] = req.url.split('#', 1)[0].split('?');
    const [, first, ...rest] = rawPath.split('/');
    if (!tokenOk(first)) return send(res, 404, 'not found');
    const isPost = req.method === 'POST';
    if (!isPost && req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'method not allowed', undefined, { allow: 'GET, HEAD, POST' });
    if (isPost) return rest.length === 1 && rest[0] === 'send' ? postSend(req, res) : send(res, 404, 'not found');
    if (rest.length === 0) return send(res, 308, '', undefined, { location: `/${token}/` });
    const query = new URLSearchParams(rawQuery);
    const [name, arg, ...more] = rest;
    if (name === '' && rest.length === 1) return sendFile(req, res, path.join(PAGE_DIR, 'index.html'), TYPES.html, { 'content-security-policy': PAGE_CSP });
    if (name === 'state' && rest.length === 1) return json(res, 200, publicState());
    if (name === 'events' && rest.length === 1) {
      res.writeHead(200, { ...BASE, 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive' });
      res.write(`data: ${JSON.stringify(publicState())}\n\n`);
      clients.add(res);
      const drop = () => clients.delete(res);
      req.on('close', drop); res.on('error', drop);
      return undefined;
    }
    if (name === 'session' && arg !== undefined && more.length === 0) return isSessionId(arg) ? detail(res, arg.toLowerCase(), query) : send(res, 404, 'not found');
    if (name === 'result' && arg !== undefined && more.length === 0) { const r = readResult(c, arg); return r === null ? send(res, 404, 'not found') : json(res, 200, r); }
    if (name === 'kit' && arg === 'ui' && more.length === 1 && KIT_UI_FILES.has(more[0])) return sendFile(req, res, path.join(KIT_UI_DIR, more[0]), TYPES.js);
    if (name === 'kind-meta.js' && rest.length === 1) return sendFile(req, res, KIND_META_FILE, TYPES.js);
    if (rest.length === 1 && ASSET_RE.test(name)) return sendFile(req, res, path.join(PAGE_DIR, name), TYPES[name.split('.').pop()]);
    return send(res, 404, 'not found');
  }

  const server = http.createServer(handle);
  const keepalive = setInterval(() => { for (const res of clients) res.write(':keepalive\n\n'); }, c.keepaliveMs);
  keepalive.unref();
  return {
    server, handle, pushState, origin,
    listen(first) {
      const candidates = [...Array.from({ length: first === 0 ? 0 : c.portTries }, (_, i) => first + i).filter((p) => p <= MAX_PORT), 0];
      return new Promise((resolve, reject) => {
        const attempt = (rest) => {
          const [port, ...more] = rest;
          const onError = (err) => (more.length === 0 ? reject(err) : attempt(more));
          server.once('error', onError);
          server.listen(port, c.host, () => { server.off('error', onError); state.port = server.address().port; resolve(state.port); });
        };
        attempt(candidates);
      });
    },
    close() { clearInterval(keepalive); for (const res of clients) res.end(); server.close(); },
  };
}

function lastPort() {
  try { return JSON.parse(fs.readFileSync(cfg.infoFile, 'utf8')).port; } catch { return null; }
}

async function main() {
  const argv = process.argv.slice(2);
  const portArg = argv[argv.indexOf('--port') + 1];
  const external = argv.includes('--feed') && argv[argv.indexOf('--feed') + 1] === 'external';
  const token = readOrMintToken();
  const feed = createFeed({ cfg });
  const app = createFleetServer({ cfg, token, feed });
  feed.onState = () => app.pushState();
  const first = argv.includes('--port') ? Number(portArg) : (Number.isInteger(lastPort()) ? lastPort() : cfg.defaultPort);
  const port = await app.listen(first);
  fs.mkdirSync(cfg.stateDir, { recursive: true, mode: DIR_MODE });
  fs.writeFileSync(cfg.pidFile, `${process.pid}\n`, { mode: FILE_MODE });
  fs.writeFileSync(cfg.infoFile, JSON.stringify({ pid: process.pid, port, startedAt: Date.now() }), { mode: FILE_MODE });
  const shutdown = () => { try { fs.rmSync(cfg.pidFile, { force: true }); } catch { /* gone */ } app.close(); feed.stop(); process.exit(0); };
  process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
  if (!external) feed.start();
  process.stdout.write(`${PORT_LINE}${port}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((err) => { process.stderr.write(`fleet server: ${err.message}\n`); process.exit(1); });
}
