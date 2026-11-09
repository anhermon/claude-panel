// Pure logic of the two "what kind of work" frames: `doing` (one line per agent: kind glyph, name, kind, files; frames/doing.js)
// and `swimlane` (one lane per agent over the session, bars by kind; frames/swimlane.js). No DOM, no clock of its own.
// Tested by doing-logic.test.mjs.
import { formatDuration, liveKind } from './insight-logic.mjs';
import { KIND_IDS, isKind } from './kind-meta.mjs';

export const DOING_CAPS = Object.freeze({ rows: 8, files: 2, name: 24 });
export const SWIMLANE_CAPS = Object.freeze({ items: 8, segs: 48, label: 24 });
const SWIMLANE_STATES = new Set(['working', 'waiting', 'done']);
const RUNNING = new Set(['working', 'testing']);
const MS_SEC = 1000;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const sec = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : 0);
const cut = (v, max) => {
  const s = typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '';
  return s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
};
const byKindOrder = (kinds) => KIND_IDS.filter((k) => kinds.has(k));

/** The rows of the `doing` frame from data.lanes: those with an insight, the running ones first (the order inside each group is kept). */
export function doingRows(lanes, now) {
  const rows = (Array.isArray(lanes) ? lanes : [])
    .filter((l) => isObj(l) && isObj(l.insight))
    .map((l) => {
      const { kind } = liveKind(l.insight, l.state, now);
      return { id: l.id, name: cut(l.label, DOING_CAPS.name), kind, files: l.insight.files.slice(0, DOING_CAPS.files), running: RUNNING.has(l.state), isMain: l.insight.isMain };
    });
  return [...rows.filter((r) => r.running), ...rows.filter((r) => !r.running)].slice(0, DOING_CAPS.rows);
}

/** The kinds the rows show, in the fixed kind order: the legend lists no others. */
export const legendKinds = (rows) => byKindOrder(new Set(rows.map((r) => r.kind)));

/** The raw swimlane items -> clean ones (known kinds only, ordered, cut to the lane); `end` is the last second drawn, never 0. */
export function normalizeSwimlane(f) {
  const items = (Array.isArray(f.items) ? f.items : []).filter(isObj).slice(0, SWIMLANE_CAPS.items).map((it) => {
    const from = sec(it.from);
    const to = Math.max(from, sec(it.to));
    const segs = (Array.isArray(it.segs) ? it.segs : [])
      .filter((s) => isObj(s) && isKind(s.k))
      .slice(-SWIMLANE_CAPS.segs)
      .map((s) => ({ k: s.k, a: sec(s.a), b: sec(s.b) }))
      .filter((s) => s.b > s.a);
    return { label: cut(it.label, SWIMLANE_CAPS.label), state: SWIMLANE_STATES.has(it.state) ? it.state : 'done', from, to: Math.max(to, ...segs.map((s) => s.b)), segs };
  });
  const end = Math.max(1, ...items.map((i) => i.to));
  return { items, end, kinds: byKindOrder(new Set(items.flatMap((i) => i.segs.map((s) => s.k)))) };
}

/** "26 min 4 s": how long a lane ran. */
export const laneDuration = (item) => formatDuration((item.to - item.from) * MS_SEC);

/** A time as a share (0..1) of the lane axis. */
export const share = (seconds, end) => Math.min(1, Math.max(0, seconds / end));
