#!/usr/bin/env node
// Renders the Board scene in the REAL panel server + headless Chrome, once per fixture and size, and checks it:
//   node scripts/render-board.mjs [fixture ...] [--all] [--out DIR] [--sizes 720x1600,960x540] [--settle MS] [--scroll-to top|bottom|PX]
// For each fixture (default: busy sparse empty portrait; --all: every one in web/builtin/board/fixtures) and size
// (default: portrait 720x1600 and 600x1300, landscape 960x540 and 1920x1080) it writes <out>/<fixture>-<w>x<h>.png and
//   - counts console errors / exceptions / blocked requests (must be 0),
//   - takes every frame's picture twice, JIGGLE_GAP_MS apart: static frame types must be pixel-identical (no jitter);
//     animated parts (now dot, avatar, diagram flow, lanes shimmer, pulse, steps doing) are reported as changed or not,
//   - audits the page: no scrolling, no frame body overflowing, smallest rendered text >= 14 px (13 px on a portrait
//     pane up to 720 wide; scaled up on wider panes; SVG text through its screen transform), headline text >= 28 px,
//   - checks that there is no `+N more` chip (a board with more frames than fit scrolls instead, with a "3/8" position cue and
//     a bottom fade while there is more below; `--scroll-to` scrolls the board first and names the picture ...-scroll-<to>.png)
//     and that no chip flashes while a bigger data file is queued in (the sparse -> busy transition).
// With `live` among the fixtures-independent checks it also rewrites busy's data once and verifies only that frame moved.
// Prints one JSON summary on stdout; exit code 1 on any failure. Needs Chrome (web/shot.mjs finds it).
import { inflateSync } from 'node:zlib';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';

import { installBoard, readFixture, writeData, FIXTURES_DIR } from '../web/builtin/board/seed-board.mjs';
import { blockNonLocal, cleanup, findChrome, isExecutable, launchChrome, sleep } from '../web/shot.mjs';
import { startServer } from '../web/testkit.mjs';

const DEFAULT_SIZES = ['720x1600', '600x1300', '960x540', '1920x1080'];
const DEFAULT_FIXTURES = ['busy', 'sparse', 'empty', 'portrait'];
const PORTRAIT_BELOW = 0.8; // board-logic PORTRAIT_BELOW
const PORTRAIT_REF_W = 720;
const LANDSCAPE_REF_W = 960;
const QUEUE_WATCH_MS = 9000;
const QUEUE_POLL_MS = 120;
const SCROLL_SETTLE_MS = 900;
const SETTLE_MS = 4200;
const JIGGLE_GAP_MS = 1000;
const MIN_FONT_PX = 14;
const MIN_FONT_PORTRAIT_PX = 13;
const MIN_HEADLINE_PX = 28;
const OVERFLOW_SLACK_PX = 2;
const LIVE_SETTLE_MS = 2600;
const ANIMATED_TYPES = new Set(['now', 'avatar', 'diagram', 'lanes', 'pulse', 'uml', 'doing']);
const OWN_VIEW_TYPES = new Set(['uml']); // a diagram has its own zoom and pan: the text floor and the clipping of its drawing are not the board's to judge
const STATIC_TYPES = new Set(['text', 'metric', 'rings', 'bars', 'line', 'compare', 'ask', 'timeline', 'image', 'html', 'swimlane', 'kindstack', 'sinks', 'repeats', 'hints', 'tickets', 'checks', 'unsupported']);

// Jitter compares decoded pixels with a tolerance: gradient dithering on fractional-pixel rects flips single pixels by 1.
const PNG_SIGNATURE_BYTES = 8;
const PIXEL_TOLERANCE = 3;
function decodePng(b64) {
  const d = Buffer.from(b64, 'base64');
  const parts = [];
  let w = 0, bpp = 4, pos = PNG_SIGNATURE_BYTES;
  while (pos < d.length) {
    const n = d.readUInt32BE(pos), type = d.toString('ascii', pos + 4, pos + 8);
    if (type === 'IHDR') { w = d.readUInt32BE(pos + 8); bpp = d[pos + 17] === 6 ? 4 : 3; }
    if (type === 'IDAT') parts.push(d.subarray(pos + 8, pos + 8 + n));
    pos += 12 + n;
  }
  const raw = inflateSync(Buffer.concat(parts)), stride = w * bpp, rows = raw.length / (stride + 1);
  const out = Buffer.alloc(stride * rows);
  for (let y = 0; y < rows; y++) {
    const f = raw[y * (stride + 1)], src = y * (stride + 1) + 1, dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[dst + x - bpp] : 0, b = y ? out[dst - stride + x] : 0, c = x >= bpp && y ? out[dst - stride + x - bpp] : 0;
      const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
      const pred = [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][f];
      out[dst + x] = (raw[src + x] + pred) & 255;
    }
  }
  return out;
}
const sha = decodePng;
const samePixels = (a, b) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= PIXEL_TOLERANCE);

function parseArgs(argv) {
  const o = { names: [], all: false, out: join(tmpdir(), 'panel-board'), sizes: DEFAULT_SIZES, settle: SETTLE_MS, scrollTo: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') o.out = resolve(argv[++i]);
    else if (a === '--sizes') o.sizes = argv[++i].split(',');
    else if (a === '--settle') o.settle = Number(argv[++i]);
    else if (a === '--scroll-to') o.scrollTo = argv[++i];
    else if (a === '--all') o.all = true;
    else if (a.startsWith('--')) throw new Error(`unknown option ${a}`);
    else o.names.push(a);
  }
  return o;
}

// ---- the audit that runs inside the page ------------------------------------------------------------------------------
/* eslint-disable no-undef */
const AUDIT_SOURCE = `(() => {
  const MIN_SLACK = ${OVERFLOW_SLACK_PX};
  const out = { scrolls: document.documentElement.scrollHeight > innerHeight + 1 || document.documentElement.scrollWidth > innerWidth + 1, frames: [] };
  const px = (el) => {
    const cs = getComputedStyle(el);
    const fs = parseFloat(cs.fontSize);
    if (el instanceof SVGElement && el.getScreenCTM) { const m = el.getScreenCTM(); return m ? fs * Math.hypot(m.a, m.b) : fs; }
    return fs;
  };
  const hasOwnText = (el) => [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim() !== '');
  for (const el of document.querySelectorAll('.frame:not([hidden]):not(.leaving)')) {
    const r = el.getBoundingClientRect();
    const layer = el.querySelector('.layer:not(.fade-out)');
    const fb = el.querySelector('.fb').getBoundingClientRect();
    let min = Infinity; let minText = ''; let headline = Infinity; let clipped = [];
    for (const t of el.querySelectorAll('*')) {
      if (!hasOwnText(t)) continue;
      const cs = getComputedStyle(t);
      if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) continue;
      if (t.closest('.fade-out, .bubble[data-empty="true"]') || t.classList.contains('ft-title') || t.classList.contains('unsupported') || t.closest('.unsupported')) continue;
      const size = px(t);
      if (size < min) { min = size; minText = t.textContent.trim().slice(0, 24); }
      if (t.classList.contains('metric-value') || (t.classList.contains('text-main') && t.closest('.text')?.dataset.len !== 'long' && t.dataset.shrunk !== 'true')) headline = Math.min(headline, size);
      const b = t.getBoundingClientRect();
      if (b.width > 0 && (b.right > fb.right + MIN_SLACK || b.left < fb.left - MIN_SLACK || b.bottom > fb.bottom + MIN_SLACK || b.top < fb.top - MIN_SLACK)) clipped.push(t.textContent.trim().slice(0, 24));
    }
    const ft = el.querySelector('.ft-title'); const ftSize = ft && ft.textContent ? px(ft) : null;
    out.frames.push({ id: el.dataset.id, type: el.dataset.type, size: el.dataset.size, rect: { x: r.x, y: r.y, w: r.width, h: r.height },
      overflow: layer ? (layer.scrollHeight > layer.clientHeight + MIN_SLACK || layer.scrollWidth > layer.clientWidth + MIN_SLACK) : false, scroll: layer ? [layer.scrollWidth, layer.clientWidth, layer.scrollHeight, layer.clientHeight] : null,
      minFont: min === Infinity ? null : Math.round(min * 10) / 10, minText, headline: headline === Infinity ? null : Math.round(headline), titleFont: ftSize, clipped: clipped.slice(0, 4) });
  }
  const board = document.getElementById('board');
  out.cue = { mode: document.documentElement.dataset.mode, scrollTop: Math.round(board.scrollTop), max: board.scrollHeight - board.clientHeight, pos: document.getElementById('pos').hidden ? '' : document.getElementById('pos').textContent, fade: !document.getElementById('fade').hidden };
  out.more = document.getElementById('more').hidden ? 0 : document.getElementById('more').textContent;
  out.empty = !document.getElementById('empty').hidden;
  return out;
})()`;

// ---- driving Chrome ----------------------------------------------------------------------------------------------------
async function openPage(chrome, size) {
  const res = {};
  const log = { errors: [], console: [] };
  await launchChrome(chrome, size, res);
  const cdp = res.cdp;
  for (const d of ['Page', 'Runtime', 'Log']) await cdp.send(`${d}.enable`);
  await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: size.width, height: size.height, deviceScaleFactor: 1, mobile: false });
  cdp.on('Runtime.consoleAPICalled', (p) => {
    if (p.type === 'error' || p.type === 'warning') log.console.push(`${p.type}: ${(p.args ?? []).map((a) => a.value ?? a.description ?? a.type).join(' ').slice(0, 200)}`);
  });
  cdp.on('Runtime.exceptionThrown', (p) => log.errors.push((p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text ?? 'exception').split('\n')[0].slice(0, 200)));
  cdp.on('Log.entryAdded', (p) => { if (p.entry?.level === 'error') log.errors.push(`${p.entry.text} ${p.entry.url ?? ''}`.slice(0, 200)); });
  blockNonLocal(cdp, (url) => log.errors.push(`blocked non-local request ${url.slice(0, 80)}`));
  return { res, cdp, log };
}

const shot = async (cdp, clip) => (await cdp.send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip: { ...clip, scale: 1 } } : {}) })).data;
const evalJs = async (cdp, expression) => (await cdp.send('Runtime.evaluate', { expression, returnByValue: true })).result.value;

async function checkOne(chrome, base, name, sizeText, args, png, mutate) {
  const [width, height] = sizeText.split('x').map(Number);
  const { res, cdp, log } = await openPage(chrome, { width, height });
  try {
    await cdp.send('Page.navigate', { url: `${base}/s/${name}/` });
    await sleep(args.settle);
    if (args.scrollTo) {
      const to = args.scrollTo === 'top' ? '0' : args.scrollTo === 'bottom' ? 'b.scrollHeight' : String(Number(args.scrollTo));
      await evalJs(cdp, `(() => { const b = document.getElementById('board'); b.scrollTop = ${to}; return b.scrollTop; })()`);
      await sleep(SCROLL_SETTLE_MS);
    }
    const audit = await evalJs(cdp, AUDIT_SOURCE);
    const inView = (f) => f.rect.y >= 0 && f.rect.y + f.rect.h <= height + 1; // a scrolled board has frames out of the picture: only the visible ones are compared
    audit.frames = audit.frames.filter(inView);
    writeFileSync(png, Buffer.from(await shot(cdp), 'base64'));
    const first = new Map();
    for (const f of audit.frames) first.set(f.id, sha(await shot(cdp, { x: f.rect.x, y: f.rect.y, width: f.rect.w, height: f.rect.h })));
    await sleep(JIGGLE_GAP_MS);
    const issues = [];
    const frames = [];
    const portrait = width / height < PORTRAIT_BELOW;
    const floor = portrait
      ? { text: MIN_FONT_PORTRAIT_PX * Math.max(1, width / PORTRAIT_REF_W), headline: MIN_HEADLINE_PX }
      : { text: MIN_FONT_PX * Math.max(1, width / LANDSCAPE_REF_W), headline: MIN_HEADLINE_PX * Math.max(1, width / LANDSCAPE_REF_W) };
    if (audit.more) issues.push(`unexpected more chip "${audit.more}"`);
    const cue = audit.cue;
    if (cue.mode === 'scroll') {
      if (cue.max > 0 && !/^\d+\/\d+$/.test(cue.pos)) issues.push(`scroll mode without a position cue ("${cue.pos}")`);
      if (cue.fade !== cue.max - cue.scrollTop > 4) issues.push(`bottom fade is ${cue.fade} at ${cue.scrollTop}/${cue.max}`);
    } else if (cue.pos || cue.fade) issues.push('fit mode shows a scroll cue');
    for (const f of audit.frames) {
      const grab = async () => sha(await shot(cdp, { x: f.rect.x, y: f.rect.y, width: f.rect.w, height: f.rect.h }));
      const second = await grab();
      const stat = STATIC_TYPES.has(f.type);
      // a frame that was still settling (slow machine) differs once; real jitter differs on every sample
      let changed = !samePixels(second, first.get(f.id));
      if (changed && stat) { await sleep(JIGGLE_GAP_MS); changed = !samePixels(await grab(), second); }
      if (stat && changed) issues.push(`${f.id} (${f.type}) is static but its pixels changed (jitter)`);
      if (f.overflow) issues.push(`${f.id} body overflows (scrollW,clientW,scrollH,clientH ${f.scroll})`);
      if (OWN_VIEW_TYPES.has(f.type)) { frames.push({ id: f.id, type: f.type, size: f.size, changedIn1s: changed, animatedExpected: true, minFont: f.minFont, headline: f.headline, titleFont: f.titleFont }); continue; }
      if (f.clipped.length) issues.push(`${f.id} text outside its body: ${f.clipped.join(' | ')}`);
      if (f.minFont !== null && f.minFont < floor.text - 0.2) issues.push(`${f.id} smallest text ${f.minFont}px, floor ${floor.text} ("${f.minText}")`);
      if (f.headline !== null && f.headline < floor.headline - 0.5) issues.push(`${f.id} headline ${f.headline}px, floor ${floor.headline}`);
      frames.push({ id: f.id, type: f.type, size: f.size, changedIn1s: changed, animatedExpected: ANIMATED_TYPES.has(f.type), minFont: f.minFont, headline: f.headline, titleFont: f.titleFont });
    }
    if (audit.scrolls) issues.push('page scrolls');
    let live = null;
    if (mutate) live = await mutate(cdp, audit);
    return { png, consoleErrors: [...log.errors, ...log.console], issues, more: audit.more, cue, empty: audit.empty, frames, live };
  } finally {
    await cleanup(res);
  }
}

// ---- the live-update check: change one frame's data, only that frame may move ---------------------------------------------
function liveMutation(scene) {
  return async (cdp, audit) => {
    const quiet = audit.frames.filter((f) => STATIC_TYPES.has(f.type) && f.id !== 'p95');
    const before = new Map();
    for (const f of audit.frames) before.set(f.id, sha(await shot(cdp, { x: f.rect.x, y: f.rect.y, width: f.rect.w, height: f.rect.h })));
    const data = readFixture('busy');
    data.frames.find((f) => f.id === 'p95').value = '2,010 ms';
    writeData(scene, data);
    await sleep(LIVE_SETTLE_MS);
    const moved = [];
    for (const f of audit.frames) {
      const now = sha(await shot(cdp, { x: f.rect.x, y: f.rect.y, width: f.rect.w, height: f.rect.h }));
      if (!samePixels(now, before.get(f.id))) moved.push(f.id);
    }
    const stillStatic = quiet.every((f) => !moved.includes(f.id));
    writeData(scene, readFixture('busy')); // leave the scene as it was, later sizes start from the fixture
    return { changedFrame: 'p95', movedFrames: moved, p95Moved: moved.includes('p95'), otherStaticFramesStill: stillStatic };
  };
}

// ---- the queue check: sparse -> busy adds frames one by one; the `+N more` chip must never flash for frames still coming --
function queueMoreCheck(scene) {
  return async (cdp) => {
    writeData(scene, readFixture('busy'));
    const seen = new Set();
    for (let t = 0; t < QUEUE_WATCH_MS; t += QUEUE_POLL_MS) {
      await sleep(QUEUE_POLL_MS);
      const chip = await evalJs(cdp, `(() => { const m = document.getElementById('more'); return m.hidden ? '' : m.textContent; })()`);
      if (chip) seen.add(chip);
    }
    const shown = await evalJs(cdp, `document.querySelectorAll('.frame:not([hidden]):not(.leaving)').length`);
    return { chipsSeen: [...seen], framesShown: shown, ok: seen.size === 0 };
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const all = readdirSync(FIXTURES_DIR).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort();
  const names = args.names.length ? args.names : args.all ? all : DEFAULT_FIXTURES;
  mkdirSync(args.out, { recursive: true });
  const work = mkdtempSync(join(tmpdir(), 'board-render-'));
  const chrome = findChrome({ env: process.env, exists: isExecutable, pathDirs: (process.env.PATH ?? '').split(delimiter).filter(Boolean) });
  if (!chrome) throw new Error('chrome not found');
  const scenes = names.map((name) => {
    const dir = join(work, name);
    installBoard(dir);
    writeData(dir, readFixture(name));
    return { id: name.slice(0, 24), title: name, layout: 'stage', span: 3, height: 540, alt: `Board ${name}`, rev: 1, dir, entry: 'index.html', builtin: true };
  });
  const stateFile = join(work, 'state.json');
  writeFileSync(stateFile, JSON.stringify({ v: 4, rev: 1, updatedAt: 1, url: null, status: 'working', task: { title: 'Board', why: 'render' }, context: [], done: [], next: [], cards: [], choices: [], scenes }));
  const procs = [];
  const summary = { out: args.out, fixtures: {}, failures: [] };
  try {
    const server = await startServer(stateFile, { procs, extraArgs: ['--root', work] });
    for (const s of scenes) {
      summary.fixtures[s.id] = {};
      for (const size of args.sizes) {
        const png = join(args.out, `${s.id}-${size}${args.scrollTo ? `-scroll-${args.scrollTo}` : ''}.png`);
        const first = size === args.sizes[0];
        const live = first && s.id === 'busy' ? liveMutation(s.dir) : first && s.id === 'sparse' ? queueMoreCheck(s.dir) : null;
        const r = await checkOne(chrome, server.base, s.id, size, args, png, live);
        summary.fixtures[s.id][size] = r;
        const liveBad = r.live && (r.live.ok === false || r.live.p95Moved === false || r.live.otherStaticFramesStill === false);
        const bad = r.consoleErrors.length > 0 || r.issues.length > 0 || liveBad;
        if (bad) summary.failures.push(`${s.id}@${size}`);
      }
    }
  } finally {
    for (const p of procs) p.kill();
    rmSync(work, { recursive: true, force: true });
  }
  process.stdout.write(`${JSON.stringify(summary, null, 1)}\n`);
  process.exit(summary.failures.length ? 1 : 0);
}

main().catch((e) => { process.stderr.write(`${e.stack ?? e}\n`); process.exit(2); });
