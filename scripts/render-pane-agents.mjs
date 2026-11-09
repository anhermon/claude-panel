#!/usr/bin/env node
// Opens an agent of the Agents tile in the two pages that host it, in the real panel server + headless Chrome:
//   node scripts/render-pane-agents.mjs [--out DIR] [--size 960x540] [--settle MS]
//   - /workspace/ (what the terminal pane screencasts; no mouse): the way the pane's Buttons do it, with the host messages live.mjs
//     delivers (PanelWorkspace.hostCommand: open-agent, then tab, then close); the detail must open, switch tab and go back;
//   - / (the browser page): a REAL mouse click on a row opens the detail.
// Writes <out>/pane-workspace.png (detail open), <out>/pane-workspace-metrics.png and <out>/pane-browser.png, prints one JSON summary; exit 1 on a failure.
// The scene is in a sandboxed, out-of-process iframe: its DOM is read and its row located through that frame's own DevTools target.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { blockNonLocal, cdpConnect, cleanup, findChrome, isExecutable, launchChrome, sleep } from '../web/shot.mjs';
import { startServer } from '../web/testkit.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '../web/builtin/agents-info');
const SCENE_ID = 'agents-info';
const NOT_RUNTIME = /(^|\/)(fixtures|README\.md|[^/]*\.test\.mjs)(\/|$)/;
const DEFAULT_SIZE = '960x540';
const SETTLE_MS = 4000;
const AFTER_CLICK_MS = 1500;
const READY_WAIT_MS = 30000;
const READY_POLL_MS = 250;
const HOST_TAB = 'metrics';
const AFTER_HOST_MS = 1200;
const SCENE_PATH = `/s/${SCENE_ID}/`;

const PAGES = [
  { name: 'workspace', path: '/workspace/', viaHost: true },
  { name: 'browser', path: '/', viaHost: false },
];

function parseArgs(argv) {
  const o = { out: join(tmpdir(), 'panel-pane-agents'), size: DEFAULT_SIZE, settle: SETTLE_MS };
  for (let i = 0; i < argv.length; i += 2) {
    if (argv[i] === '--out') o.out = resolve(argv[i + 1]);
    else if (argv[i] === '--size') o.size = argv[i + 1];
    else if (argv[i] === '--settle') o.settle = Number(argv[i + 1]);
    else throw new Error(`unknown option ${argv[i]}`);
  }
  return o;
}

/** The crew fixture with absolute times (the mod writes absolute ones). */
function stamped(now) {
  const f = JSON.parse(readFileSync(join(SRC, 'fixtures', 'crew.json'), 'utf8'));
  const agents = f.agents.map(({ startedAgoMs, endedAgoMs, ...a }) => ({ ...a, startedAt: now - startedAgoMs, endedAt: endedAgoMs == null ? null : now - endedAgoMs }));
  return { ...f, agents, events: f.events.map(({ ago, ...e }) => ({ ...e, t: now - ago })), updatedAt: now };
}

/** The scene frame is out of process (sandboxed, opaque origin): it is its own DevTools target, listed by /json. Resolves to a connection or null. */
async function sceneTarget(port) {
  for (let t = 0; t < READY_WAIT_MS; t += READY_POLL_MS) {
    const hit = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((x) => x.type === 'iframe' && x.url.includes(SCENE_PATH));
    if (hit) return cdpConnect(hit.webSocketDebuggerUrl);
    await sleep(READY_POLL_MS);
  }
  return null;
}

const evalIn = async (cdp, expression) => (await cdp.send('Runtime.evaluate', { expression, returnByValue: true })).result.value;

const ROW_READY = `document.querySelectorAll('.row').length > 0 && document.getElementById('app').dataset.mode !== 'loading'`;
const ROW_BOX = `(() => { const r = document.querySelector('.row[data-main="false"] .row-btn').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`;
const ROW_ID = `document.querySelector('.row[data-main="false"]').dataset.id`;
const STATE = `({ view: document.getElementById('app').dataset.view, ...window.__agentsInfo.detail() })`;
const HOST = (id, name, data) => `window.PanelWorkspace.hostCommand(${JSON.stringify(id)}, ${JSON.stringify(name)}, ${JSON.stringify(data)})`;
const NOTE = `(() => { const n = document.querySelector('.detail-note'); return { view: document.getElementById('app').dataset.view, fill: n.dataset.fill ?? '', note: n.hidden ? '' : n.textContent }; })()`;
const FRAME_OFFSET = `(() => { const f = [...document.querySelectorAll('iframe')].find((i) => i.src.includes('${SCENE_PATH}')); const r = f.getBoundingClientRect(); return { x: r.left, y: r.top }; })()`;

async function checkPage(chrome, base, page, size, args, issues) {
  const res = {};
  const log = [];
  let scene = null;
  const [width, height] = size.split('x').map(Number);
  const port = await launchChrome(chrome, { width, height }, res);
  const { cdp } = res;
  try {
    for (const d of ['Page', 'Runtime', 'Log']) await cdp.send(`${d}.enable`);
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    cdp.on('Runtime.exceptionThrown', (p) => log.push((p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text ?? 'exception').split('\n')[0].slice(0, 200)));
    blockNonLocal(cdp, (url) => log.push(`blocked non-local request ${url.slice(0, 80)}`));
    await cdp.send('Page.navigate', { url: `${base}${page.path}` });
    await sleep(args.settle);
    scene = await sceneTarget(port);
    if (scene === null) { issues.push(`${page.name}: the Agents scene frame was not found`); return null; }
    await scene.send('Runtime.enable');
    for (let t = 0; t < READY_WAIT_MS && !(await evalIn(scene, ROW_READY)); t += READY_POLL_MS) await sleep(READY_POLL_MS);
    const shot = async (name) => writeFileSync(join(args.out, name), Buffer.from((await cdp.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
    const extra = {};
    if (page.viaHost) {
      const id = await evalIn(scene, ROW_ID);
      await cdp.send('Runtime.evaluate', { expression: HOST(SCENE_ID, 'open-agent', { id }) });
      await sleep(AFTER_HOST_MS);
      extra.opened = await evalIn(scene, STATE);
      await shot(`pane-${page.name}.png`);
      if (extra.opened.view !== 'detail' || extra.opened.id !== id) issues.push(`${page.name}: open-agent did not open the detail (${JSON.stringify(extra.opened)})`);
      await cdp.send('Runtime.evaluate', { expression: HOST(SCENE_ID, 'tab', { name: HOST_TAB }) });
      await sleep(AFTER_HOST_MS);
      extra.tab = await evalIn(scene, STATE);
      await shot(`pane-${page.name}-${HOST_TAB}.png`);
      if (extra.tab.tab !== HOST_TAB) issues.push(`${page.name}: tab did not switch (${JSON.stringify(extra.tab)})`);
      await cdp.send('Runtime.evaluate', { expression: HOST(SCENE_ID, 'close', {}) });
      await sleep(AFTER_HOST_MS);
      extra.closed = await evalIn(scene, STATE);
      if (extra.closed.view !== 'list') issues.push(`${page.name}: close did not go back (${JSON.stringify(extra.closed)})`);
    } else {
      const row = await evalIn(scene, ROW_BOX);
      const frame = (await cdp.send('Runtime.evaluate', { expression: FRAME_OFFSET, returnByValue: true })).result.value;
      const at = { x: Math.round(frame.x + row.x), y: Math.round(frame.y + row.y) };
      for (const type of ['mousePressed', 'mouseReleased']) await cdp.send('Input.dispatchMouseEvent', { type, ...at, button: 'left', clickCount: 1 });
      await sleep(AFTER_CLICK_MS);
      extra.opened = await evalIn(scene, STATE);
      await shot(`pane-${page.name}.png`);
      if (extra.opened.view !== 'detail') issues.push(`${page.name}: the click did not open the detail (view ${extra.opened.view})`);
    }
    const seen = await evalIn(scene, NOTE);
    if (log.length > 0) issues.push(`${page.name}: ${log.join(' | ')}`);
    return { ...seen, ...extra };
  } finally {
    scene?.close();
    await cleanup(res);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  mkdirSync(args.out, { recursive: true });
  const work = mkdtempSync(join(tmpdir(), 'pane-agents-'));
  const chrome = findChrome({ env: process.env, exists: isExecutable, pathDirs: (process.env.PATH ?? '').split(delimiter).filter(Boolean) });
  if (!chrome) throw new Error('chrome not found');
  const scene = join(work, SCENE_ID);
  cpSync(SRC, scene, { recursive: true, filter: (src) => !NOT_RUNTIME.test(src.slice(SRC.length)) });
  mkdirSync(join(scene, 'live'), { recursive: true });
  writeFileSync(join(scene, 'live', 'data.json'), JSON.stringify(stamped(Date.now())));
  writeFileSync(join(scene, 'live', 'detail.json'), '{"v":1}');
  const state = { id: SCENE_ID, title: 'Agents', layout: 'stage', span: 3, height: 540, alt: 'Agents', rev: 1, mtime: 1, dir: scene, entry: 'index.html', builtin: true };
  const stateFile = join(work, 'state.json');
  writeFileSync(stateFile, JSON.stringify({ v: 4, rev: 1, updatedAt: 1, url: null, status: 'working', task: { title: 'Agents', why: 'render' }, context: [], done: [], next: [], cards: [], choices: [], scenes: [state] }));
  const procs = [];
  const summary = { out: args.out, pages: {}, failures: [] };
  try {
    const server = await startServer(stateFile, { procs, extraArgs: ['--root', work] });
    for (const page of PAGES) summary.pages[page.name] = await checkPage(chrome, server.base, page, args.size, args, summary.failures);
  } finally {
    for (const p of procs) p.kill();
    rmSync(work, { recursive: true, force: true });
  }
  process.stdout.write(`${JSON.stringify(summary, null, 1)}\n`);
  process.exit(summary.failures.length ? 1 : 0);
}

main().catch((e) => { process.stderr.write(`${e.stack ?? e}\n`); process.exit(2); });
