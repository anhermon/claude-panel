#!/usr/bin/env node
// Renders the panel/ui catalog scene in the REAL panel server + headless Chrome and checks it (the visual test of the component kit):
//   node scripts/render-ui-catalog.mjs [--out DIR] [--sizes 1280x900,360x730] [--settle MS] [--scheme dark|light|both]
// Per size and colour scheme: a full-page PNG <out>/ui-catalog-<w>x<h>-<scheme>.png, console errors/exceptions/blocked requests (must be 0),
// horizontal overflow (must be none), smallest rendered text (>= MIN_FONT_PX), and at the first size the behaviours:
// rows survive ticks (updated in place, not re-created), a header click sorts, a bar hover shows a tooltip, and the form emits panel 'form' messages.
// Prints one JSON summary; exit code 1 on any failure. Needs Chrome (web/shot.mjs finds it).
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { blockNonLocal, cleanup, findChrome, isExecutable, launchChrome, sleep } from '../web/shot.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = join(ROOT, 'web', 'server.mjs');
const SCENE_DIR = join(ROOT, 'web', 'sample-scenes', 'ui-catalog');
const TOKEN = 't';
const SCENE_ID = 'ui-catalog';
const DEFAULT_SIZES = ['1280x900', '360x730'];
const SETTLE_MS = 4200;
const SERVER_START_MS = 8000;
const MIN_FONT_PX = 12.5;
const OVERFLOW_SLACK_PX = 1;
const PORT_LINE = /^PORT (\d+)/m;
const TILE_BELOW_WIDTH = 600;
const TILE_HEIGHT = 1100;
const SCHEMES = { dark: 'dark', light: 'light' };

function parseArgs(argv) {
  const o = { out: join(tmpdir(), 'panel-ui-catalog'), sizes: DEFAULT_SIZES, settle: SETTLE_MS, scheme: 'both' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') o.out = resolve(argv[++i]);
    else if (a === '--sizes') o.sizes = argv[++i].split(',');
    else if (a === '--settle') o.settle = Number(argv[++i]);
    else if (a === '--scheme') o.scheme = argv[++i];
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

// Audit run inside the page: smallest visible text, horizontal overflow.
const AUDIT = `(() => {
  let min = 999, who = '';
  for (const el of document.querySelectorAll('body *')) {
    if (!el.childNodes.length || ![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const px = parseFloat(cs.fontSize);
    if (px < min) { min = px; who = (el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className) + ' ' + el.textContent.trim().slice(0, 24); }
  }
  const de = document.documentElement;
  return { minFont: min, minFontWho: who, scrollWidth: de.scrollWidth, innerWidth: innerWidth, height: Math.max(de.scrollHeight, document.body.scrollHeight) };
})()`;

async function openPage(chrome, size, scheme, log, res) {
  await launchChrome(chrome, size, res);
  const cdp = res.cdp;
  for (const d of ['Page', 'Runtime', 'Log']) await cdp.send(`${d}.enable`);
  await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: size.width, height: size.height, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `window.__emits = []; addEventListener('message', (e) => { if (e.data && e.data.type === 'panel-emit') window.__emits.push(e.data); });` });
  cdp.on('Runtime.consoleAPICalled', (p) => { if (['error', 'assert'].includes(p.type)) log.errors.push(`console.${p.type}: ${(p.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 200)}`); });
  cdp.on('Runtime.exceptionThrown', (p) => log.errors.push((p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text ?? 'exception').split('\n')[0].slice(0, 200)));
  cdp.on('Log.entryAdded', (p) => { if (p.entry?.level === 'error') log.errors.push(`${p.entry.text} ${p.entry.url ?? ''}`.slice(0, 200)); });
  blockNonLocal(cdp, (url) => log.errors.push(`blocked non-local request ${url.slice(0, 80)}`));
  return cdp;
}

async function behaviours(cdp, log) {
  const out = {};
  // rows are updated in place: mark a row and a bar, wait for ticks, they must still be the same connected nodes
  await evalJs(cdp, `window.__row = document.querySelector('.ui-tbl tbody tr'); window.__bar = document.querySelector('.ui-chart rect.ui-mark'); 0`);
  await sleep(3400);
  out.rowsInPlace = await evalJs(cdp, `window.__row.isConnected && window.__bar.isConnected`);
  // sort: click the "Agent" header, first row must be alphabetically first
  await evalJs(cdp, `document.querySelector('.ui-tbl th button').click(); 0`);
  await sleep(200);
  out.sortedByName = await evalJs(cdp, `(() => { const names = [...document.querySelectorAll('.ui-tbl tbody tr td:first-child')].map((t) => t.textContent); return JSON.stringify(names) === JSON.stringify([...names].sort()); })()`);
  // tooltip: hover the first vertical bar
  const box = await evalJs(cdp, `(() => { const r = document.querySelectorAll('.ui-chart rect.ui-mark')[0].getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  await evalJs(cdp, `document.querySelectorAll('.ui-chart rect.ui-mark')[0].scrollIntoView({ block: 'center' }); 0`);
  await sleep(150);
  const box2 = await evalJs(cdp, `(() => { const r = document.querySelectorAll('.ui-chart rect.ui-mark')[0].getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box2.x ?? box.x, y: box2.y ?? box.y });
  await sleep(250);
  out.tooltipShown = await evalJs(cdp, `[...document.querySelectorAll('.ui-tip')].some((t) => !t.hidden && t.textContent.length > 0)`);
  // form: change the slider + toggle, expect 'form' emits with values
  await evalJs(cdp, `(() => { const s = document.querySelector('.ui-field[data-id=budget] input'); s.value = 75; s.dispatchEvent(new Event('input', { bubbles: true })); s.dispatchEvent(new Event('change', { bubbles: true }));
    const t = document.querySelector('.ui-field[data-id=auto] input'); t.click(); document.querySelector('.ui-btn[data-primary]').click(); })()`);
  await sleep(200);
  const emits = await evalJs(cdp, `window.__emits.filter((e) => e.name === 'form').map((e) => e.data)`);
  out.formEmits = emits.map((e) => `${e.on}:${e.field ?? e.button ?? ''}`);
  out.formValues = emits.at(-1)?.values;
  out.formOk = emits.length >= 3 && emits[0].on === 'change' && emits[0].values.budget === 75 && emits.at(-1).on === 'submit' && emits.at(-1).button === 'apply' && emits.every((e) => e.id === 'settings');
  if (!out.rowsInPlace) log.errors.push('rows were re-created instead of updated in place');
  return out;
}

const args = parseArgs(process.argv.slice(2));
mkdirSync(args.out, { recursive: true });
const work = mkdtempSync(join(tmpdir(), 'panel-ui-'));
const stateFile = join(work, 'state.json');
writeFileSync(stateFile, JSON.stringify({ v: 4, rev: 1, updatedAt: Date.now(), status: 'working', context: [], done: [], next: [], cards: [], labels: {},
  scenes: [{ id: SCENE_ID, title: 'ui-catalog', dir: SCENE_DIR, alt: 'panel/ui catalog', layout: 'card', height: 800, rev: 1, span: 3 }] }));
const chrome = findChrome({ env: process.env, exists: isExecutable, pathDirs: (process.env.PATH ?? '').split(delimiter).filter(Boolean) });
if (!chrome) { console.error('chrome not found'); process.exit(1); }
const schemes = args.scheme === 'both' ? Object.values(SCHEMES) : [args.scheme];
const results = [];
let server;
let failed = false;
try {
  server = await startServer(stateFile);
  const url = `http://127.0.0.1:${server.port}/${TOKEN}/s/${SCENE_ID}/`;
  for (const [si, sizeText] of args.sizes.entries()) {
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
        await sleep(600);
        const png = join(args.out, `ui-catalog-${sizeText}-${scheme}.png`);
        writeFileSync(png, Buffer.from((await cdp.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
        // narrow pages are tall: also write readable tiles <out>/ui-catalog-<size>-<scheme>-tN.png
        const tiles = [];
        if (width < TILE_BELOW_WIDTH) {
          for (let y = 0, n = 1; y < audit.height; y += TILE_HEIGHT, n++) {
            const tile = join(args.out, `ui-catalog-${sizeText}-${scheme}-t${n}.png`);
            const clip = { x: 0, y, width, height: Math.min(TILE_HEIGHT, audit.height - y), scale: 1 };
            writeFileSync(tile, Buffer.from((await cdp.send('Page.captureScreenshot', { format: 'png', clip })).data, 'base64'));
            tiles.push(tile);
          }
        }
        await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
        const r = { size: sizeText, scheme, png, tiles: tiles.length, pageHeight: audit.height, minFont: audit.minFont, minFontWho: audit.minFontWho, overflowX: audit.scrollWidth - audit.innerWidth > OVERFLOW_SLACK_PX };
        if (si === 0 && scheme === schemes[0]) r.behaviours = await behaviours(cdp, log);
        r.errors = log.errors;
        r.ok = log.errors.length === 0 && !r.overflowX && audit.minFont >= MIN_FONT_PX && (!r.behaviours || (r.behaviours.rowsInPlace && r.behaviours.sortedByName && r.behaviours.tooltipShown && r.behaviours.formOk));
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
