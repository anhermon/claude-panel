import { plainTitle } from '../../kit/panel/plain-title.mjs';
// Pure logic of the four workflow-insight frames (frames/kindstack.js, sinks.js, repeats.js, hints.js): normalising what the
// mod sent (hooks/insight-time.ts, insight-repeats.ts, insight-hints.ts; a hand-sent frame of the same type goes through the
// same door), the little arithmetic of the drawings (which slices have room for a word, how dark a heat cell is), and an
// estimate of the height each frame needs (grid-plan.mjs uses it to pick a size). No DOM, no clock. Tested by
// insight-frames-logic.test.mjs.
import { KIND_IDS, isKind, kindMeta } from './kind-meta.mjs';
import { routerBodyPx } from './router-frames-logic.mjs';

export const INSIGHT_TYPES = Object.freeze(['kindstack', 'sinks', 'repeats', 'hints', 'tickets', 'checks']); // tickets / checks: router-frames-logic.mjs
export const isInsightType = (type) => INSIGHT_TYPES.includes(type);

export const IX_CAPS = Object.freeze({
  rows: 8, segs: 12, label: 24, text: 140, caption: 160, foot: 70, sinks: 6, notes: 4, cols: 5, matrixRows: 5, hints: 4, detail: 3,
});
const PCT_MAX = 100;
/** A slice gets its word inside when its share of the bar leaves room: a base plus a share per character (a narrow bar is ~330 px, a character ~8 px). */
export const LABEL_BASE_SHARE = 0.05;
export const LABEL_CHAR_SHARE = 0.026;
/** Heat levels of the repeats matrix: 1 (a touch) to HEAT_LEVELS (the most touched cell). */
export const HEAT_LEVELS = 4;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const cut = (v, max) => {
  const s = typeof v === 'string' || typeof v === 'number' ? String(v).replace(/\s+/g, ' ').trim() : '';
  return s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
};
const arr = (v, max) => (Array.isArray(v) ? v.slice(0, max) : []);
const count = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : 0);
const kindsInOrder = (set) => KIND_IDS.filter((k) => set.has(k));

// ---- kindstack: one stacked bar per agent ----------------------------------------------------------------------------------
/** Does a slice with this share of the bar have room for its kind's word? */
export const sliceFitsLabel = (share, kind) => share >= LABEL_BASE_SHARE + kindMeta(kind).label.length * LABEL_CHAR_SHARE;

export function normalizeKindStack(f) {
  const items = arr(f.items, IX_CAPS.rows).filter(isObj).map((it) => {
    const raw = arr(it.segs, IX_CAPS.segs).filter((s) => isObj(s) && isKind(s.k) && count(s.s) > 0);
    const total = raw.reduce((a, s) => a + count(s.s), 0);
    const segs = raw.map((s) => ({ k: s.k, s: count(s.s), text: cut(s.text, IX_CAPS.label), share: total > 0 ? count(s.s) / total : 0 }))
      .map((s) => ({ ...s, showLabel: sliceFitsLabel(s.share, s.k) }));
    return { label: cut(plainTitle(it.label, false), IX_CAPS.label), total: cut(it.total, IX_CAPS.label), tokens: cut(it.tokens, IX_CAPS.label), segs, detail: segs.slice(0, IX_CAPS.detail), more: Math.max(0, segs.length - IX_CAPS.detail) };
  }).filter((it) => it.segs.length > 0);
  return { caption: cut(plainTitle(f.caption, false), IX_CAPS.caption), foot: cut(f.foot, IX_CAPS.foot), items, kinds: kindsInOrder(new Set(items.flatMap((it) => it.segs.map((s) => s.k)))) };
}

// ---- sinks: kinds ranked by their share of all time ------------------------------------------------------------------------
export function normalizeSinks(f) {
  const items = arr(f.items, IX_CAPS.sinks).filter((it) => isObj(it) && isKind(it.k))
    .map((it) => ({ k: it.k, pct: Math.min(PCT_MAX, count(it.pct)), text: cut(it.text, IX_CAPS.text), time: cut(it.time, IX_CAPS.label), meta: cut(it.meta, IX_CAPS.label) }));
  return { caption: cut(plainTitle(f.caption, false), IX_CAPS.caption), foot: cut(f.foot, IX_CAPS.foot), items, notes: arr(f.notes, IX_CAPS.notes).map((n) => cut(n, IX_CAPS.text)).filter((n) => n !== '') };
}

// ---- repeats: a file x agent matrix and sentences --------------------------------------------------------------------------
/** How dark a cell is: 0 for none, else 1..HEAT_LEVELS in proportion to the busiest cell. */
export const heatLevel = (n, max) => (n > 0 && max > 0 ? Math.max(1, Math.ceil((n / max) * HEAT_LEVELS)) : 0);

export function normalizeRepeats(f) {
  const cols = arr(f.cols, IX_CAPS.cols).map((c) => cut(plainTitle(c, false), IX_CAPS.label));
  const raw = arr(f.rows, IX_CAPS.matrixRows).filter(isObj).map((r) => ({ label: cut(plainTitle(r.label, false), IX_CAPS.label), note: cut(r.note, IX_CAPS.label), cells: cols.map((_, i) => count(arr(r.cells, IX_CAPS.cols)[i])) }));
  const max = Math.max(0, ...raw.flatMap((r) => r.cells));
  const rows = raw.filter((r) => r.label !== '').map((r) => ({ ...r, levels: r.cells.map((n) => heatLevel(n, max)) }));
  return { caption: cut(plainTitle(f.caption, false), IX_CAPS.caption), cols: rows.length > 0 ? cols : [], rows, foot: rows.length > 0 ? cut(f.foot, IX_CAPS.foot) : '', notes: arr(f.notes, IX_CAPS.notes).map((n) => cut(n, IX_CAPS.text)).filter((n) => n !== '') };
}

// ---- hints: text cards -----------------------------------------------------------------------------------------------------
export function normalizeHints(f) {
  const items = arr(f.items, IX_CAPS.hints).filter(isObj)
    .map((it) => ({ text: cut(it.text, IX_CAPS.text), evidence: cut(it.evidence, IX_CAPS.text), rule: cut(it.rule, IX_CAPS.text) }))
    .filter((it) => it.text !== '');
  return { caption: cut(plainTitle(f.caption, false), IX_CAPS.caption), foot: cut(f.foot, IX_CAPS.foot), items };
}

// ---- the height each frame needs (em of the text floor) ----------------------------------------------------------------------
/** The text floor of the narrowest board (grid-plan.mjs TEXT_FLOOR_MIN_PX; not imported: grid-plan imports this file). */
const DEFAULT_FLOOR_PX = 14;
const EM = Object.freeze({
  headline: 2.7, foot: 1.4, legendRow: 1.5, legendPad: 1.6, legendCompact: 1.5, gap: 0.5,
  ksRow: 6.2, ksRowCompact: 3.6,
  skRow: 3.3, skRowCompact: 2.4, skNotesHead: 1.6, skNote: 1.5,
  rpHead: 1.8, rpRow: 3.0, rpRowCompact: 1.8, rpLegend: 2.8, rpNote: 1.8,
  hnCard: 5.4, hnCardCompact: 3.6,
});

/** Kinds in the legend per line at the narrowest board (a wider one wraps less, so this over-estimates there: safe). */
const LEGEND_PER_LINE = 4;
const kindsOfBars = (items) => new Set((Array.isArray(items) ? items : []).flatMap((it) => (Array.isArray(it?.segs) ? it.segs : []).map((s) => s?.k))).size;

/** Px height of the body of an insight frame at a text floor; `compact` is the tightest wording (no caption, no secondary lines). 0 for another type. */
export function insightBodyPx(frame, { compact = false, floor = DEFAULT_FLOOR_PX } = {}) {
  const cap = (frame.caption ? EM.headline : 0) + (compact || !frame.foot ? 0 : EM.foot);
  const n = (v) => (Array.isArray(v) ? v.length : 0);
  let em = 0;
  if (frame.type === 'kindstack') em = cap + Math.max(1, n(frame.items)) * ((compact ? EM.ksRowCompact : EM.ksRow) + EM.gap) + (compact ? EM.legendCompact : EM.legendRow * Math.max(1, Math.ceil(kindsOfBars(frame.items) / LEGEND_PER_LINE)) + EM.legendPad);
  else if (frame.type === 'sinks') em = cap + Math.max(1, n(frame.items)) * ((compact ? EM.skRowCompact : EM.skRow) + EM.gap) + (n(frame.notes) > 0 && !compact ? EM.skNotesHead + n(frame.notes) * EM.skNote : 0);
  else if (frame.type === 'repeats') em = cap + (n(frame.rows) > 0 ? EM.rpHead + n(frame.rows) * (compact ? EM.rpRowCompact : EM.rpRow) + (compact ? 0 : EM.rpLegend) : 0) + (compact ? 0 : n(frame.notes) * EM.rpNote);
  else if (frame.type === 'hints') em = cap + Math.max(1, n(frame.items)) * ((compact ? EM.hnCardCompact : EM.hnCard) + EM.gap);
  else return routerBodyPx(frame, { compact, floor });
  return Math.round(em * floor);
}
