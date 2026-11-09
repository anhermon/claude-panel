// time.js - things over time: `river` (a streamgraph: what filled the session, layer by layer) and `events` (an annotated timeline: what
// happened when, with notes). Both are about WHEN; river shows volume per kind of work, events shows named moments and spans.
import * as d3 from '../d3/d3.mjs';
import { AssetError, check, each, numbers, defineAsset, s, txt, tip, catColor, toneColor, soft, textWidth, wrap, fmt, clamp, px } from './core.js';

// '' (what validate() returns for no unit) must pass again, so validate() stays idempotent
const unitOf = (u, p) => (u === '' ? '' : check.string(u, p, { max: 12, optional: true }) ?? '');
const MAX_POINTS = 60;
const MAX_LAYERS = 8;
const MAX_EVENTS = 14;
const AXIS_H_EM = 1.9; // bottom band for x labels, in font sizes
const LAYER_OPACITY = 0.78;
const LABEL_FIT = 1.15; // a layer name needs this many font sizes of ribbon thickness to be written inside it
const TICK_GAP = 14;
const UNIT_BAND_PAD = 8;

// ---- river ----------------------------------------------------------------------------------------------------------------------
function validateRiver(d) {
  check.object(d, 'data', ['unit', 'x', 'layers']);
  const x = each(d.x, 'data.x', { max: MAX_POINTS }, (v, p) => (typeof v === 'number' ? check.number(v, p) : check.string(v, p, { max: 24 })));
  const layers = each(d.layers, 'data.layers', { max: MAX_LAYERS }, (l, p) => {
    check.object(l, p, ['name', 'values', 'tone']);
    const values = numbers(l.values, `${p}.values`, { max: MAX_POINTS });
    if (values.length !== x.length) throw new AssetError(`${p}.values has ${values.length} numbers but data.x has ${x.length}: they must match`);
    if (values.some((v) => v < 0)) throw new AssetError(`${p}.values must not be negative`);
    return { name: check.string(l.name, `${p}.name`, { max: 28 }), values, tone: check.tone(l.tone, `${p}.tone`) };
  });
  return { unit: unitOf(d.unit, 'data.unit'), x, layers };
}

function drawRiver({ data, svg, w, h, fs, narrow }) {
  const axisH = fs * AXIS_H_EM;
  const top = data.unit ? px.min + UNIT_BAND_PAD : 6; // the unit gets its own band above the ribbons
  const bottom = h - axisH;
  const n = data.x.length;
  const xs = (i) => (n === 1 ? w / 2 : 4 + ((w - 8) * i) / (n - 1));
  const rows = Array.from({ length: n }, (_, i) => Object.fromEntries(data.layers.map((l, k) => [k, l.values[i]])));
  const series = d3.stack().keys(data.layers.map((_, k) => k)).offset(d3.stackOffsetWiggle).order(d3.stackOrderInsideOut)(rows);
  const lo = Math.min(...series.map((sr) => Math.min(...sr.map((p) => p[0]))));
  const hi = Math.max(...series.map((sr) => Math.max(...sr.map((p) => p[1]))));
  const ys = (v) => top + ((bottom - top) * (v - lo)) / Math.max(1e-9, hi - lo);
  const area = d3.area().x((_, i) => xs(i)).y0((p) => ys(p[0])).y1((p) => ys(p[1])).curve(d3.curveBasis);
  const labels = svg.appendChild(s('g'));
  const taken = []; // label boxes already written; a later (thinner) layer skips its name rather than overlap
  const byPeak = [...series].sort((a, b) => Math.max(...data.layers[b.key].values) - Math.max(...data.layers[a.key].values));
  const nameAt = new Map();
  byPeak.forEach((sr) => {
    const layer = data.layers[sr.key];
    const peak = layer.values.indexOf(Math.max(...layer.values));
    const thick = Math.abs(ys(sr[peak][1]) - ys(sr[peak][0]));
    if (thick < fs * LABEL_FIT) return;
    const half = textWidth(layer.name, fs, 650) / 2 + 2;
    const box = { x: clamp(xs(peak), half, w - half), y: (ys(sr[peak][0]) + ys(sr[peak][1])) / 2 };
    if (taken.some((q) => Math.abs(q.x - box.x) < q.half + half && Math.abs(q.y - box.y) < fs * 1.2)) return;
    taken.push({ ...box, half });
    nameAt.set(sr.key, box);
  });
  series.forEach((sr) => {
    const k = sr.key;
    const layer = data.layers[k];
    const color = layer.tone ? toneColor(layer.tone) : catColor(k);
    const peak = layer.values.indexOf(Math.max(...layer.values));
    svg.insertBefore(tip(s('path', { d: area(sr), fill: color, 'fill-opacity': LAYER_OPACITY, stroke: 'var(--ui-card)', 'stroke-width': 1, class: 'pa-in' }), `${layer.name}: peak ${fmt(layer.values[peak], data.unit)} at ${data.x[peak]}`), labels);
    const box = nameAt.get(k);
    if (box) txt(labels, box.x, box.y, layer.name, { size: fs, anchor: 'middle', weight: 650, cls: 'pa-t pa-halo', maxW: w - 8 });
  });
  // x axis: thin the ticks so labels never touch
  const labelW = Math.max(...data.x.map((v) => textWidth(String(v), fs)));
  const every = Math.max(1, Math.ceil((labelW + TICK_GAP) / Math.max(1, (w - 8) / Math.max(1, n - 1))));
  svg.append(s('line', { x1: 0, x2: w, y1: bottom + 2, y2: bottom + 2, class: 'pa-axis' }));
  data.x.forEach((v, i) => {
    if (i % every !== 0 && i !== n - 1) return;
    if (i % every !== 0 && (n - 1 - i) < every / 2) return;
    const half = labelW / 2;
    txt(svg, clamp(xs(i), half, w - half), bottom + 2 + axisH / 2 + 2, String(v), { size: narrow ? px.min : fs, anchor: 'middle', cls: 'pa-m' });
  });
  if (data.unit) txt(svg, w - 2, px.min / 2 + 3, data.unit, { size: px.min, anchor: 'end', cls: 'pa-d' });
}

export const river = defineAsset({
  kind: 'river',
  shape: 'how the mix of several kinds of work (or tokens, tools, agents) changed over time; volume per layer, not exact values',
  summary: 'Smooth ribbons stacked around a wiggling centre line, one colour per layer, named where thickest. Thickness = amount at that moment.',
  keys: ['unit', 'x', 'layers'],
  aspect: 0.42,
  minH: 200,
  sample: {
    unit: 'tool calls',
    x: ['0m', '5m', '10m', '15m', '20m', '25m', '30m', '35m', '40m', '45m', '50m', '55m'],
    layers: [
      { name: 'Reading', values: [9, 12, 10, 6, 4, 3, 2, 3, 2, 2, 1, 1] },
      { name: 'Editing', values: [0, 2, 5, 9, 12, 10, 7, 4, 3, 2, 1, 0] },
      { name: 'Testing', values: [0, 0, 1, 2, 4, 8, 12, 9, 6, 5, 3, 1] },
      { name: 'Debugging', values: [0, 0, 0, 1, 2, 3, 6, 11, 7, 3, 1, 0] },
      { name: 'Writing docs', values: [0, 0, 0, 0, 0, 0, 1, 2, 5, 9, 10, 6] },
    ],
  },
  validate: validateRiver,
  draw: drawRiver,
});

// ---- events ---------------------------------------------------------------------------------------------------------------------
const MARK_R = 5;
const SPAN_H = 8;
const BOX_MAX_W = 190;
const BOX_MIN_W = 96;
const BOX_GAP = 8;
const LEADER_GAP = 10;
const NOTE_LINES = 2;
const ROW_GAP = 12;
const GROW_MAX = 1.6; // taller than the box by this factor is acceptable before notes are shortened

function validateEvents(d) {
  check.object(d, 'data', ['unit', 'items']);
  const when = (v, p, optional) => (typeof v === 'number' ? check.number(v, p) : check.string(v, p, { max: 24, optional }));
  const items = each(d.items, 'data.items', { max: MAX_EVENTS }, (it, p) => {
    check.object(it, p, ['at', 'end', 'label', 'note', 'tone']);
    return { at: when(it.at, `${p}.at`), end: it.end === undefined ? undefined : when(it.end, `${p}.end`), label: check.string(it.label, `${p}.label`, { max: 48 }), note: check.string(it.note, `${p}.note`, { max: 140, optional: true }), tone: check.tone(it.tone, `${p}.tone`) };
  });
  const numeric = items.every((it) => typeof it.at === 'number' && (it.end === undefined || typeof it.end === 'number'));
  if (numeric) items.sort((a, b) => a.at - b.at);
  return { unit: unitOf(d.unit, 'data.unit'), items };
}

const whenText = (it, unit) => {
  const one = (v) => (typeof v === 'number' ? fmt(v, unit) : v);
  return it.end === undefined ? one(it.at) : `${one(it.at)} - ${one(it.end)}`;
};
const colorOf = (it) => toneColor(it.tone, 'var(--ui-acc)');

/** Increases the stage to `need` px when the content is taller than the box (the non-fill case); returns the usable height. */
function growTo(ctx, need) {
  if (ctx.fill || need <= ctx.h) return ctx.h;
  ctx.root.style.height = `${need}px`;
  ctx.svg.setAttribute('height', need);
  ctx.svg.setAttribute('viewBox', `0 0 ${ctx.w} ${need}`);
  return need;
}

function drawEventsWide(ctx) {
  const { data, svg, w, fs } = ctx;
  const items = data.items;
  const numeric = items.every((it) => typeof it.at === 'number' && (it.end === undefined || typeof it.end === 'number'));
  const lo = numeric ? Math.min(...items.map((it) => it.at)) : 0;
  const hi = numeric ? Math.max(...items.map((it) => it.end ?? it.at)) : items.length - 1;
  const pad = BOX_MIN_W / 2 + 4;
  const px = (i, v) => (hi === lo ? w / 2 : pad + ((w - 2 * pad) * ((numeric ? v : i) - lo)) / (hi - lo));
  const boxW = clamp((w - 2 * pad) / Math.max(2, Math.ceil(items.length / 2)) + 20, BOX_MIN_W, BOX_MAX_W);
  const fits = (noteLines) => {
    const placed = items.map((it, i) => {
      const x = px(i, it.at);
      const note = it.note && noteLines ? wrap(it.note, boxW, px.min, noteLines) : [];
      return { it, i, x, x1: it.end === undefined ? x : px(i, it.end), note, bh: fs * 1.25 + px.min * 1.2 + note.length * px.min * 1.2 };
    });
    const levels = { up: [], down: [] };
    placed.forEach((p, k) => {
      p.side = k % 2 === 0 ? 'up' : 'down';
      const left = clamp(p.x - boxW / 2, 4, w - boxW - 4);
      p.left = left;
      let lv = 0;
      while ((levels[p.side][lv] ?? []).some((q) => left < q.left + boxW + BOX_GAP && q.left < left + boxW + BOX_GAP)) lv++;
      (levels[p.side][lv] ??= []).push(p);
      p.lv = lv;
    });
    const levelH = Math.max(...placed.map((p) => p.bh)) + LEADER_GAP;
    return { placed, levelH, up: levels.up.length, down: levels.down.length };
  };
  let g = fits(NOTE_LINES);
  const half = (x) => Math.max(g.up, g.down, 1) * x.levelH;
  for (const nl of [NOTE_LINES, 1, 0]) { g = fits(nl); if (half(g) * 2 + 20 <= ctx.h * GROW_MAX) break; }
  const need = Math.max(ctx.h, Math.max(g.up, 1) * g.levelH + Math.max(g.down, 1) * g.levelH + 24);
  const H = growTo(ctx, need);
  const spineY = clamp(H / 2 + ((Math.max(g.up, 1) - Math.max(g.down, 1)) * g.levelH) / 2, 12, H - 12);
  svg.append(s('line', { x1: pad - MARK_R, x2: w - pad + MARK_R, y1: spineY, y2: spineY, class: 'pa-axis', 'stroke-width': 2 }));
  g.placed.forEach((p) => {
    const c = colorOf(p.it);
    const dir = p.side === 'up' ? -1 : 1;
    const boxEdge = spineY + dir * (MARK_R + LEADER_GAP + p.lv * g.levelH);
    const far = boxEdge + dir * (p.bh);
    svg.append(s('line', { x1: p.x, x2: p.x, y1: spineY, y2: boxEdge, stroke: soft(c, 55), 'stroke-width': 1.5 }));
    if (p.it.end !== undefined) svg.append(tip(s('rect', { x: p.x, y: spineY - SPAN_H / 2, width: Math.max(SPAN_H, p.x1 - p.x), height: SPAN_H, rx: SPAN_H / 2, fill: c }), `${p.it.label}: ${whenText(p.it, data.unit)}`));
    else svg.append(tip(s('circle', { cx: p.x, cy: spineY, r: MARK_R, fill: c, stroke: 'var(--ui-card)', 'stroke-width': 2 }), `${p.it.label}: ${whenText(p.it, data.unit)}`));
    const top = Math.min(boxEdge, far);
    const lx = p.left;
    const g2 = svg.appendChild(s('g'));
    // the block reads from the leader outward: time (small), label, note
    let y = dir < 0 ? top + p.bh - px.min * 0.6 : top + px.min * 0.6;
    const rows = [[whenText(p.it, data.unit), px.min, 'pa-d'], [p.it.label, fs, 'pa-t'], ...p.note.map((l) => [l, px.min, 'pa-m'])];
    if (dir < 0) rows.reverse();
    for (const [text, size, cls] of rows) {
      y += dir < 0 ? -0 : 0;
      txt(g2, lx, dir < 0 ? y - (size * 1.2) / 2 : y + (size * 1.2) / 2, text, { size, cls, maxW: boxW, weight: cls === 'pa-t' ? 650 : undefined });
      y += dir < 0 ? -size * 1.2 : size * 1.2;
    }
  });
}

function drawEventsNarrow(ctx) {
  const { data, svg, w, fs } = ctx;
  const x0 = MARK_R + 6;
  const textX = x0 + MARK_R + 12;
  const room = w - textX - 4;
  const rows = data.items.map((it) => {
    const note = it.note ? wrap(it.note, room, px.min, NOTE_LINES) : [];
    return { it, note, rh: fs * 1.25 + px.min * 1.25 + note.length * px.min * 1.2 + ROW_GAP };
  });
  const total = rows.reduce((a, r) => a + r.rh, 0);
  growTo(ctx, total + 8);
  let y = 4;
  svg.append(s('line', { x1: x0, x2: x0, y1: 4, y2: y + total - ROW_GAP, class: 'pa-axis', 'stroke-width': 2 }));
  rows.forEach(({ it, note, rh }) => {
    const c = colorOf(it);
    const cy = y + px.min * 0.7;
    if (it.end !== undefined) svg.append(tip(s('rect', { x: x0 - SPAN_H / 2, y: cy - MARK_R, width: SPAN_H, height: rh - ROW_GAP, rx: SPAN_H / 2, fill: c }), `${it.label}: ${whenText(it, data.unit)}`));
    else svg.append(tip(s('circle', { cx: x0, cy, r: MARK_R, fill: c, stroke: 'var(--ui-card)', 'stroke-width': 2 }), `${it.label}: ${whenText(it, data.unit)}`));
    txt(svg, textX, cy, whenText(it, data.unit), { size: px.min, cls: 'pa-d', maxW: room });
    txt(svg, textX, cy + fs * 0.65 + px.min * 0.6, it.label, { size: fs, weight: 650, maxW: room });
    note.forEach((l, k) => txt(svg, textX, cy + fs * 1.25 + px.min * 0.6 + (k + 0.5) * px.min * 1.2 + 2, l, { size: px.min, cls: 'pa-m', maxW: room }));
    y += rh;
  });
}

export const events = defineAsset({
  kind: 'events',
  shape: 'named moments and spans on a time line, each with a short note (what happened when; milestones, incidents, phases)',
  summary: 'A spine with markers (spans as thick segments) and labels alternating above and below; stacked in levels so none overlap. Vertical list on narrow widths.',
  keys: ['unit', 'items'],
  aspect: 0.5,
  minH: 240,
  sample: {
    unit: 'min',
    items: [
      { at: 0, label: 'Task received', note: 'Fix flaky checkout test' },
      { at: 4, end: 14, label: 'Reading code', note: '31 files, 3 agents in parallel', tone: 'info' },
      { at: 16, label: 'First failing run', note: '2 of 14 tests red', tone: 'danger' },
      { at: 22, end: 41, label: 'Implementation', note: 'Retry helper + fixture cleanup' },
      { at: 43, label: 'All tests green', tone: 'ok' },
      { at: 47, label: 'Review found a race', note: 'Reviewer agent flagged the fixture order', tone: 'warn' },
      { at: 55, label: 'Merged', note: 'PR 412, 6 files', tone: 'ok' },
    ],
  },
  validate: validateEvents,
  draw: (ctx) => (ctx.narrow ? drawEventsNarrow(ctx) : drawEventsWide(ctx)),
});
