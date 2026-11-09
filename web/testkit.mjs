// Shared helpers for the web tests (not a test file itself): spawn the real server, send raw requests.
import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const HERE = dirname(fileURLToPath(import.meta.url));
export const SERVER = join(HERE, 'server.mjs');
export const TEST_TOKEN = 'testtoken0123456789';
const PORT_RE = /^PORT (\d+)$/m;
const ANY_PORT = '0';

/**
 * Starts `node server.mjs <stateFile> --token T --port 0 ...extraArgs`. `procs` collects children so the caller
 * can kill them in `after()`. Resolves once the PORT line appears.
 */
export async function startServer(stateFile, { procs = [], token = TEST_TOKEN, extraArgs = [], env = {} } = {}) {
  const args = [SERVER, stateFile, ...(token === null ? [] : ['--token', token]), '--port', ANY_PORT, ...extraArgs];
  const p = spawn(process.execPath, args, { env: { ...process.env, ...env } });
  procs.push(p);
  let out = '';
  let err = '';
  p.stderr.on('data', (d) => { err += d; });
  const port = await new Promise((resolve, reject) => {
    p.on('error', reject);
    p.on('exit', (c) => reject(new Error(`server exited ${c}: ${err}`)));
    p.stdout.on('data', (d) => { out += d; const m = PORT_RE.exec(out); if (m) resolve(Number(m[1])); });
  });
  const origin = `http://127.0.0.1:${port}`;
  return {
    port, origin, token, stdout: () => out, stderr: () => err,
    base: `${origin}/${token}`,
    kill: () => p.kill(),
    /** Raw request: the path reaches the server exactly as given (no URL normalisation by the client). */
    get: (path, opts) => rawRequest(port, path, opts),
    /** Same, below /<token>. */
    api: (path, opts) => rawRequest(port, `/${token}${path}`, opts),
  };
}

/** `headers`/`method`/`body` optional; `host` overrides the Host header. Resolves { status, headers, body: Buffer, text }. */
export function rawRequest(port, path, { method = 'GET', headers = {}, host, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers: { ...(host !== undefined ? { host } : {}), ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        resolve({ status: res.statusCode, headers: res.headers, body, text: body.toString('utf8') });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

/** First SSE message of `url` (full state on connect). */
export function firstSseMessage(port, path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path }, (res) => {
      let buf = '';
      res.on('data', (d) => {
        buf += d;
        const i = buf.indexOf('\n\n');
        if (i >= 0 && buf.startsWith('data: ')) { req.destroy(); resolve(buf.slice(0, i)); }
      });
    });
    req.on('error', (e) => { if (e.code !== 'ECONNRESET') reject(e); });
  });
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Writes `text` verbatim to a TCP socket (for requests the http client will not build) -> the response status code. */
export function socketStatus(port, text) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1', () => sock.write(text));
    let buf = '';
    sock.on('data', (d) => { buf += d; const m = /^HTTP\/1\.[01] (\d+)/.exec(buf); if (m) { sock.destroy(); resolve(Number(m[1])); } });
    sock.on('error', reject);
    sock.on('close', () => { if (!/^HTTP/.test(buf)) resolve(0); });
  });
}

export const KIT_MANIFEST = Object.freeze({
  version: 1,
  libs: [
    { id: 'three', version: '0.0.0', imports: { three: 'three/build/three.module.min.js' }, prefixes: { 'three/addons/': 'three/examples/jsm/' }, css: [] },
    { id: 'd3', version: '0.0.0', imports: { d3: 'd3/d3.mjs' }, prefixes: {}, css: [] },
    { id: 'plot', version: '0.0.0', imports: { '@observablehq/plot': 'plot/plot.min.js', plot: 'plot/plot.min.js' }, css: [] },
  ],
});
export const KIT_FIXTURE_FILES = Object.freeze({
  'three/build/three.module.min.js': 'export const THREE = 1;',
  'three/examples/jsm/controls/OrbitControls.js': 'export class OrbitControls {}',
  'd3/d3.mjs': 'export const d3 = 1;',
  'plot/plot.min.js': 'export const plot = 1;',
  'panel/panel.js': 'window.panel = { fixture: true, fit() {} };',
  'panel/panel.mjs': 'export default window.panel;',
  'panel/deck.js': 'export const deck = 1;',
  'panel/components.js': 'export const components = 1;',
  'diagrams/diagram.js': 'export const diagrams = 1;',
  'ui/index.js': 'export const ui = 1;',
  'assets/index.js': 'export const assets = 1;',
  'panel/panel.css': ':where(:root) { --kit: 1; }',
  'katex/fonts/k.woff2': 'wOF2',
  'page.html': '<p>kit page</p>',
  'notes.txt': 'not allowed in the kit',
  'three/build/three.module.min.js.map': '{}',
  'panel/.secret.js': 'SECRET',
});

/** Writes a small fixture kit (manifest + a few files) into `dir` and returns `dir`. `manifest` overrides the default. */
export function makeKitFixture(dir, { manifest = KIT_MANIFEST } = {}) {
  mkdirSync(dir, { recursive: true });
  if (manifest !== null) writeFileSync(join(dir, 'manifest.json'), typeof manifest === 'string' ? manifest : JSON.stringify(manifest));
  for (const [rel, text] of Object.entries(KIT_FIXTURE_FILES)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  return dir;
}

/** The importmap JSON of an HTML document (first `<script type="importmap">`), parsed; null if none. */
export function importMapOf(html) {
  const m = /<script type="importmap">([\s\S]*?)<\/script>/.exec(html);
  return m ? JSON.parse(m[1]) : null;
}

/** How many `<script type="importmap">` elements the document has. */
export const importMapCount = (html) => (html.match(/<script[^>]*type=["']?importmap/gi) || []).length;
