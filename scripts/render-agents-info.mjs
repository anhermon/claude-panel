#!/usr/bin/env node
// Renders the Agents scene in the REAL panel server + headless Chrome and checks it:
//   node scripts/render-agents-info.mjs [--fixture crew] [--out DIR] [--sizes 1280x900,720x1280,360x730] [--src DIR] [--settle MS] [--details detail|detail-sparse|detail-real-tile|detail-real-metrics|codex-detail] [--detail AGENT_ID]
// Per size it renders twice and writes <out>/<fixture>-<w>x<h>-webgl.png (software GL: SwiftShader) and -svg.png (WebGL off: the 2D
// fallback), counts console errors (must be 0), checks the mode, the satellites / dots, the rows, that the page does not scroll,
// and the smallest text. At the first size it also appends an event to the data (a status change) and checks the ticker and the row
// pulse, then selects a row and checks the satellite label (-event.png, -selected.png). At EVERY size it then opens the drill-down
// of an agent (fixtures/detail.json -> live/detail.json) and captures each tab (-detail-transcript/-metrics/-struggles.png) plus the
// main session's (when the details file has one), checking that nothing scrolls sideways, the text is readable, Back and Escape return to the list. Prints one JSON
// summary; exit 1 on a failure.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

import { HEADLESS_FLAGS, blockNonLocal, cdpConnect, cleanup, findChrome, isExecutable, readPortFile, sleep } from '../web/shot.mjs';
import { startServer } from '../web/testkit.mjs';
import { MIN_BAR_PX } from '../web/builtin/agents-info/gantt-logic.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_SRC = resolve(HERE, '../web/builtin/agents-info');
const DEFAULT_SIZES = ['1280x900', '720x1280', '360x730'];
const SETTLE_MS = 3500;
const EVENT_SETTLE_MS = 1500;
const READY_WAIT_MS = 30000;
const READY_POLL_MS = 200;
const SCENE_ID = 'agents-info';
const SOFTWARE_GL_FLAGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];
const NO_GL_FLAGS = ['--disable-gpu', '--disable-3d-apis', '--disable-webgl'];
const MIN_FONT_PX = 12;
const MAX_LABELLED = 6;
const CALLOUT_MS = 450;
const SHOWCASE_CELL_PX = Number(process.env.SHOWCASE_CELL_PX ?? 150);
const SHOWCASE_AV_PX = Number(process.env.SHOWCASE_AV_PX ?? 120);
const FX_BEAM_MS = 380;
const FX_MID_MS = 330;
const FX_SETTLE_MS = 1500;
const NOT_RUNTIME = /(^|\/)(fixtures|README\.md|[^/]*\.test\.mjs)(\/|$)/;
const MS_PER_SEC = 1000;
const DEFAULT_DETAIL_AGENT = 't40';
const MAIN_ID = 'main';
const DETAIL_TABS = ['progress', 'transcript', 'metrics', 'struggles'];
const DETAIL_WAIT_MS = 6000;
const DETAIL_POLL_MS = 150;
const GANTT_MIN_LONGEST_PCT = 35;

const evalJs = async (cdp, expression) => (await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result.value;

function parseArgs(argv) {
  const o = { fixture: 'crew', out: join(tmpdir(), 'panel-agents-info'), sizes: DEFAULT_SIZES, src: DEFAULT_SRC, settle: SETTLE_MS, details: 'detail', detailAgent: DEFAULT_DETAIL_AGENT, hasDetailsArg: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--fixture') o.fixture = argv[++i];
    else if (a === '--out') o.out = resolve(argv[++i]);
    else if (a === '--sizes') o.sizes = argv[++i].split(',');
    else if (a === '--src') o.src = resolve(argv[++i]);
    else if (a === '--details') { o.details = argv[++i]; o.hasDetailsArg = true; }
    else if (a === '--detail') o.detailAgent = argv[++i];
    else if (a === '--settle') o.settle = Number(argv[++i]);
    else throw new Error(`unknown option ${a}`);
  }
  return o;
}

/** A fixture gives `startedAgoMs` / `endedAgoMs` / event `ago` (so it stays fresh); the mod writes absolute times. */
function stamp(fixture, now, extraEvents = []) {
  const segsAt = (segs) => (segs ?? []).map(({ aAgoMs, bAgoMs, ...s }) => ({ ...s, a: now - aAgoMs, b: now - bAgoMs })); // gantt stretches are given as "ago" too
  const agents = fixture.agents.map(({ startedAgoMs, endedAgoMs, segs, ...a }) => ({ ...a, ...(segs ? { segs: segsAt(segs) } : {}), startedAt: now - startedAgoMs, endedAt: endedAgoMs == null ? null : now - endedAgoMs }));
  const events = [...fixture.events.map(({ ago, ...e }) => ({ ...e, t: now - ago })), ...extraEvents];
  return { ...fixture, agents, events, updatedAt: now };
}
function writeData(dir, data) {
  const live = join(dir, 'live');
  mkdirSync(live, { recursive: true });
  writeFileSync(join(live, '.data.json.tmp'), `${JSON.stringify(data)}\n`);
  renameSync(join(live, '.data.json.tmp'), join(live, 'data.json'));
}

/**
 * A detail fixture gives times as `agoMs` (an entry's `t`) or `<name>AgoMs` (`aAgoMs` -> `a`, `lastTAgoMs` -> `lastT`, `sayTAgoMs` -> `sayT`),
 * anywhere in it; the mod writes absolute ones. `startedAgoMs` / `endedAgoMs` are the agent's own and are read below.
 */
function agoToAbs(v, now) {
  if (Array.isArray(v)) return v.map((x) => agoToAbs(x, now));
  if (v === null || typeof v !== 'object') return v;
  return Object.fromEntries(Object.entries(v).map(([k, x]) => {
    if (k === 'agoMs') return ['t', x == null ? null : now - x];
    if (k.endsWith('AgoMs') && k !== 'startedAgoMs' && k !== 'endedAgoMs') return [k.slice(0, -'AgoMs'.length), x == null ? null : now - x];
    return [k, agoToAbs(x, now)];
  }));
}
function stampDetail(d, now) {
  const at = (ago) => now - ago;
  const abs = agoToAbs(d, now);
  const m = d.metrics;
  const entries = abs.transcript.entries;
  return {
    v: 1, ...abs, updatedAt: now, startedAt: at(d.startedAgoMs), endedAt: d.endedAgoMs == null ? null : at(d.endedAgoMs),
    transcript: { ...abs.transcript, fromT: entries[0].t, toT: entries.at(-1).t },
    metrics: { ...abs.metrics, tokens: { ...m.tokens, series: m.tokens.series.map(([agoSec, tokens]) => ({ t: at(agoSec * MS_PER_SEC), tokens })), coveredFromT: m.tokens.series.length ? at(m.tokens.series[0][0] * MS_PER_SEC) : null } },
  };
}
function writeDetail(dir, detail) {
  const live = join(dir, 'live');
  mkdirSync(live, { recursive: true });
  writeFileSync(join(live, '.detail.json.tmp'), `${JSON.stringify(detail)}\n`);
  renameSync(join(live, '.detail.json.tmp'), join(live, 'detail.json'));
}

const DETAIL_AUDIT = `(() => {
  const body = document.querySelector('.detail-body');
  let min = Infinity; let minText = '';
  for (const t of document.querySelectorAll('#detail *:not(svg *)')) {
    if (![...t.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
    const cs = getComputedStyle(t);
    if (cs.display === 'none') continue;
    const fs = parseFloat(cs.fontSize);
    if (fs < min) { min = fs; minText = t.textContent.trim().slice(0, 24); }
  }
  const box = document.getElementById('detail').getBoundingClientRect();
  const overs = [...document.querySelectorAll('#detail *')].filter((n) => { const r = n.getBoundingClientRect(); return r.width > 0 && r.right > box.right + 1; });
  const over = overs.length;
  return {
    view: document.getElementById('app').dataset.view, tab: window.__agentsInfo.detail().tab, hasDetail: window.__agentsInfo.detail().hasDetail,
    tabs: [...document.querySelectorAll('.tab')].map((b) => b.textContent),
    overFirst: overs.slice(0, 3).map((n) => n.tagName.toLowerCase() + '.' + n.className).join(' '),
    sideways: body.scrollWidth > body.clientWidth + 1, overflowing: over, bodyH: Math.round(body.clientHeight), bodyScrollH: body.scrollHeight,
    pageScrolls: document.documentElement.scrollHeight > innerHeight + 1 || document.documentElement.scrollWidth > innerWidth + 1,
    hasSection: ['Now', 'Phases', 'Checklist', 'Decisions', 'Issues and what needs you', 'Done so far'].every((t) => [...document.querySelectorAll('.p-head')].some((n) => n.textContent.startsWith(t))),
    hasRun: Boolean(document.querySelector('.m-sec .p-bar, .m-sec .p-phases .p-empty')), ticks: document.querySelectorAll('.m-tick').length,
    minFont: Math.round(min * 10) / 10, minText, entries: document.querySelectorAll('.entry').length, failed: document.querySelectorAll('.entry[data-failed="true"]').length,
    stage: Math.round(document.querySelector('.stage').getBoundingClientRect().height),
    note: document.querySelector('.detail-note').hidden ? '' : document.querySelector('.detail-note').textContent,
  };
})()`;

async function waitFor(cdp, expression) {
  for (let t = 0; t < DETAIL_WAIT_MS; t += DETAIL_POLL_MS) {
    if (await evalJs(cdp, expression)) return true;
    await sleep(DETAIL_POLL_MS);
  }
  return false;
}

/** Open an agent's detail, capture every tab, check the layout; then Back / Escape. Returns what it saw. */
/** The scene runs top-level here (no workspace page to forward its events), so what it posts to its parent is recorded in-page. */
const CAPTURE_EMITS = `window.__emits = []; const post = window.parent.postMessage.bind(window.parent); window.parent.postMessage = (m, ...r) => { if (m && m.type === 'panel-emit') window.__emits.push({ name: m.name, data: m.data }); return post(m, ...r); };`;
const sentEvents = async (cdp) => (await evalJs(cdp, 'window.__emits ?? []'));

async function checkDetail(cdp, scene, details, detailAgent, png, issues, size, kind) {
  const out = {};
  const before = (await sentEvents(cdp)).length;
  for (const id of [detailAgent, MAIN_ID].filter((x) => details[x])) {
    writeDetail(scene, stampDetail(details[id], Date.now()));
    await evalJs(cdp, `window.__agentsInfo.open(${JSON.stringify(id)})`);
    if (!(await waitFor(cdp, `window.__agentsInfo.detail().hasDetail`))) { issues.push(`detail of ${id} never arrived`); continue; }
    for (const tab of DETAIL_TABS) {
      await evalJs(cdp, `[...document.querySelectorAll('.tab')].find((b) => b.textContent.startsWith(${JSON.stringify(tab[0].toUpperCase() + tab.slice(1))}))?.click()`);
      await sleep(DETAIL_POLL_MS * 3);
      const a = await evalJs(cdp, DETAIL_AUDIT);
      await shot(cdp, png(`-detail-${id === MAIN_ID ? 'main-' : ''}${tab}`));
      out[`${id}/${tab}`] = a;
      const where = `${size}/${kind} ${id}/${tab}`;
      if (a.view !== 'detail' || a.tab !== tab) issues.push(`${where}: view ${a.view}, tab ${a.tab}`);
      if (a.sideways || a.overflowing > 0) issues.push(`${where}: content wider than the detail (${a.overflowing} elements: ${a.overFirst})`);
      if (a.pageScrolls) issues.push(`${where}: page scrolls`);
      if (a.minFont < MIN_FONT_PX) issues.push(`${where}: smallest text ${a.minFont}px ("${a.minText}")`);
      if (tab === 'transcript' && a.entries === 0) issues.push(`${where}: no transcript entries`);
      if (tab === 'transcript' && id === detailAgent && a.failed < 1 && details[id].transcript.entries.some((e) => e.error)) issues.push(`${where}: failed call not highlighted`);
      if (a.tabs.length !== DETAIL_TABS.length) issues.push(`${where}: tabs ${a.tabs.join('|')}`);
      if (tab === 'progress' && a.tabs[0] !== 'Progress') issues.push(`${where}: Progress is not the first tab`);
      if (tab === 'progress' && !a.hasSection) issues.push(`${where}: Progress has no Now / Phases / Checklist / Issues sections`);
      if (tab === 'metrics' && a.ticks > 0) issues.push(`${where}: the Run area still draws ${a.ticks} tick marks`);
      if (tab === 'metrics' && !a.hasRun) issues.push(`${where}: Metrics has no phase bar or no reason for its absence`);
    }
    if (id === detailAgent && details[id].transcript.hasMore) {
      await evalJs(cdp, `[...document.querySelectorAll('.tab')].find((b) => b.textContent.startsWith('Transcript')).click()`);
      await sleep(DETAIL_POLL_MS * 3);
      await evalJs(cdp, `document.querySelector('.more')?.click()`);
      await sleep(EVENT_SETTLE_MS);
      const asked = (await sentEvents(cdp)).slice(before).filter((e) => e.name === 'agent');
      if (!asked.some((e) => e.data?.id === detailAgent && e.data?.pages === 2)) issues.push(`${size}/${kind}: "Show earlier entries" did not ask the mod for page 2 (${JSON.stringify(asked.map((e) => e.data))})`);
    }
    await evalJs(cdp, `document.querySelector('.back').click()`);
    await sleep(DETAIL_POLL_MS * 3);
    const back = await evalJs(cdp, `document.getElementById('app').dataset.view`);
    if (back !== 'list') issues.push(`${size}/${kind}: Back left view ${back}`);
  }
  await evalJs(cdp, `window.__agentsInfo.open(${JSON.stringify(detailAgent)})`);
  await sleep(DETAIL_POLL_MS * 3);
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await sleep(DETAIL_POLL_MS * 3);
  const esc = await evalJs(cdp, `document.getElementById('app').dataset.view`);
  if (esc !== 'list') issues.push(`${size}/${kind}: Escape left view ${esc}`);
  await sleep(EVENT_SETTLE_MS);
  const names = (await sentEvents(cdp)).slice(before).map((e) => e.name);
  if (!names.includes('agent') || !names.includes('agent-close')) issues.push(`${size}/${kind}: the mod was not told (events: ${names.join(',')})`);
  return out;
}

async function openPage(chrome, size, extraFlags) {
  const res = { profile: mkdtempSync(join(tmpdir(), 'claude-panel-shot-')) };
  const args = [...HEADLESS_FLAGS, ...extraFlags, `--user-data-dir=${res.profile}`, `--window-size=${size.width},${size.height}`, 'about:blank'];
  res.proc = spawn(chrome, args, { stdio: 'ignore', detached: true });
  res.proc.unref();
  const port = await readPortFile(res.profile, res.proc);
  const tab = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
  res.cdp = await cdpConnect(tab.webSocketDebuggerUrl);
  const log = { problems: [] };
  const cdp = res.cdp;
  for (const d of ['Page', 'Runtime', 'Log']) await cdp.send(`${d}.enable`);
  await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: size.width, height: size.height, deviceScaleFactor: 1, mobile: false });
  cdp.on('Runtime.consoleAPICalled', (p) => { if (p.type === 'error' || p.type === 'warning') log.problems.push(`${p.type}: ${(p.args ?? []).map((a) => a.value ?? a.description ?? a.type).join(' ').slice(0, 200)}`); });
  cdp.on('Runtime.exceptionThrown', (p) => log.problems.push(`exception: ${(p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text ?? '').split('\n')[0].slice(0, 200)}`));
  cdp.on('Log.entryAdded', (p) => { if (p.entry?.level === 'error') log.problems.push(`log: ${p.entry.text} ${p.entry.url ?? ''}`.slice(0, 200)); });
  blockNonLocal(cdp, (url) => log.problems.push(`blocked non-local request ${url.slice(0, 80)}`));
  return { res, cdp, log };
}

const shot = async (cdp, path) => writeFileSync(path, Buffer.from((await cdp.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));

// The gantt in numbers (fixture "gantt"): the bars' px, the shortest and longest subagent, the main row's chevron, vertical overlaps.
const GANTT_AUDIT = `(() => {
  const rows = [...document.querySelectorAll('.row')].map((r) => {
    const track = r.querySelector('.g-track'); const bar = r.querySelector('.g-bar'); const t = track.getBoundingClientRect(); const b = bar.getBoundingClientRect();
    const chev = r.querySelector('.g-chev');
    return { main: r.dataset.main === 'true', state: r.dataset.state, name: r.querySelector('.row-name').textContent, trackW: t.width, trackTop: t.top, trackBottom: t.bottom, barW: b.width, barLeft: b.left - t.left, barHidden: bar.hidden, chev: chev.hidden ? '' : chev.textContent, end: r.querySelector('.g-end').hidden ? '' : r.querySelector('.g-end').textContent, dotVisible: !r.querySelector('.g-dot').hidden, segs: bar.children.length, title: track.title };
  });
  const subs = rows.filter((r) => !r.main);
  const overlaps = rows.flatMap((a, i) => rows.slice(i + 1).filter((b) => a.trackTop < b.trackBottom - 0.5 && b.trackTop < a.trackBottom - 0.5).map((b) => a.name + ' x ' + b.name));
  const axis = [...document.querySelectorAll('.g-tick')].map((n) => n.textContent);
  const axisBox = document.querySelector('.g-axis').getBoundingClientRect(); const trackBox = document.querySelector('.g-track').getBoundingClientRect();
  return { rows, trackW: rows[0].trackW, longestPct: Math.max(...subs.map((r) => r.barW)) / rows[0].trackW * 100, shortest: Math.min(...subs.map((r) => r.barW)), overlaps, axis, axisAligned: Math.abs(axisBox.left - trackBox.left) < 1.5 && Math.abs(axisBox.right - trackBox.right) < 1.5, axisBox: [axisBox.left, axisBox.right], trackBox: [trackBox.left, trackBox.right], mode: document.querySelector('.g-mode[aria-pressed="true"]')?.textContent };
})()`;

const AUDIT = `(() => {
  const app = document.getElementById('app');
  let min = Infinity; let minText = '';
  for (const t of document.querySelectorAll('body *:not(svg *):not(script)')) {
    if (![...t.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
    const cs = getComputedStyle(t);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const fs = parseFloat(cs.fontSize);
    if (fs < min) { min = fs; minText = t.textContent.trim().slice(0, 24); }
  }
  return {
    mode: app.dataset.mode, layout: app.dataset.layout,
    scrolls: document.documentElement.scrollHeight > innerHeight + 1 || document.documentElement.scrollWidth > innerWidth + 1,
    rows: document.querySelectorAll('.row').length, avatars: document.querySelectorAll(app.dataset.mode === 'webgl' ? '.av-canvas' : '.av > .mini-face').length, expectAvatars: document.querySelectorAll('.row, .crew-card').length + 1, cards: document.querySelectorAll('.crew-card').length, more: document.querySelector('.crew-more')?.textContent ?? null, ids: /\\bT\\d+\\b|\\b\\d{2}-[a-z]/i.test([...document.querySelectorAll('.crew-title, .crew-chip, .row-name, .row-feed, .tick span')].map((n) => n.textContent).join(' ')),
    stats: window.__agentsInfo.stats(), ticks: window.__agentsInfo.ticks(), minFont: Math.round(min * 10) / 10, minText,
    mood: document.getElementById('mood').textContent, summary: document.getElementById('summary').textContent,
    legend: document.getElementById('legend').textContent,
  };
})()`;

/** Software GL is slow to start: wait for the scene to pick its mode and draw its rows before looking. */
async function waitReady(cdp) {
  for (let t = 0; t < READY_WAIT_MS; t += READY_POLL_MS) {
    if (await evalJs(cdp, `(() => { const a = document.getElementById('app'); return Boolean(a) && a.dataset.mode !== 'loading' && document.querySelectorAll('.row').length > 0; })()`)) return;
    await sleep(READY_POLL_MS);
  }
}

async function runOne(chrome, base, size, kind, args, scene, fixture, details, isFirst) {
  const [width, height] = size.split('x').map(Number);
  const { res, cdp, log } = await openPage(chrome, { width, height }, kind === 'webgl' ? SOFTWARE_GL_FLAGS : NO_GL_FLAGS);
  const issues = [];
  const png = (suffix = '') => join(args.out, `${args.fixture}-${size}-${kind}${suffix}.png`);
  try {
    writeData(scene, stamp(fixture, Date.now()));
    writeDetail(scene, { v: 1 });
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: CAPTURE_EMITS });
    await cdp.send('Page.navigate', { url: `${base}/s/${SCENE_ID}/` });
    await waitReady(cdp);
    await sleep(args.settle);
    const audit = await evalJs(cdp, AUDIT);
    await shot(cdp, png());
    const want = kind === 'webgl' ? 'webgl' : 'svg';
    if (audit.mode !== want) issues.push(`mode ${audit.mode}, wanted ${want}`);
    const satellites = Math.min(MAX_LABELLED, fixture.agents.filter((a) => !a.isMain).length);
    if (audit.rows !== fixture.agents.length) issues.push(`rows ${audit.rows}, wanted ${fixture.agents.length}`);
    if (audit.cards > satellites || audit.cards < 1) issues.push(`crew cards ${audit.cards}, wanted up to ${satellites}`);
    if (kind === 'webgl' && audit.stats?.figures < audit.cards + 1) issues.push(`figures ${audit.stats?.figures}, cards ${audit.cards}`);
    if (audit.avatars !== audit.expectAvatars) issues.push(`${kind === 'webgl' ? 'canvas' : 'svg'} avatars ${audit.avatars}, wanted ${audit.expectAvatars}`);
    if (args.fixture === 'gantt') {
      audit.gantt = await evalJs(cdp, GANTT_AUDIT);
      const g = audit.gantt;
      const main = g.rows.find((r) => r.main);
      if (g.longestPct < GANTT_MIN_LONGEST_PCT) issues.push(`longest subagent bar is ${Math.round(g.longestPct)}% of the track (wanted >= ${GANTT_MIN_LONGEST_PCT}%)`);
      if (g.shortest < MIN_BAR_PX - 0.5) issues.push(`shortest bar ${g.shortest}px < minimum ${MIN_BAR_PX}px`);
      if (!/^\u2039 started 24 h 37 min ago$/.test(main.chev)) issues.push(`main chevron label is "${main.chev}"`);
      if (g.overlaps.length > 0) issues.push(`rows overlap: ${g.overlaps.join(', ')}`);
      if (!g.axisAligned) issues.push('the axis is not aligned with the tracks');
      for (const [label, file] of [['Whole session', '-session'], ['Last hour', '-hour'], ['Fit agents', '']]) { // the other two modes: pressed, drawn, still no overlap
        await evalJs(cdp, `[...document.querySelectorAll('.g-mode')].find((b) => b.textContent === ${JSON.stringify(label)}).click()`);
        await sleep(CALLOUT_MS);
        if (file !== '') await shot(cdp, png(file));
        const m = await evalJs(cdp, GANTT_AUDIT);
        audit.gantt[`mode:${label}`] = { axis: m.axis, longestPct: Math.round(m.longestPct), shortest: m.shortest, overlaps: m.overlaps, pressed: m.mode };
        if (m.mode !== label || m.overlaps.length > 0) issues.push(`mode "${label}": pressed ${m.mode}, overlaps ${m.overlaps.length}`);
      }
      await evalJs(cdp, `document.getElementById('list').scrollTop = document.getElementById('list').scrollHeight`); // the rows below the fold (done, failed)
      await sleep(CALLOUT_MS);
      await shot(cdp, png('-scrolled'));
      await evalJs(cdp, `document.getElementById('list').scrollTop = 0`);
    }
    if (audit.ids) issues.push('a ticket id is visible as text');
    if (audit.scrolls) issues.push('page scrolls');
    if (audit.minFont < MIN_FONT_PX) issues.push(`smallest text ${audit.minFont}px ("${audit.minText}")`);
    if (args.fixture === 'waiting') {
      audit.waiting = await evalJs(cdp, `(() => {
        const waits = [...document.querySelectorAll('.wait-chip:not([hidden])')].map((n) => ({ text: n.textContent, title: n.title }));
        const errs = [...document.querySelectorAll('.err-chip:not([hidden])')].map((n) => n.textContent);
        const me = document.querySelector('.row[data-main="true"]');
        return { waits, errs, meName: me?.querySelector('.row-name')?.textContent ?? '', meModel: me?.querySelector('.ident-model')?.textContent ?? '', meBranch: me?.querySelector('.row-branch')?.textContent ?? '' };
      })()`);
      if (audit.waiting.waits.length < 2 || !audit.waiting.waits.every((w) => w.text.startsWith('may be waiting') && w.title.includes('a long tool looks the same'))) issues.push(`waiting chips missing or wrong: ${JSON.stringify(audit.waiting.waits)}`);
      if (audit.waiting.errs.length < 1 || !audit.waiting.errs.some((e) => /\d+ errors?/.test(e))) issues.push(`error chips missing: ${JSON.stringify(audit.waiting.errs)}`);
      if (!audit.waiting.meModel || !audit.waiting.meBranch) issues.push(`Me row missing model or branch: ${JSON.stringify(audit.waiting)}`);
    }
    if (args.fixture === 'harness' || args.fixture === 'codex-moods') { // one frame with every character big: claude, codex, agy and the unknown ones side by side
      await evalJs(cdp, `(() => { const s = document.createElement('style'); s.id = 'showcase'; s.textContent = '.crew-grid { grid-template-columns: repeat(auto-fill, minmax(' + ${SHOWCASE_CELL_PX} + 'px, 1fr)) !important } .crew-btn { grid-template-columns: 1fr !important; justify-items: center; text-align: center } .crew-av { --av: ' + ${SHOWCASE_AV_PX} + 'px; width: var(--av); height: var(--av) } .crew-meta { justify-content: center }'; document.head.append(s); })()`);
      await sleep(args.settle);
      await shot(cdp, png('-showcase'));
      await evalJs(cdp, `document.getElementById('showcase').remove()`);
    }
    let event = null;
    if (isFirst && fixture.agents.length > 0) {
      const now = Date.now();
      const id = Math.max(0, ...fixture.events.map((e) => e.id)) + 1;
      const target = fixture.agents.find((a) => a.state === 'working') ?? fixture.agents[0];
      const next = stamp(fixture, now, [{ id, t: now, agent: target.id, from: 'working', to: 'testing', kind: 'state', text: `${target.short} testing` }]);
      next.agents = next.agents.map((a) => (a.id === target.id ? { ...a, state: 'testing', pct: 55 } : a));
      writeData(scene, next);
      await sleep(EVENT_SETTLE_MS);
      await shot(cdp, png('-event'));
      // one-shot animations: a handoff (beam), a finish (check burst) and a failure (shake + "!"), each shot while it plays
      const scenes = [
        { name: 'started', agent: fixture.agents.find((a) => !a.isMain && a.state === 'working') ?? target, ev: (t) => ({ kind: 'handoff', from: 'main', to: t.id, text: `main \u2192 ${t.short}` }), mutate: (a) => a, wait: FX_BEAM_MS },
        { name: 'done', agent: fixture.agents.find((a) => !a.isMain && a.state === 'working') ?? target, ev: (t) => ({ kind: 'state', from: 'working', to: 'done', text: `${t.short} done` }), mutate: (a) => ({ ...a, state: 'done', pct: 100, endedAt: Date.now() }), wait: FX_MID_MS },
        { name: 'error', agent: fixture.agents.find((a) => !a.isMain && a.state === 'working') ?? target, ev: (t) => ({ kind: 'state', from: 'working', to: 'done', text: `${t.short} done` }), mutate: (a) => ({ ...a, state: 'done', ticket: { id: 'x-1', stage: 'failed', text: 'failed 1/4', title: a.ticket?.title ?? '' } }), wait: FX_MID_MS },
      ];
      let evId = id + 1;
      for (const sc of scenes) {
        const t0 = Date.now();
        const nx = stamp(fixture, t0, [{ id: evId++, t: t0, agent: sc.agent.id, ...sc.ev(sc.agent) }]);
        nx.agents = nx.agents.map((a) => (a.id === sc.agent.id ? sc.mutate(a) : a));
        writeData(scene, nx);
        if (!(await waitFor(cdp, sc.name === 'started' ? `document.querySelector('.beam') !== null` : `document.querySelector('.av[data-fx]') !== null`))) issues.push(`no ${sc.name} animation played`);
        await sleep(sc.wait);
        await shot(cdp, png(`-fx-${sc.name}`));
        await sleep(FX_SETTLE_MS);
      }
      writeData(scene, stamp(fixture, Date.now(), []));
      // the callout: a click on a card grows it (title, state, step, time, calls, last events, Open); Escape collapses it
      await evalJs(cdp, `document.querySelector('.crew-btn').click()`);
      await sleep(CALLOUT_MS);
      await shot(cdp, png('-callout'));
      const open = await evalJs(cdp, `({ open: document.querySelectorAll('.crew-callout.open').length, text: document.querySelector('.crew-callout.open')?.textContent ?? '', openBtn: Boolean(document.querySelector('.crew-callout.open .callout-open')), events: document.querySelectorAll('.crew-callout.open .callout-events li').length })`);
      if (open.open !== 1 || !open.openBtn) issues.push('a click on a card did not open its callout');
      if (/\bT\d+\b/.test(open.text)) issues.push('a ticket id is visible in the callout');
      await evalJs(cdp, `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
      await sleep(CALLOUT_MS);
      if ((await evalJs(cdp, `document.querySelectorAll('.crew-callout.open').length`)) !== 0) issues.push('Escape did not collapse the callout');
      event = { ...(event ?? {}), callout: open };
      const after = await evalJs(cdp, `({ ticks: window.__agentsInfo.ticks(), pulsed: document.querySelectorAll('.row.pulse').length, ticker: [...document.querySelectorAll('.tick span')].map((n) => n.textContent) })`);
      event = after;
      if (after.ticks < 1) issues.push('no ticker line after a new event');
      if (!after.ticker.some((t) => t.trim() !== '' && !/\bT\d+\b/.test(t))) issues.push(`ticker lacks the new event ("${after.ticker.join(' | ')}")`);
      await evalJs(cdp, `document.querySelector('.row[data-main="false"] .row-btn').click()`);
      await sleep(600);
      await shot(cdp, png('-selected'));
      const sel = await evalJs(cdp, `({ selected: document.querySelectorAll('.row.selected').length, label: [...document.querySelectorAll('.crew-callout')].filter((n) => !n.hidden).map((n) => n.textContent) })`);
      if (sel.selected !== 1) issues.push('row click did not select');
      if (sel.label.length !== 1) issues.push('no callout after selecting a row');
      event = { ...event, ...sel };
      await evalJs(cdp, `document.querySelector('.back').click()`);
      await sleep(400);
    }
    const detail = fixture.agents.length > 0 && details ? await checkDetail(cdp, scene, details, args.detailAgent, png, issues, size, kind) : null;
    return { size, kind, png: png(), audit, event, detail, console: log.problems, issues };
  } finally {
    await cleanup(res);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  mkdirSync(args.out, { recursive: true });
  const work = mkdtempSync(join(tmpdir(), 'agents-info-render-'));
  const chrome = findChrome({ env: process.env, exists: isExecutable, pathDirs: (process.env.PATH ?? '').split(delimiter).filter(Boolean) });
  if (!chrome) throw new Error('chrome not found');
  const fixture = JSON.parse(readFileSync(join(args.src, 'fixtures', `${args.fixture}.json`), 'utf8'));
  const detailsPath = join(args.src, 'fixtures', `${args.details}.json`);
  const details = args.fixture === 'crew' || args.hasDetailsArg ? JSON.parse(readFileSync(detailsPath, 'utf8')) : null;
  const scene = join(work, SCENE_ID);
  cpSync(args.src, scene, { recursive: true, filter: (src) => !NOT_RUNTIME.test(src.slice(args.src.length)) });
  const state = { id: SCENE_ID, title: 'Agents', layout: 'stage', span: 3, height: 540, alt: 'Agents', rev: 1, dir: scene, entry: 'index.html', builtin: true };
  const stateFile = join(work, 'state.json');
  writeFileSync(stateFile, JSON.stringify({ v: 4, rev: 1, updatedAt: 1, url: null, status: 'working', task: { title: 'Agents', why: 'render' }, context: [], done: [], next: [], cards: [], choices: [], scenes: [state] }));
  const procs = [];
  const summary = { out: args.out, runs: [], failures: [] };
  try {
    const server = await startServer(stateFile, { procs, extraArgs: ['--root', work] });
    for (const size of args.sizes) {
      for (const kind of ['webgl', 'svg']) {
        const r = await runOne(chrome, server.base, size, kind, args, scene, fixture, details, size === args.sizes[0]);
        summary.runs.push(r);
        if (r.console.length > 0 || r.issues.length > 0) summary.failures.push(`${size}/${kind}`);
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
