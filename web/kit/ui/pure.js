// pure.js - DOM-free, import-free logic behind panel/ui (unit-tested with node --test, see web/ui-kit.test.mjs).
// Scales/axes/shapes live in the chart files (d3); everything here is plain data in, plain data out.

export const MS = Object.freeze({ second: 1000, minute: 60000, hour: 3600000, day: 86400000 });
export const EPOCH_MS_MIN = 1e11; // numbers above this are read as epoch milliseconds, below as plain units
const PERCENT = 100;
const COMPACT_STEPS = [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'k']];
const TIME_STEPS = [[1, 2, 5, 10, 15, 30].map((n) => n * MS.second), [1, 2, 5, 10, 15, 30].map((n) => n * MS.minute),
  [1, 2, 3, 6, 12].map((n) => n * MS.hour), [1, 2, 7, 30].map((n) => n * MS.day)].flat();
const NICE_STEPS = [1, 2, 2.5, 5, 10];
const GOOD_TONE = 'ok';
const BAD_TONE = 'danger';
const FLAT_TONE = 'neutral';
export const TONES = Object.freeze(['neutral', 'info', 'ok', 'warn', 'danger']);
export const STEP_STATES = Object.freeze(['todo', 'doing', 'done', 'failed']);

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const lerp = (a, b, t) => a + (b - a) * t;
export const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
export const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
export const toArray = (v) => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);
export const easeOutCubic = (t) => 1 - (1 - clamp(t, 0, 1)) ** 3;
export const easeInOut = (t) => { const x = clamp(t, 0, 1); return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2; };

/** Value of a tween at progress t (0..1): from -> to through `ease`. Non-numbers snap to `to`. */
export function tweenAt(from, to, t, ease = easeOutCubic) {
  if (!isNum(from) || !isNum(to)) return to;
  return t >= 1 ? to : lerp(from, to, ease(t));
}

/** Progress 0..1 of a tween that started at `start`, now `now`, lasting `ms` (ms <= 0 is instantly done). */
export const progressAt = (start, now, ms) => (ms <= 0 ? 1 : clamp((now - start) / ms, 0, 1));

/** Number -> text. opts: decimals (default: 0 for integers else up to 2), compact (1.2k), prefix, suffix, sign (force +). */
export function formatNumber(v, opts = {}) {
  if (!isNum(v)) return v === undefined || v === null ? '' : String(v);
  const { decimals, compact = false, prefix = '', suffix = '', sign = false } = opts;
  let n = v;
  let unit = '';
  if (compact) {
    const hit = COMPACT_STEPS.find(([size]) => Math.abs(n) >= size);
    if (hit) { n /= hit[0]; unit = hit[1]; }
  }
  const d = decimals ?? (Number.isInteger(n) ? 0 : compact && unit ? 1 : 2);
  const body = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: decimals ?? 0, maximumFractionDigits: d });
  const mark = n < 0 ? '-' : sign && n > 0 ? '+' : '';
  return `${mark}${prefix}${body}${unit}${suffix}`;
}

/** Duration ms -> "45 s", "12 min 5 s", "2 h 10 min", "3 d 4 h". */
export function formatDuration(ms) {
  const s = Math.max(0, Math.round(ms / MS.second));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m} min ${s % 60} s` : `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d} d ${h % 24} h` : `${d} d`;
}

/** Tone of a change: delta > 0 is good when goodWhen === 'up' (default), bad when 'down'; 0 is neutral. */
export function deltaTone(delta, goodWhen = 'up') {
  if (!isNum(delta) || delta === 0) return FLAT_TONE;
  return (delta > 0) === (goodWhen !== 'down') ? GOOD_TONE : BAD_TONE;
}

/** Picks the tone of a value from thresholds [{upTo, tone}] in ascending order (the last one catches the rest). */
export function toneForValue(value, thresholds, fallback = 'info') {
  const list = toArray(thresholds).filter((t) => isObj(t));
  const hit = list.find((t) => !isNum(t.upTo) || value <= t.upTo);
  return hit && TONES.includes(hit.tone) ? hit.tone : fallback;
}

/** Fraction 0..1 of value inside [min, max] (a flat or invalid range gives 0). */
export function fraction(value, min = 0, max = 1) {
  return isNum(value) && isNum(min) && isNum(max) && max > min ? clamp((value - min) / (max - min), 0, 1) : 0;
}

/** Progress option -> 0..1. Accepts `value` as 0..1 (max omitted, value <= 1) or value/max. */
export function progressFraction({ value = 0, max } = {}) {
  if (!isNum(value)) return 0;
  return fraction(value, 0, isNum(max) ? max : 1);
}

// ---------------------------------------------------------------------------------------------- table
/** Columns option -> [{key, label, align, type, format?, width?}]; plain strings become text columns. */
export function normalizeColumns(columns, rows = []) {
  const given = toArray(columns);
  const list = given.length ? given : Object.keys(rows[0] ?? {}).map((key) => ({ key }));
  return list.filter((c) => c !== null && c !== undefined).map((c) => {
    const col = isObj(c) ? c : { key: String(c) };
    const sample = rows.find((r) => r && r[col.key] !== undefined && r[col.key] !== null)?.[col.key];
    const type = col.type ?? (isNum(sample) ? 'num' : 'text');
    return { ...col, key: String(col.key), label: col.label ?? String(col.key), type, align: col.align ?? (type === 'num' ? 'right' : 'left') };
  });
}

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
/** Compare two cell values: numbers numerically, everything else as natural text; empty values always last. */
export function compareCells(a, b) {
  const aEmpty = a === undefined || a === null || a === '';
  const bEmpty = b === undefined || b === null || b === '';
  if (aEmpty || bEmpty) return aEmpty === bEmpty ? 0 : aEmpty ? 1 : -1;
  if (isNum(a) && isNum(b)) return a - b;
  return collator.compare(String(a), String(b));
}

/** Rows sorted by `key` (dir 'asc'|'desc'), stable, empty cells last in both directions. Returns a new array. */
export function sortRows(rows, key, dir = 'asc') {
  if (key === undefined || key === null) return rows.slice();
  const sign = dir === 'desc' ? -1 : 1;
  return rows.map((row, i) => ({ row, i })).sort((x, y) => {
    const a = x.row?.[key];
    const b = y.row?.[key];
    const emptyA = a === undefined || a === null || a === '';
    const emptyB = b === undefined || b === null || b === '';
    if (emptyA || emptyB) return compareCells(a, b) || x.i - y.i;
    return sign * compareCells(a, b) || x.i - y.i;
  }).map((x) => x.row);
}

/** Next sort state when a header is clicked: new column -> asc, same column asc -> desc -> off. */
export function nextSort(current, key) {
  if (!current || current.key !== key) return { key, dir: 'asc' };
  return current.dir === 'asc' ? { key, dir: 'desc' } : null;
}

// ---------------------------------------------------------------------------------------------- charts
/**
 * Chart data -> [{name, color?, points:[{x, y, label?}]}].
 *   data: [1,2,3] | [[x,y]] | [{x,y}] | [{label|x, value|y}]    -> one series
 *   series: [{name, data, color?}]                               -> many
 */
export function normalizeSeries({ data, series } = {}) {
  const toPoints = (list) => toArray(list).filter((d) => typeof d === 'object' || isNum(d)).map((d, i) => {
    if (isNum(d)) return { x: i, y: d };
    if (Array.isArray(d)) return { x: d[0], y: Number(d[1]) };
    const o = isObj(d) ? d : {};
    const x = o.x ?? o.label ?? o.name ?? i;
    return { x, y: Number(o.y ?? o.value ?? 0), ...(o.color ? { color: o.color } : {}), ...(o.label !== undefined && o.x !== undefined ? { label: o.label } : {}) };
  }).filter((p) => Number.isFinite(p.y));
  if (Array.isArray(series) && series.length) {
    return series.filter(isObj).map((s, i) => ({ name: s.name ?? `Series ${i + 1}`, ...(s.color ? { color: s.color } : {}), points: toPoints(s.data ?? s.values) }));
  }
  return [{ name: '', points: toPoints(data) }];
}

/** 'time' (Date / epoch ms in a time axis), 'num' or 'cat' for the x values of a set of series. */
export function inferKind(allX) {
  if (allX.length && allX.every((x) => x instanceof Date)) return 'time';
  if (allX.length && allX.every(isNum)) return 'num';
  return 'cat';
}

/** Largest y a bar chart needs, stacked or not (0 baseline included). */
export function yExtent(seriesList, stacked = false) {
  const ys = seriesList.flatMap((s) => s.points.map((p) => p.y));
  if (!ys.length) return [0, 1];
  if (stacked) {
    const sums = new Map();
    for (const s of seriesList) for (const p of s.points) sums.set(String(p.x), (sums.get(String(p.x)) ?? 0) + p.y);
    return [Math.min(0, ...ys), Math.max(...sums.values())];
  }
  return [Math.min(0, ...ys), Math.max(0, ...ys)];
}

/** Donut slices: [{label, value, pct (0..1), start, end}] in radians from 12 o'clock; non-positive values are dropped. */
export function donutSlices(items) {
  const list = toArray(items).map((d) => (isObj(d) ? d : { value: d })).filter((d) => isNum(d.value) && d.value > 0);
  const total = list.reduce((sum, d) => sum + d.value, 0);
  let angle = 0;
  return list.map((d, i) => {
    const pct = total ? d.value / total : 0;
    const slice = { label: d.label ?? d.name ?? `Item ${i + 1}`, value: d.value, color: d.color, pct, start: angle, end: angle + pct * 2 * Math.PI };
    angle = slice.end;
    return slice;
  });
}

/** Heatmap cells -> {xs, ys, cells:[{x,y,value,step}], min, max}; `step` 0..steps-1 buckets the value. */
export function heatGrid(cells, steps = 5) {
  const list = toArray(cells).filter((c) => isObj(c) && isNum(c.value));
  const xs = [...new Set(list.map((c) => String(c.x)))];
  const ys = [...new Set(list.map((c) => String(c.y)))];
  const values = list.map((c) => c.value);
  const min = values.length ? Math.min(...values) : 0;
  const max = values.length ? Math.max(...values) : 0;
  return { xs, ys, min, max, cells: list.map((c) => ({ x: String(c.x), y: String(c.y), value: c.value, step: max > min ? Math.min(steps - 1, Math.floor(((c.value - min) / (max - min)) * steps)) : 0 })) };
}

/** "Nice" tick step >= raw (1, 2, 2.5, 5, 10 times a power of ten). */
export function niceStep(raw) {
  if (!(raw > 0)) return 1;
  const pow = 10 ** Math.floor(Math.log10(raw));
  return (NICE_STEPS.find((s) => s * pow >= raw * (1 - 1e-9)) ?? 10) * pow;
}

// ---------------------------------------------------------------------------------------------- timeline
/** Epoch ms from a number, Date or ISO string; null when it is none of them. */
export function toTime(v) {
  if (isNum(v)) return v;
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'string') { const t = Date.parse(v); return Number.isNaN(t) ? null : t; }
  return null;
}

/** Tick positions for a time (or unit) axis over [t0, t1]: about `count` ticks on a round step. */
export function timeTicks(t0, t1, count = 5) {
  if (!(t1 > t0)) return [t0];
  const raw = (t1 - t0) / Math.max(1, count);
  const isTime = t1 > EPOCH_MS_MIN;
  const step = isTime ? (TIME_STEPS.find((s) => s >= raw) ?? TIME_STEPS[TIME_STEPS.length - 1]) : niceStep(raw);
  const ticks = [];
  for (let t = Math.ceil(t0 / step) * step; t <= t1 + 1e-9; t += step) ticks.push(t);
  return ticks;
}

/**
 * Timeline option -> {lanes:[{id,label,sub,items:[...]}], from, to, now}. Accepts
 *   lanes + items:[{lane, start, end?, label, state}]  or the agent-gantt shape  rows:[{name, sub, start, end?, state}] (+ now).
 * Items without `end` that are `running` stretch to now; without state they are milestones (a point in time).
 */
export function normalizeTimeline({ lanes, items, rows, now, from, to } = {}) {
  const laneList = [];
  const laneById = new Map();
  const lane = (id, label, sub) => {
    if (!laneById.has(id)) { const l = { id, label: label ?? String(id), sub, items: [] }; laneById.set(id, l); laneList.push(l); }
    return laneById.get(id);
  };
  for (const l of toArray(lanes)) { const o = isObj(l) ? l : { id: l }; lane(String(o.id ?? o.label), o.label, o.sub); }
  const nowT = toTime(now);
  const push = (laneId, raw) => {
    const start = toTime(raw.start);
    if (start === null) return;
    const end = toTime(raw.end);
    const state = raw.state ?? (end === null && raw.milestone ? 'milestone' : end === null ? 'running' : 'done');
    const open = end === null && state !== 'milestone' && raw.milestone !== true;
    lane(String(laneId)).items.push({ ...raw, start, end: open ? (nowT ?? start) : end ?? start, state, open, milestone: state === 'milestone' || raw.milestone === true });
  };
  for (const it of toArray(items).filter(isObj)) push(it.lane ?? it.row ?? '', it);
  for (const r of toArray(rows).filter(isObj)) { lane(String(r.name), r.name, r.sub); push(r.name, { ...r, label: r.label ?? '' }); }
  const all = laneList.flatMap((l) => l.items);
  const lo = toTime(from) ?? (all.length ? Math.min(...all.map((i) => i.start)) : 0);
  let hi = toTime(to) ?? Math.max(nowT ?? -Infinity, ...all.map((i) => i.end));
  if (!Number.isFinite(hi) || hi <= lo) hi = lo + 1;
  return { lanes: laneList, from: lo, to: hi, now: nowT };
}

/** Left/width of a bar as percentages of [from, to]; a bar is never thinner than minPct. */
export function barBox(start, end, from, to, minPct = 0.6) {
  const span = to - from;
  const left = clamp(((start - from) / span) * PERCENT, 0, PERCENT);
  const right = clamp(((end - from) / span) * PERCENT, 0, PERCENT);
  const width = Math.max(minPct, right - left);
  return { left: Math.min(left, PERCENT - width), width };
}

// ---------------------------------------------------------------------------------------------- kanban
/** Kanban option -> [{id,title,tone,limit,cards:[{id,title,...}]}]. `cards` may be flat with a `column` id. */
export function normalizeKanban({ columns, cards } = {}) {
  const cols = toArray(columns).filter((c) => c !== null && c !== undefined).map((c) => {
    const o = isObj(c) ? c : { id: String(c) };
    return { ...o, id: String(o.id ?? o.title), title: o.title ?? String(o.id), cards: toArray(o.cards).map((x) => (isObj(x) ? x : { title: String(x) })) };
  });
  const byId = new Map(cols.map((c) => [c.id, c]));
  for (const card of toArray(cards).filter(isObj)) byId.get(String(card.column))?.cards.push(card);
  let n = 0;
  for (const col of cols) for (const card of col.cards) { card.id = String(card.id ?? `${col.id}:${card.title}:${n++}`); }
  return cols;
}

// ---------------------------------------------------------------------------------------------- form
/** Form field default value per type. */
export function defaultFieldValue(field) {
  if (field.value !== undefined) return field.value;
  switch (field.type) {
    case 'toggle': return false;
    case 'number': case 'slider': return field.min ?? 0;
    case 'select': return normalizeOptions(field.options)[0]?.value ?? '';
    default: return '';
  }
}

/** Select options: ['a', {value, label}] -> [{value, label}]. */
export function normalizeOptions(options) {
  return toArray(options).map((o) => (isObj(o) ? { value: o.value ?? o.label, label: o.label ?? String(o.value) } : { value: o, label: String(o) }));
}

/** Raw DOM input value -> typed value for the field (numbers clamped to min/max; '' stays '' for number inputs). */
export function coerceField(field, raw) {
  switch (field.type) {
    case 'toggle': return Boolean(raw);
    case 'number': case 'slider': {
      if (raw === '' || raw === null || raw === undefined) return '';
      const n = Number(raw);
      if (!Number.isFinite(n)) return '';
      return clamp(n, isNum(field.min) ? field.min : -Infinity, isNum(field.max) ? field.max : Infinity);
    }
    case 'select': {
      const match = normalizeOptions(field.options).find((o) => String(o.value) === String(raw));
      return match ? match.value : raw;
    }
    default: return String(raw ?? '');
  }
}

// ---------------------------------------------------------------------------------------------- markdown-lite
const INLINE_RE = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*)|(\[[^\]]+\]\((https?:\/\/[^)\s]+)\))/;

/** Inline markdown -> nodes: strings and {t:'code'|'b'|'i'|'a', text, href?}. No HTML is ever produced. */
export function parseInline(src) {
  const out = [];
  let rest = String(src ?? '');
  for (let m = INLINE_RE.exec(rest); m; m = INLINE_RE.exec(rest)) {
    if (m.index) out.push(rest.slice(0, m.index));
    if (m[1]) out.push({ t: 'code', text: m[1].slice(1, -1) });
    else if (m[2]) out.push({ t: 'b', text: m[2].slice(2, -2) });
    else if (m[3]) out.push({ t: 'i', text: m[3].slice(1, -1) });
    else out.push({ t: 'a', text: m[4].slice(1, m[4].indexOf(']')), href: m[5] });
    rest = rest.slice(m.index + m[0].length);
  }
  if (rest) out.push(rest);
  return out;
}

const HEADING_RE = /^(#{1,3})\s+(.*)$/;
const BULLET_RE = /^\s*[-*]\s+(.*)$/;
const ORDERED_RE = /^\s*\d+[.)]\s+(.*)$/;
const QUOTE_RE = /^>\s?(.*)$/;
const FENCE_RE = /^```/;

/** Markdown-lite -> blocks: {t:'h',level,text} {t:'p',text} {t:'ul'|'ol',items[]} {t:'quote',text} {t:'code',text}. */
export function parseMarkdown(src) {
  const lines = String(src ?? '').replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let para = [];
  const flush = () => { if (para.length) { blocks.push({ t: 'p', text: para.join(' ') }); para = []; } };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m;
    if (FENCE_RE.test(line)) {
      flush();
      const body = [];
      for (i++; i < lines.length && !FENCE_RE.test(lines[i]); i++) body.push(lines[i]);
      blocks.push({ t: 'code', text: body.join('\n') });
    } else if (line.trim() === '') flush();
    else if ((m = HEADING_RE.exec(line))) { flush(); blocks.push({ t: 'h', level: m[1].length, text: m[2] }); }
    else if ((m = BULLET_RE.exec(line)) || (m = ORDERED_RE.exec(line))) {
      flush();
      const t = BULLET_RE.test(line) ? 'ul' : 'ol';
      const last = blocks[blocks.length - 1];
      if (last && last.t === t) last.items.push(m[1]); else blocks.push({ t, items: [m[1]] });
    } else if ((m = QUOTE_RE.exec(line))) {
      flush();
      const last = blocks[blocks.length - 1];
      if (last && last.t === 'quote') last.text += ` ${m[1]}`; else blocks.push({ t: 'quote', text: m[1] });
    } else para.push(line.trim());
  }
  flush();
  return blocks;
}

// ---------------------------------------------------------------------------------------------- sparkline, gauge
const DEG = Math.PI / 180;
const round = (n) => Math.round(n * 100) / 100;

/** Sparkline geometry: {d, area, last:{x,y}, fx, fy}. Points spread over [pad, w-pad] x [pad, h-pad]; flat data draws a mid line. fx/fy = last point as 0..1. */
export function sparkPath(values, w, h, pad = 2) {
  const v = toArray(values).filter(isNum);
  if (!v.length) return { d: '', area: '', last: { x: 0, y: 0 }, fx: 0, fy: 0 };
  const lo = Math.min(...v);
  const hi = Math.max(...v);
  const pts = v.map((y, i) => ({
    x: v.length === 1 ? w / 2 : pad + (i / (v.length - 1)) * (w - 2 * pad),
    y: hi === lo ? h / 2 : pad + (1 - (y - lo) / (hi - lo)) * (h - 2 * pad),
  }));
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${round(p.x)} ${round(p.y)}`).join('');
  const last = pts[pts.length - 1];
  const first = pts[0];
  return { d, area: `${d}L${round(last.x)} ${h}L${round(first.x)} ${h}Z`, last, fx: last.x / w, fy: last.y / h };
}

/** SVG arc path from startDeg to endDeg (0 deg = 12 o'clock, clockwise) on a circle of radius r around (cx, cy). */
export function arcPath(cx, cy, r, startDeg, endDeg) {
  const pt = (deg) => [cx + r * Math.sin(deg * DEG), cy - r * Math.cos(deg * DEG)];
  const [x0, y0] = pt(startDeg);
  const [x1, y1] = pt(endDeg);
  const large = Math.abs(endDeg - startDeg) > 180 ? 1 : 0;
  return `M${round(x0)} ${round(y0)}A${r} ${r} 0 ${large} 1 ${round(x1)} ${round(y1)}`;
}

/** Length of an arc of `sweepDeg` degrees on radius r. */
export const arcLength = (r, sweepDeg) => r * sweepDeg * DEG;

// ---------------------------------------------------------------------------------------------- chart labels
/**
 * Direct-label placement: items [{y}] sorted top to bottom are pushed apart to at least `gap` px and kept inside [lo, hi].
 * Returns new y values in the ORIGINAL item order.
 */
export function spreadLabels(ys, gap, lo, hi) {
  const order = ys.map((y, i) => ({ y, i })).sort((a, b) => a.y - b.y);
  for (let k = 0; k < order.length; k++) order[k].y = Math.max(order[k].y, k ? order[k - 1].y + gap : lo);
  for (let k = order.length - 1; k >= 0; k--) order[k].y = Math.min(order[k].y, k < order.length - 1 ? order[k + 1].y - gap : hi);
  const out = new Array(ys.length);
  for (const o of order) out[o.i] = o.y;
  return out;
}

/** Estimated pixel width of a text at `px` per glyph (charts size their margins from it). */
export const textWidth = (str, px = 7) => String(str ?? '').length * px;
