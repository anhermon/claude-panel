// The Board scene: frames laid out on a grid, drawn from live/data.json (written by the panel mod). The data file is
// polled with panel.data. What the board shows is a function of the data, never of a timer: nothing cycles or swaps on its
// own; a frame changes only when its data changes, one frame's content per CHANGE_GAP_MS at most (board-logic.mjs
// createChangeQueue), with a 0.6 s cross-fade or an in-place morph. Entering frames fade in, leaving ones fade out and
// are removed, reordering is a FLIP slide. See README.md for the data contract.
import panel from 'panel';
import { CHANGE_GAP_MS, createChangeQueue, isCallsBars, isQuiet, moreCount, normalizeData, planGrid } from './board-logic.mjs';
import { frameModule } from './frames/index.js';
import { MODE_SCROLL, SCROLL_MAX_FRAMES, chooseMode, hasMoreBelow, maxScrollTop, nextScrollTop, planScroll, positionLabel, reachedCount } from './scroll-logic.mjs';

const POLL_MS = 1000;
const FADE_MS = 600;
const LEAVE_MS = 400;
const FLIP_MS = 600;
const ENTER_STAGGER_MS = 70;
const QUIET_CHECK_MS = 5000;
const MIN_MOVE_PX = 1;
const RESIZE_DEBOUNCE_MS = 150;
const FLIP_EASING = 'cubic-bezier(.2,.8,.2,1)';

const $ = (id) => document.getElementById(id);
const boardEl = $('board');
const emptyEl = $('empty');
const moreEl = $('more');
// the scroll cue (bottom fade + "3/8"): index.html has them; a page without them gets them made here
const cueEl = (id, className, tag) => $(id) ?? document.body.appendChild(Object.assign(document.createElement(tag), { id, className, hidden: true }));
const fadeEl = cueEl('fade', 'fade', 'div');
const posEl = cueEl('pos', 'pos', 'p');
const reducedQuery = matchMedia('(prefers-reduced-motion: reduce)');
const queue = createChangeQueue({ gap: CHANGE_GAP_MS });
const entries = new Map(); // frame id -> { el, fb, layer, mod, frame, dispose: [], changedAt }
const box = { pulse: null, total: 0, timer: 0 };

const emit = (name, data) => { try { panel.emit(name, data); } catch { /* the host is not listening */ } };

function layerCtx(entry) {
  return { emit, frameId: entry.frame.id, pulse: () => box.pulse, get reduced() { return reducedQuery.matches; }, onDispose: (fn) => entry.layerDispose.push(fn) };
}

function drawLayer(entry, frame, layer) {
  entry.layerDispose = [];
  const mod = frameModule(frame.type);
  try {
    mod.render(layer, frame, layerCtx({ ...entry, frame }));
  } catch (err) {
    console.warn('board: frame failed', frame.id, err?.message);
    layer.replaceChildren();
    frameModule('').render(layer, { type: '' }, layerCtx({ ...entry, frame }));
  }
  return { mod, dispose: entry.layerDispose };
}

function mount(frame, index, isInit) {
  const el = document.createElement('section');
  el.className = 'frame';
  el.dataset.type = frame.type;
  el.dataset.id = frame.id;
  el.style.setProperty('--d', `${isInit ? index * ENTER_STAGGER_MS : 0}ms`);
  if (frame.title) el.setAttribute('aria-label', frame.title);
  const head = document.createElement('header');
  head.className = 'ft';
  if (frame.type === 'now') head.append(Object.assign(document.createElement('i'), { className: 'dot' }));
  const title = Object.assign(document.createElement('span'), { className: 'ft-title', textContent: frame.title || (frame.type === 'now' ? 'Now' : '') });
  head.append(title, Object.assign(document.createElement('i'), { className: 'quiet-dot', title: 'unchanged for a while' }));
  const fb = Object.assign(document.createElement('div'), { className: 'fb' });
  const layer = Object.assign(document.createElement('div'), { className: 'layer' });
  fb.append(layer);
  el.append(head, fb);
  el.dataset.empty = title.textContent ? 'false' : 'true';
  const entry = { el, fb, title, layer, frame, changedAt: performance.now(), layerDispose: [] };
  const drawn = drawLayer(entry, frame, layer);
  Object.assign(entry, { mod: drawn.mod, dispose: drawn.dispose });
  entries.set(frame.id, entry);
  boardEl.append(el);
}

function disposeAll(list) {
  for (const fn of list) { try { fn(); } catch { /* ignore */ } }
}

function retire(entry) {
  const rect = entry.el.getBoundingClientRect();
  const host = boardEl.getBoundingClientRect();
  Object.assign(entry.el.style, { position: 'absolute', left: `${rect.left - host.left}px`, top: `${rect.top - host.top + boardEl.scrollTop}px`, width: `${rect.width}px`, height: `${rect.height}px`, gridArea: 'auto' });
  entry.el.classList.add('leaving');
  entries.delete(entry.frame.id);
  setTimeout(() => { disposeAll(entry.dispose); entry.el.remove(); }, reducedQuery.matches ? 0 : LEAVE_MS);
}

function update(entry, frame) {
  const prev = entry.frame;
  entry.frame = frame;
  entry.changedAt = performance.now();
  entry.el.classList.remove('quiet');
  if (frame.title !== prev.title) { entry.title.textContent = frame.title || (frame.type === 'now' ? 'Now' : ''); entry.el.dataset.empty = entry.title.textContent ? 'false' : 'true'; }
  const mod = frameModule(frame.type);
  let done = false;
  if (frame.type === prev.type && typeof mod.update === 'function') {
    try { done = mod.update(entry.layer, frame, layerCtx(entry)) === true; } catch { done = false; }
  }
  if (done) return;
  const old = entry.layer;
  const oldDispose = entry.dispose;
  const next = Object.assign(document.createElement('div'), { className: 'layer fade-in' });
  entry.fb.append(next);
  const drawn = drawLayer(entry, frame, next);
  Object.assign(entry, { layer: next, mod: drawn.mod, dispose: drawn.dispose });
  old.classList.add('fade-out');
  setTimeout(() => { disposeAll(oldDispose); old.remove(); next.classList.remove('fade-in'); }, reducedQuery.matches ? 0 : FADE_MS);
}

// ---- layout (explicit grid from board-logic.planGrid, or the scroll plan when frames would be dropped; FLIP for what moves) --
function applyScrollPlan(plan) {
  boardEl.style.gridTemplateRows = 'none'; // the stylesheet's one 1fr row would squash the first frame
  boardEl.style.gridAutoRows = plan.narrow ? 'auto' : `${plan.rowPx}px`;
}

function updateCue() {
  const scrolls = document.documentElement.dataset.mode === MODE_SCROLL;
  const max = scrolls ? maxScrollTop(boardEl) : 0;
  const shown = [...entries.values()].filter((e) => !e.el.hidden);
  const label = scrolls ? positionLabel({ reached: reachedCount({ bottoms: shown.map((e) => e.el.offsetTop + e.el.offsetHeight), scrollTop: boardEl.scrollTop, viewHeight: boardEl.clientHeight }), total: shown.length, max }) : '';
  posEl.hidden = label === '';
  posEl.textContent = label;
  fadeEl.hidden = !(scrolls && hasMoreBelow({ scrollTop: boardEl.scrollTop, max }));
}

function layout() {
  const live = [...entries.values()];
  const keepTop = boardEl.scrollTop;
  const before = new Map(live.map((e) => [e.frame.id, e.el.getBoundingClientRect()]));
  const frames = live.map((e) => e.frame);
  const view = { aspect: innerWidth / Math.max(1, innerHeight), width: innerWidth, height: innerHeight };
  const fitPlan = planGrid(frames, view);
  const mode = chooseMode(fitPlan);
  const plan = mode === MODE_SCROLL ? planScroll(frames, view) : fitPlan;
  const modeChanged = document.documentElement.dataset.mode !== mode;
  document.documentElement.dataset.mode = mode;
  document.documentElement.dataset.narrow = plan.narrow ? 'true' : 'false';
  document.documentElement.dataset.shape = plan.shape; // portrait | square | landscape: the css and the diagram read it
  const placed = new Map(plan.cells.map((c) => [c.id, c]));
  boardEl.style.gridTemplateColumns = `repeat(${plan.cols}, minmax(0, 1fr))`;
  if (mode === MODE_SCROLL) applyScrollPlan(plan);
  else {
    boardEl.style.gridAutoRows = '';
    boardEl.style.gridTemplateRows = plan.weights ? plan.weights.map((w) => `minmax(0, ${w}fr)`).join(' ') : `repeat(${plan.rows}, minmax(0, 1fr))`;
  }
  for (const e of live) {
    const c = placed.get(e.frame.id);
    e.el.hidden = !c;
    if (c) e.el.style.gridArea = mode === MODE_SCROLL ? (plan.narrow ? 'auto' : `auto / auto / span ${c.h} / span ${c.w}`) : `${c.row + 1} / ${c.col + 1} / span ${c.h} / span ${c.w}`;
    if (c) e.el.style.height = c.px ? `${c.px}px` : '';
    if (c) e.el.dataset.size = c.size;
  }
  boardEl.scrollTop = nextScrollTop({ prev: modeChanged ? 0 : keepTop, max: maxScrollTop(boardEl) }); // a re-render never jumps the viewer to the top
  updateCue();
  const lanesShown = live.some((e) => e.frame.type === 'lanes' && placed.has(e.frame.id)); // its rows carry the calls the bars would show
  const redundant = lanesShown ? live.filter((e) => !placed.has(e.frame.id) && isCallsBars(e.frame)).length : 0;
  const more = moreCount({ total: box.total, targeted: queue.target().length, mounted: live.length, placed: plan.cells.length, redundant });
  boardEl.dataset.more = more > 0 ? 'true' : 'false';
  moreEl.hidden = more === 0;
  moreEl.textContent = `+${more} more`;
  emptyEl.hidden = live.length > 0;
  if (reducedQuery.matches || mode === MODE_SCROLL || modeChanged) return; // a scrolling board slides nothing: positions are the viewer's
  for (const e of live) {
    const a = before.get(e.frame.id);
    const b = e.el.getBoundingClientRect();
    if (!a || a.width === 0 || !placed.has(e.frame.id)) continue;
    const dx = a.left - b.left;
    const dy = a.top - b.top;
    const sx = a.width / b.width;
    const sy = a.height / b.height;
    if (Math.abs(dx) < MIN_MOVE_PX && Math.abs(dy) < MIN_MOVE_PX && Math.abs(sx - 1) < 0.01 && Math.abs(sy - 1) < 0.01) continue;
    e.el.animate([{ transformOrigin: '0 0', transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})` }, { transformOrigin: '0 0', transform: 'none' }], { duration: FLIP_MS, easing: FLIP_EASING });
  }
}

// ---- the queue pump -------------------------------------------------------------------------------------------------
function applyOp(op, shown) {
  if (op.kind === 'init') { shown.forEach((f, i) => mount(f, i, true)); return; }
  if (op.kind === 'remove') { const e = entries.get(op.id); if (e) retire(e); return; }
  if (op.kind === 'update') { const e = entries.get(op.id); if (e) update(e, op.frame); return; }
  if (op.kind === 'add') {
    mount(op.frame, 0, false);
    const next = shown[shown.findIndex((f) => f.id === op.id) + 1];
    const anchor = next && entries.get(next.id);
    if (anchor) boardEl.insertBefore(entries.get(op.id).el, anchor.el);
    return;
  }
  if (op.kind === 'reorder') for (const f of shown) boardEl.append(entries.get(f.id).el);
}

function pump() {
  clearTimeout(box.timer);
  const op = queue.step(performance.now());
  if (op) { applyOp(op, queue.shown()); layout(); }
  const wait = queue.waitMs(performance.now());
  if (wait !== null) box.timer = setTimeout(pump, Math.max(wait, 1));
}

function onData(raw) {
  const data = normalizeData(raw);
  box.pulse = data.pulse;
  box.total = data.frames.length;
  queue.setTarget(data.frames.slice(0, SCROLL_MAX_FRAMES)); // the planner decides: fit them, or scroll
  pump();
}

setInterval(() => {
  const now = performance.now();
  for (const e of entries.values()) e.el.classList.toggle('quiet', isQuiet(now, e.changedAt));
}, QUIET_CHECK_MS);

let resizeTimer = 0;
addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(layout, RESIZE_DEBOUNCE_MS); });
boardEl.addEventListener('scroll', updateCue, { passive: true });

layout();
panel.data(onData, { every: POLL_MS });
