#!/usr/bin/env node
// Renders the WORKSPACE page (every stage scene as a tile of one grid) in the REAL panel server + headless Chrome:
//   node scripts/render-workspace.mjs [--scenes N] [--out DIR] [--sizes 1150x1180,720x1600,1920x1080] [--settle MS] [--hero ID]
//                                     [--board FIXTURE] [--scroll-to top|bottom]
// `--scroll-to` scrolls the hero tile the way the terminal pane does (a mouse wheel over it, web/scroll-math.mjs) before the picture.
// The first scenes of the pool are published (board with a fixture, a diagram, a chart, then small inline scenes); for each
// size it writes <out>/workspace-<N>-<w>x<h>.png and checks: no console errors / blocked requests, the page does not
// scroll, one iframe per shown tile (and a `+N more` chip past the cap), no tile sticks out of the viewport.
// Prints one JSON summary on stdout; exit code 1 on any failure. Needs Chrome (web/shot.mjs finds it).
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { installBoard, readFixture, writeData } from '../web/builtin/board/seed-board.mjs';
import { wheelDeltas } from '../web/scroll-math.mjs';
import { blockNonLocal, findChrome, isExecutable, launchChrome, sleep } from '../web/shot.mjs';
import { startServer } from '../web/testkit.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const RECIPES = join(HERE, '..', 'skills', 'panel-guide', 'recipes');
const DEFAULT_SIZES = ['1150x1180', '720x1600', '1920x1080'];
const DEFAULT_SCENES = 3;
const SHOWN_MAX = 6; // layout.js MAX_TILES
const SETTLE_MS = 4500;
const SLACK_PX = 2;
const BOARD_FIXTURE = 'busy';
const SCROLL_SETTLE_MS = 1200;
const HERO_BOX = `(() => { const t = document.querySelector('.tile[data-hero]'); const r = t.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, h: r.height }; })()`;
const INLINE_COUNT = 4;

const inlinePage = (n) => `<!doctype html><meta charset=utf-8><body style="margin:0;display:grid;place-items:center;height:100vh;background:#16181d;color:#eef0f3;font:600 28px system-ui">Scene ${n}`;

// The page as the person sees it: tile rects and the iframes, read from the real DOM.
const AUDIT = `(() => {
  const doc = document.documentElement;
  const tiles = [...document.querySelectorAll('.tile')].map((t) => { const r = t.getBoundingClientRect(); return { id: t.dataset.sceneId, x: r.x, y: r.y, w: r.width, h: r.height, frames: t.querySelectorAll('iframe').length, title: t.querySelector('.strip')?.textContent ?? '' }; });
  const more = document.getElementById('more');
  return { vw: innerWidth, vh: innerHeight, scrollW: doc.scrollWidth, scrollH: doc.scrollHeight, tiles, more: more.hidden ? '' : more.textContent };
})()`;

function parseArgs(argv) {
  const o = { out: resolve('workspace-renders'), sizes: DEFAULT_SIZES, settle: SETTLE_MS, scenes: DEFAULT_SCENES, hero: '', board: BOARD_FIXTURE, scrollTo: '' };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i + 1];
    if (argv[i] === '--out') o.out = resolve(v);
    else if (argv[i] === '--sizes') o.sizes = v.split(',');
    else if (argv[i] === '--settle') o.settle = Number(v);
    else if (argv[i] === '--scenes') o.scenes = Number(v);
    else if (argv[i] === '--hero') o.hero = v;
    else if (argv[i] === '--board') o.board = v;
    else if (argv[i] === '--scroll-to') o.scrollTo = v;
    else continue;
    i++;
  }
  return o;
}

function makePool(work, boardFixture) {
  const board = join(work, 'board');
  installBoard(board);
  writeData(board, readFixture(boardFixture));
  for (const name of ['diagram', 'chart']) cpSync(join(RECIPES, name), join(work, name), { recursive: true });
  const pool = [
    { id: 'board', title: 'Board', dir: board, builtin: true, alt: 'The board' },
    { id: 'diagram', title: 'Diagram', dir: join(work, 'diagram'), alt: 'A diagram' },
    { id: 'chart', title: 'Chart', dir: join(work, 'chart'), alt: 'A chart' },
  ];
  for (let n = 1; n <= INLINE_COUNT; n++) {
    const dir = join(work, `note-${n}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'index.html'), inlinePage(n));
    pool.push({ id: `note-${n}`, title: `Note ${n}`, dir, alt: `Scene ${n}` });
  }
  return pool.map((s, i) => ({ layout: 'stage', span: 3, height: 540, rev: 1, entry: 'index.html', ...s, mtime: i }));
}

async function openPage(chrome, size) {
  const res = {};
  const log = { errors: [] };
  await launchChrome(chrome, size, res);
  const { cdp } = res;
  for (const d of ['Page', 'Runtime', 'Log']) await cdp.send(`${d}.enable`);
  await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: size.width, height: size.height, deviceScaleFactor: 1, mobile: false });
  cdp.on('Runtime.exceptionThrown', (p) => log.errors.push((p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text ?? 'exception').split('\n')[0].slice(0, 200)));
  cdp.on('Log.entryAdded', (p) => { if (p.entry?.level === 'error') log.errors.push(`${p.entry.text} ${p.entry.url ?? ''}`.slice(0, 200)); });
  blockNonLocal(cdp, (url) => log.errors.push(`blocked non-local request ${url.slice(0, 80)}`));
  return { res, cdp, log };
}

async function checkOne(chrome, base, count, sizeText, args, png) {
  const [width, height] = sizeText.split('x').map(Number);
  const { res, cdp, log } = await openPage(chrome, { width, height });
  try {
    await cdp.send('Page.navigate', { url: `${base}/workspace/${args.hero ? `?hero=${encodeURIComponent(args.hero)}` : ''}` });
    await sleep(args.settle);
    if (args.scrollTo) {
      const box = (await cdp.send('Runtime.evaluate', { expression: HERO_BOX, returnByValue: true })).result.value;
      for (const deltaY of wheelDeltas({ edge: args.scrollTo }, box.h)) await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: box.x, y: box.y, deltaX: 0, deltaY });
      await sleep(SCROLL_SETTLE_MS);
    }
    const audit = (await cdp.send('Runtime.evaluate', { expression: AUDIT, returnByValue: true })).result.value;
    writeFileSync(png, Buffer.from((await cdp.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
    const issues = [];
    const want = Math.min(count, SHOWN_MAX);
    if (audit.tiles.length !== want) issues.push(`${audit.tiles.length} tiles, wanted ${want}`);
    if (audit.more !== (count > SHOWN_MAX ? `+${count - SHOWN_MAX} more` : '')) issues.push(`chip "${audit.more}"`);
    if (audit.scrollW > audit.vw + SLACK_PX || audit.scrollH > audit.vh + SLACK_PX) issues.push(`page scrolls: ${audit.scrollW}x${audit.scrollH} in ${audit.vw}x${audit.vh}`);
    for (const t of audit.tiles) {
      if (t.frames !== 1) issues.push(`${t.id}: ${t.frames} iframes`);
      if (t.x < -SLACK_PX || t.y < -SLACK_PX || t.x + t.w > audit.vw + SLACK_PX || t.y + t.h > audit.vh + SLACK_PX) issues.push(`${t.id} outside the viewport`);
    }
    return { png, tiles: audit.tiles.map((t) => `${t.id} ${Math.round(t.w)}x${Math.round(t.h)}`), more: audit.more, consoleErrors: log.errors, issues };
  } finally {
    try { res.cdp?.close?.(); } catch { /* chrome is killed below */ }
    try { process.kill(-res.proc.pid, 'SIGKILL'); } catch { /* already gone */ }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  mkdirSync(args.out, { recursive: true });
  const work = mkdtempSync(join(tmpdir(), 'workspace-render-'));
  const chrome = findChrome({ env: process.env, exists: isExecutable, pathDirs: (process.env.PATH ?? '').split(delimiter).filter(Boolean) });
  if (!chrome) throw new Error('chrome not found');
  const scenes = makePool(work, args.board).slice(0, args.scenes);
  const stateFile = join(work, 'state.json');
  writeFileSync(stateFile, JSON.stringify({ v: 4, rev: 1, updatedAt: 1, url: null, status: 'working', task: { title: 'Workspace', why: 'render' }, context: [], done: [], next: [], cards: [], choices: [], scenes }));
  const procs = [];
  const summary = { out: args.out, sizes: {}, failures: [] };
  try {
    const server = await startServer(stateFile, { procs, extraArgs: ['--root', work] });
    for (const size of args.sizes) {
      const r = await checkOne(chrome, server.base, scenes.length, size, args, join(args.out, `workspace-${scenes.length}-${size}${args.scrollTo ? `-scroll-${args.scrollTo}` : ''}.png`));
      summary.sizes[size] = r;
      if (r.consoleErrors.length || r.issues.length) summary.failures.push(size);
    }
  } finally {
    for (const p of procs) p.kill();
    rmSync(work, { recursive: true, force: true });
  }
  process.stdout.write(`${JSON.stringify(summary, null, 1)}\n`);
  process.exit(summary.failures.length ? 1 : 0);
}

main().catch((e) => { process.stderr.write(`${e.stack ?? e}\n`); process.exit(2); });
