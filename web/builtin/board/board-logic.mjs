import { plainTitle } from '../../kit/panel/plain-title.mjs';
// Pure logic of the Board scene: no DOM, no timers, no globals. Everything that decides WHAT the board shows
// (normalising the data file, the text caps, the grid, which frame may change next) lives here so Node can test it.
// Tested by board-logic.test.mjs.

import { DEFAULT_SIZE, isSize } from './grid-plan.mjs';
import { normalizeInsight } from './insight-logic.mjs';

// ---- caps (the contract: README.md) ---------------------------------------------------------------------------
export const CAPS = Object.freeze({
  title: 40, text: 90, sub: 120, say: 80, label: 28, item: 44, question: 70, option: 24, status: 16,
  laneLabel: 80, laneStep: 80, laneNote: 60, stepItem: 48, dod: 6,
  bars: 8, rings: 4, steps: 6, timeline: 6, compare: 4, lanes: 6, nodes: 10, edges: 16, series: 3, points: 60, spark: 24, options: 4,
});
export const ID_MAX = 24;
export const ID_RE = /^[a-z0-9-]{1,24}$/; // keep in step with ID_MAX
const RAW_FRAMES_MAX = 64; // how many raw frames are even looked at
const ID_SUFFIX_ROOM = 4; // a repeated id keeps ID_MAX - ID_SUFFIX_ROOM chars plus "-n"

// ---- time -------------------------------------------------------------------------------------------------------
/** One frame's content changes at most once per this long: the 0.6 s cross-fade finishes before the next one starts. */
export const CHANGE_GAP_MS = 600;
export const QUIET_AFTER_MS = 90_000;
export const PULSE_IDLE_AFTER_MS = 30_000;

// ---- text -------------------------------------------------------------------------------------------------------
const WHITESPACE = /\s+/g;
const ELLIPSIS = '…';

/** Any value -> single-spaced text of at most `max` characters (a trailing ellipsis when cut). */
export function capText(value, max) {
  const s = (typeof value === 'string' || typeof value === 'number' ? String(value) : '').replace(WHITESPACE, ' ').trim();
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)).trimEnd() + ELLIPSIS;
}

/** Display text, cleaned before clipping; ids still use capText. */
export const capTitle = (value, max) => capText(plainTitle(value, false), max);

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const arr = (v, max) => (Array.isArray(v) ? v.slice(0, max) : []);
const num = (v, fallback = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** The pct of a lane/ring: 0..100 or null (unknown). */
export const pctOf = (v) => (typeof v === 'number' && Number.isFinite(v) ? clamp(v, 0, 100) : null);

const COLOR_RE = /^#[0-9a-fA-F]{3,8}$/;
/** Only hex colours come from the data (they end up in style attributes); anything else is ignored. */
export const safeColor = (v) => (typeof v === 'string' && COLOR_RE.test(v) ? v : null);

const DATA_IMAGE_RE = /^data:image\/(png|gif|jpe?g|webp|avif|svg\+xml)(;[a-z0-9=.+-]+)*[;,]/i;
const REL_PATH_RE = /^[A-Za-z0-9_][A-Za-z0-9_./-]*$/;
/** An image src is a path inside the scene folder or a data:image URL; anything else (remote, `..`) -> null. */
export function safeImageSrc(src) {
  if (typeof src !== 'string') return null;
  const s = src.trim();
  if (DATA_IMAGE_RE.test(s)) return s;
  if (REL_PATH_RE.test(s) && !s.split('/').some((seg) => seg === '..' || seg === '' || seg.startsWith('.'))) return s;
  return null;
}

/** "1,840 ms" / "12.5%" / "7" -> a number to count up to plus what surrounds it; null when the value has no leading number. */
const METRIC_RE = /^(\D{0,3}?)(-?\d[\d,]*(?:\.\d+)?)(.*)$/;
export function parseMetric(value) {
  const s = String(value ?? '').trim();
  const m = METRIC_RE.exec(s);
  if (!m) return null;
  const digits = m[2].replace(/,/g, '');
  const n = Number(digits);
  if (!Number.isFinite(n)) return null;
  const decimals = digits.includes('.') ? digits.length - digits.indexOf('.') - 1 : 0;
  return { prefix: m[1], n, decimals, suffix: m[3], grouped: m[2].includes(',') };
}
export function formatMetric(parts, n) {
  const fixed = n.toFixed(parts.decimals);
  const body = parts.grouped ? Number(fixed).toLocaleString('en-US', { minimumFractionDigits: parts.decimals, maximumFractionDigits: parts.decimals }) : fixed;
  return `${parts.prefix}${body}${parts.suffix}`;
}

/** Lane states, most active first; a blocked agent needs attention sooner than one that only waits. */
export const LANE_ORDER = ['working', 'testing', 'blocked', 'waiting', 'done'];
const DOD_STATES = ['todo', 'doing', 'done', 'failed'];
const count = (v) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : undefined);
const dodOf = (v) => arr(v, CAPS.dod).filter(isObj).map((d) => ({ t: capText(plainTitle(d.t, false), CAPS.stepItem), state: DOD_STATES.includes(d.state) ? d.state : 'todo' }));
export function sortLanes(lanes) {
  const rank = (s) => { const i = LANE_ORDER.indexOf(s); return i < 0 ? LANE_ORDER.length : i; };
  return arr(lanes, 64)
    .filter(isObj)
    .map((l, i) => ({ l, i }))
    .sort((a, b) => rank(a.l.state) - rank(b.l.state) || a.i - b.i)
    .slice(0, CAPS.lanes)
    .map(({ l }) => {
      const dod = dodOf(l.dod);
      const at = Number.isInteger(l.at) && l.at >= 0 && l.at < dod.length ? l.at : null;
      return {
        id: capText(l.id, 24) || 'lane', label: capText(plainTitle(l.label, false), CAPS.laneLabel), state: LANE_ORDER.includes(l.state) ? l.state : 'working',
        pct: pctOf(l.pct), step: capText(plainTitle(l.step, false), CAPS.laneStep), note: capText(plainTitle(l.note, false), CAPS.laneNote),
        goal: capText(plainTitle(l.goal, false), CAPS.laneLabel), dod, at, calls: count(l.calls), startedAt: num(l.startedAt), updatedAt: num(l.updatedAt), insight: normalizeInsight(l.insight),
      };
    });
}

// ---- the grid lives in grid-plan.mjs; re-exported so callers have one import ---------------------------------------
export * from './grid-plan.mjs';

/**
 * How many frames are not on the board. Two kinds: cut by the data cap (`total` - `targeted`), and mounted but without
 * a cell (`mounted` - `placed`), less the `redundant` ones among them. Frames still waiting in the change queue to appear are NOT counted: they are coming.
 */
export const moreCount = ({ total, targeted, mounted, placed, redundant = 0 }) => Math.max(0, Math.max(0, total - targeted) + Math.max(0, mounted - placed) - redundant);

/** The mod's per-agent bars ("Time per agent" in min, "Tokens per agent" in k tokens; "Tool calls per agent" in older data): every agent row already carries these figures, so this frame may go unshown without a "+N more". */
const AGENT_BARS_UNITS = new Set(['calls', 'min', 'k tokens']);
export const isCallsBars = (frame) => frame.type === 'bars' && AGENT_BARS_UNITS.has(frame.unit);

// ---- normalising the data file ------------------------------------------------------------------------------------
/** The raw JSON -> { frames, lanes, pulse, now, updatedAt }: never throws, drops what is unusable, caps what is long. */
export function normalizeData(raw) {
  const d = isObj(raw) ? raw : {};
  const lanes = sortLanes(d.lanes);
  const now = isObj(d.now) ? { title: capText(plainTitle(d.now.title, false), CAPS.text), status: capText(d.now.status, CAPS.status) } : null;
  const seen = new Set();
  const frames = [];
  for (const f of arr(d.frames, RAW_FRAMES_MAX)) {
    if (!isObj(f)) continue;
    let id = typeof f.id === 'string' && ID_RE.test(f.id) ? f.id : `f${frames.length + 1}`;
    if (seen.has(id)) id = `${id.slice(0, ID_MAX - ID_SUFFIX_ROOM)}-${frames.length + 1}`;
    seen.add(id);
    const type = typeof f.type === 'string' ? f.type : '';
    const frame = { ...f, id, type, title: capText(plainTitle(f.title, false), CAPS.title), size: isSize(f.size) ? f.size : DEFAULT_SIZE };
    if (type === 'lanes' || type === 'doing') frame.lanes = lanes; // the frame shows data.lanes, so a lane change is a change of this frame
    if (type === 'now' && frame.text === undefined && now) { frame.text = now.title; frame.status = frame.status ?? now.status; }
    frames.push(frame);
  }
  return { frames, lanes, pulse: isObj(d.pulse) ? d.pulse : null, now, updatedAt: num(d.updatedAt) };
}

export const sigOf = (frame) => JSON.stringify(frame);

// ---- the change queue --------------------------------------------------------------------------------------------
/**
 * What the board shows right now (`shown`) versus what the data says (`target`), and the next single step from one
 * to the other. Steps: remove, update (content or size or title), add, reorder. At most one step per `gap` ms, so the
 * board never changes more than one frame visibly at a time; the first paint is not a step (it shows everything).
 */
export function nextOp(shown, target) {
  const want = new Map(target.map((f) => [f.id, f]));
  const have = new Map(shown.map((f) => [f.id, f]));
  for (const f of shown) if (!want.has(f.id)) return { kind: 'remove', id: f.id };
  for (const f of shown) if (sigOf(f) !== sigOf(want.get(f.id))) return { kind: 'update', id: f.id, frame: want.get(f.id) };
  for (const f of target) if (!have.has(f.id)) return { kind: 'add', id: f.id, frame: f };
  if (shown.some((f, i) => f.id !== target[i].id)) return { kind: 'reorder' };
  return null;
}

export function applyOp(shown, op, target) {
  switch (op.kind) {
    case 'remove': return shown.filter((f) => f.id !== op.id);
    case 'update': return shown.map((f) => (f.id === op.id ? op.frame : f));
    case 'add': {
      const at = target.findIndex((f) => f.id === op.id);
      let insert = 0;
      for (let i = at - 1; i >= 0 && insert === 0; i--) { const k = shown.findIndex((f) => f.id === target[i].id); if (k >= 0) insert = k + 1; }
      return [...shown.slice(0, insert), op.frame, ...shown.slice(insert)];
    }
    case 'reorder': return target.map((f) => shown.find((s) => s.id === f.id));
    default: return shown;
  }
}

export function createChangeQueue({ gap = CHANGE_GAP_MS } = {}) {
  let shown = [];
  let target = [];
  let started = false;
  let lastAt = -Infinity;
  return {
    setTarget(frames) { target = frames; },
    shown: () => shown,
    target: () => target,
    pending: () => !started ? target.length > 0 : nextOp(shown, target) !== null,
    /** Ms until the next step may run (0 = now), or null when nothing is pending. */
    waitMs(now) { return this.pending() ? Math.max(0, lastAt + gap - now) : null; },
    /** Runs one step if one is pending and allowed. Returns the op ({kind:'init'} for the first paint) or null. */
    step(now) {
      if (!started) {
        if (target.length === 0) return null;
        started = true; lastAt = now; shown = target;
        return { kind: 'init' };
      }
      if (now - lastAt < gap) return null;
      const op = nextOp(shown, target);
      if (!op) return null;
      shown = applyOp(shown, op, target);
      lastAt = now;
      return op;
    },
  };
}

export const isQuiet = (now, changedAt) => now - changedAt >= QUIET_AFTER_MS;

/** Series -> SVG path points in a w x h box (y flipped), shared by the sparkline and the line chart. */
export function scaleSeries(points, w, h, { min, max, padX = 0, padY = 0 } = {}) {
  const ys = points.filter((p) => Number.isFinite(p));
  const lo = min ?? Math.min(...ys);
  const hi = max ?? Math.max(...ys);
  const span = hi - lo || 1;
  const step = points.length > 1 ? (w - padX * 2) / (points.length - 1) : 0;
  return points.map((p, i) => ({ x: padX + i * step, y: padY + (h - padY * 2) * (1 - (num(p, lo) - lo) / span) }));
}
