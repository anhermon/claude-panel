#!/usr/bin/env node
// Renders the panel/assets catalog scene in the REAL panel server + headless Chrome and checks it:
//   node scripts/render-assets-catalog.mjs [--out DIR] [--sizes 1280x900,360x730] [--scheme dark|light|both] [--only kind,kind] [--settle MS]
// Per size and colour scheme: PNG tiles <out>/assets-<w>x<h>-<scheme>-tN.png (the page cut into readable pieces), console errors (must be 0),
// horizontal overflow (none), smallest text (>= MIN_FONT_PX), asset error panels (none), and SVG text that falls outside its svg (none).
// Prints one JSON summary; exit 1 on any failure. Needs Chrome (web/shot.mjs finds it).
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { blockNonLocal, cleanup, findChrome, isExecutable, launchChrome, sleep } from '../web/shot.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = join(ROOT, 'web', 'server.mjs');
const SCENE_DIR = join(ROOT, 'web', 'sample-scenes', 'assets-catalog');
const TOKEN = 't';
const SCENE_ID = 'assets-catalog';
const DEFAULT_SIZES = ['1280x900', '360x730'];
const SETTLE_MS = 3500;
const SERVER_START_MS = 8000;
const MIN_FONT_PX = 12;
const OVERFLOW_SLACK_PX = 1;
const CLIP_SLACK_PX = 2;
const TILE_HEIGHT = 1100;
const PORT_LINE = /^PORT (\d+)/m;

function parseArgs(argv) {
  const o = { out: join(tmpdir(), 'panel-assets-catalog'), sizes: DEFAULT_SIZES, settle: SETTLE_MS, scheme: 'both', only: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') o.out = resolve(argv[++i]);
    else if (a === '--sizes') o.sizes = argv[++i].split(',');
    else if (a === '--settle') o.settle = Number(argv[++i]);
    else if (a === '--scheme') o.scheme = argv[++i];
    else if (a === '--only') o.only = argv[++i];
    else throw new Error(`unknown option ${a}`);
  }
  return o;
}

function startServer(stateFile) {
  const child = spawn(process.execPath, [SERVER, stateFile, '--token', TOKEN, '--port', '0'], { stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((ok, fail) => {
    let out = '';
    const timer = setTimeout(() => fail(new Error('server did not print PORT in time')), SERVER_START_MS);
    child.stdout.on('data', (d) => { out += d; const m = PORT_LINE.exec(out); if (m) { clearTimeout(timer); ok({ child, port: Number(m[1]) }); } });
    child.on('exit', (code) => fail(new Error(`server exited early (${code})`)));
  });
}

const evalJs = async (cdp, expression) => {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(`eval failed: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
};

const AUDIT = `(() => {
  let min = 999, who = '';
  for (const el of document.querySelectorAll('body *')) {
    if (![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const px = parseFloat(el.getAttribute('font-size')) || parseFloat(cs.fontSize);
    if (px < min) { min = px; who = el.textContent.trim().slice(0, 24); }
  }
  const errors = [...document.querySelectorAll('.pa-err')].map((e) => e.textContent.slice(0, 200));
  const clipped = [];
  for (const svg of document.querySelectorAll('.pa-stage > svg')) {
    const box = svg.getBoundingClientRect();
    const kind = svg.closest('.pa').dataset.kind;
    for (const t of svg.querySelectorAll('text')) {
      const r = t.getBoundingClientRect();
      if (!r.width) continue;
      if (r.left < box.left - ${CLIP_SLACK_PX} || r.right > box.right + ${CLIP_SLACK_PX} || r.top < box.top - ${CLIP_SLACK_PX} || r.bottom > box.bottom + ${CLIP_SLACK_PX}) clipped.push(kind + ': ' + t.textContent.trim().slice(0, 30));
    }
  }
  const kinds = [...document.querySelectorAll('.pa')].map((e) => e.dataset.kind);
  const de = document.documentElement;
  return { minFont: min, minFontWho: who, scrollWidth: de.scrollWidth, innerWidth, height: Math.max(de.scrollHeight, document.body.scrollHeight), errors, clipped, kinds };
})()`;

async function openPage(chrome, size, scheme, log, res) {
  await launchChrome(chrome, size, res);
  const cdp = res.cdp;
  for (const d of ['Page', 'Runtime', 'Log']) await cdp.send(`${d}.enable`);
  await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: size.width, height: size.height, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
  cdp.on('Runtime.consoleAPICalled', (p) => { if (['error', 'assert'].includes(p.type)) log.errors.push(`console.${p.type}: ${(p.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 200)}`); });
  cdp.on('Runtime.exceptionThrown', (p) => log.errors.push((p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text ?? 'exception').split('\n')[0].slice(0, 200)));
  cdp.on('Log.entryAdded', (p) => { if (p.entry?.level === 'error') log.errors.push(`${p.entry.text} ${p.entry.url ?? ''}`.slice(0, 200)); });
  blockNonLocal(cdp, (url) => log.errors.push(`blocked non-local request ${url.slice(0, 80)}`));
  return cdp;
}

const args = parseArgs(process.argv.slice(2));
mkdirSync(args.out, { recursive: true });
const work = mkdtempSync(join(tmpdir(), 'panel-assets-'));
const stateFile = join(work, 'state.json');
writeFileSync(stateFile, JSON.stringify({ v: 4, rev: 1, updatedAt: Date.now(), status: 'working', context: [], done: [], next: [], cards: [], labels: {},
  scenes: [{ id: SCENE_ID, title: 'assets-catalog', dir: SCENE_DIR, alt: 'panel/assets catalog', layout: 'card', height: 800, rev: 1, span: 3 }] }));
const chrome = findChrome({ env: process.env, exists: isExecutable, pathDirs: (process.env.PATH ?? '').split(delimiter).filter(Boolean) });
if (!chrome) { console.error('chrome not found'); process.exit(1); }
const schemes = args.scheme === 'both' ? ['dark', 'light'] : [args.scheme];
const results = [];
let server;
let failed = false;
try {
  server = await startServer(stateFile);
  const url = `http://127.0.0.1:${server.port}/${TOKEN}/s/${SCENE_ID}/${args.only ? `?only=${encodeURIComponent(args.only)}` : ''}`;
  for (const sizeText of args.sizes) {
    const [width, height] = sizeText.split('x').map(Number);
    for (const scheme of schemes) {
      const log = { errors: [] };
      const res = {};
      try {
        const cdp = await openPage(chrome, { width, height }, scheme, log, res);
        await cdp.send('Page.navigate', { url });
        await sleep(args.settle);
        const audit = await evalJs(cdp, AUDIT);
        await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: Math.ceil(audit.height), deviceScaleFactor: 1, mobile: false });
        await sleep(500);
        const tiles = [];
        for (let y = 0, n = 1; y < audit.height; y += TILE_HEIGHT, n++) {
          const tile = join(args.out, `assets-${sizeText}-${scheme}-t${n}.png`);
          const clip = { x: 0, y, width, height: Math.min(TILE_HEIGHT, audit.height - y), scale: 1 };
          writeFileSync(tile, Buffer.from((await cdp.send('Page.captureScreenshot', { format: 'png', clip })).data, 'base64'));
          tiles.push(tile);
        }
        const r = { size: sizeText, scheme, tiles, pageHeight: audit.height, kinds: audit.kinds.length, minFont: audit.minFont, minFontWho: audit.minFontWho,
          overflowX: audit.scrollWidth - audit.innerWidth > OVERFLOW_SLACK_PX, assetErrors: audit.errors, clipped: audit.clipped, errors: log.errors };
        r.ok = !log.errors.length && !r.overflowX && audit.minFont >= MIN_FONT_PX && !audit.errors.length && !audit.clipped.length;
        results.push(r);
        if (!r.ok) failed = true;
      } finally {
        await cleanup(res);
      }
    }
  }
} finally {
  server?.child.kill();
  rmSync(work, { recursive: true, force: true });
}
console.log(JSON.stringify({ ok: !failed, results }, null, 2));
process.exit(failed ? 1 : 0);
