// venn.js - `venn`: overlap between two or three sets (which files two agents both touched, which changes tests cover).
// Circle area follows set size; for two sets the distance is solved so the lens area equals the overlap. Three sets place circles
// from the pairwise overlaps, so their areas are approximate (and the asset says so).
import { AssetError, check, each, defineAsset, s, txt, tip, catColor, textWidth, ellipsize, fmt, clamp, px } from './core.js';

const MAX_ITEMS_KEPT = 8;
const ITEMS_SHOWN = 3;
const ITEM_MAX = 40;
const LABEL_MAX = 30;
const UNIT_MAX = 12;
const FILL_OPACITY = 0.45;
const STROKE_W = 2;
const SOLVE_STEPS = 48; // bisection iterations for the lens distance
const TOUCH_GAP = 1.04; // disjoint circles sit this far apart (x radii sum)
const MARGIN = 10;
const GRID_PX = 4; // sampling step when looking for the roomiest spot of a region
const SWATCH_R = 6;
const LABEL_GAP = 6;
const MIN_COUNT_ROOM = 0.6; // x font size of clearance needed before a region gets its count without a halo-crowded spot

// ---- validation --------------------------------------------------------------------------------------------------------------------
function validate(d) {
  check.object(d, 'data', ['unit', 'sets', 'overlaps']);
  const ids = new Set();
  const sets = each(d.sets, 'data.sets', { min: 2, max: 3 }, (x, p) => {
    check.object(x, p, ['id', 'label', 'size']);
    const size = check.number(x.size, `${p}.size`, { min: 0 });
    if (size === 0) throw new AssetError(`${p}.size must be above 0 (an empty set cannot be drawn)`);
    return { id: check.id(x.id, `${p}.id`, ids), label: check.string(x.label, `${p}.label`, { max: LABEL_MAX }), size };
  });
  const sizeOf = new Map(sets.map((x) => [x.id, x.size]));
  const seenKeys = new Set();
  const overlaps = d.overlaps === undefined ? [] : each(d.overlaps, 'data.overlaps', { min: 0, max: 4 }, (o, p) => {
    check.object(o, p, ['sets', 'size', 'items']);
    const members = each(o.sets, `${p}.sets`, { min: 2, max: 3 }, (id, ip) => { const t = check.string(id, ip, { max: 40 }); if (!ids.has(t)) throw new AssetError(`${ip} "${t}" is not a set id (ids: ${[...ids].join(', ')})`); return t; });
    if (new Set(members).size !== members.length) throw new AssetError(`${p}.sets lists a set twice`);
    const key = [...members].sort().join('+');
    if (seenKeys.has(key)) throw new AssetError(`${p}.sets ${key} is listed twice: give each overlap once`);
    seenKeys.add(key);
    const size = check.number(o.size, `${p}.size`, { min: 0 });
    const cap = Math.min(...members.map((id) => sizeOf.get(id)));
    if (size > cap) throw new AssetError(`${p}.size ${size} is larger than the smallest set it overlaps (${cap}): an overlap cannot exceed its sets`);
    if (members.length > sets.length) throw new AssetError(`${p}.sets names ${members.length} sets but the asset has ${sets.length}`);
    const items = o.items === undefined ? undefined : each(o.items, `${p}.items`, { min: 0, max: MAX_ITEMS_KEPT }, (t, ip) => check.string(t, ip, { max: ITEM_MAX }));
    return { sets: members, size, items };
  });
  return { unit: check.string(d.unit, 'data.unit', { max: UNIT_MAX, optional: true }) ?? '', sets, overlaps };
}

// ---- geometry (pure) ---------------------------------------------------------------------------------------------------------------
/** Area of the lens where circles of radius a and b, `d` apart, overlap. */
export function lensArea(a, b, d) {
  if (d >= a + b) return 0;
  if (d <= Math.abs(a - b)) return Math.PI * Math.min(a, b) ** 2;
  const ca = clamp((d * d + a * a - b * b) / (2 * d * a), -1, 1);
  const cb = clamp((d * d + b * b - a * a) / (2 * d * b), -1, 1);
  const k = Math.sqrt(Math.max(0, (-d + a + b) * (d + a - b) * (d - a + b) * (d + a + b)));
  return a * a * Math.acos(ca) + b * b * Math.acos(cb) - 0.5 * k;
}
/** Centre distance at which circles a and b overlap by `area`. */
export function solveDistance(a, b, area) {
  if (area <= 0) return (a + b) * TOUCH_GAP;
  let lo = Math.abs(a - b);
  let hi = a + b;
  for (let i = 0; i < SOLVE_STEPS; i++) { const mid = (lo + hi) / 2; if (lensArea(a, b, mid) > area) lo = mid; else hi = mid; }
  return (lo + hi) / 2;
}

/** Circles {id, x, y, r} in unit scale (radius = sqrt(size / pi)); set 0 at the origin, 1 to its right, 2 below by law of cosines. */
export function placeCircles(sets, overlaps) {
  const r = sets.map((x) => Math.sqrt(x.size / Math.PI));
  const pair = (i, j) => overlaps.find((o) => o.sets.length === 2 && o.sets.includes(sets[i].id) && o.sets.includes(sets[j].id))?.size ?? 0;
  const dist = (i, j) => solveDistance(r[i], r[j], pair(i, j));
  const out = [{ id: sets[0].id, x: 0, y: 0, r: r[0] }, { id: sets[1].id, x: dist(0, 1), y: 0, r: r[1] }];
  if (sets.length === 3) {
    const d01 = out[1].x;
    const d02 = dist(0, 2);
    const d12 = dist(1, 2);
    const x = (d02 * d02 - d12 * d12 + d01 * d01) / (2 * d01);
    out.push({ id: sets[2].id, x, y: Math.sqrt(Math.max(0, d02 * d02 - x * x)), r: r[2] });
  }
  return out;
}

/** Every region as {key (set indices), count}: exclusive counts by inclusion-exclusion from the given overlaps (missing = 0). */
export function regionCounts(sets, overlaps) {
  const n = sets.length;
  const inter = (idx) => (idx.length === 1 ? sets[idx[0]].size : overlaps.find((o) => o.sets.length === idx.length && idx.every((i) => o.sets.includes(sets[i].id)))?.size ?? 0);
  const tri = n === 3 ? inter([0, 1, 2]) : 0;
  const out = [];
  for (let mask = 1; mask < 1 << n; mask++) {
    const idx = [...Array(n).keys()].filter((i) => mask & (1 << i));
    let count;
    if (n === 2) count = idx.length === 1 ? inter(idx) - inter([0, 1]) : inter([0, 1]);
    else if (idx.length === 3) count = tri;
    else if (idx.length === 2) count = inter(idx) - tri;
    else count = inter(idx) - [0, 1, 2].filter((j) => j !== idx[0]).reduce((a, j) => a + inter([idx[0], j].sort()), 0) + tri;
    out.push({ idx, count: Math.max(0, count) });
  }
  return out;
}

/** The roomiest point of one region (inside its circles, outside the others), found on a grid: {x, y, room}. */
function roomiest(circles, idx, box) {
  let best = { x: 0, y: 0, room: -Infinity };
  for (let y = box.y0; y <= box.y1; y += GRID_PX) {
    for (let x = box.x0; x <= box.x1; x += GRID_PX) {
      let room = Infinity;
      circles.forEach((c, i) => { const edge = c.r - Math.hypot(x - c.x, y - c.y); room = Math.min(room, idx.includes(i) ? edge : -edge); });
      if (room > best.room) best = { x, y, room };
    }
  }
  return best;
}

// ---- drawing -----------------------------------------------------------------------------------------------------------------------
function drawVenn({ data, svg, w, h, fs, narrow }) {
  const f = Math.max(fs, px.min);
  const three = data.sets.length === 3;
  const topBand = f * 2.6 + MARGIN;
  const botBand = three ? f * 2.6 + px.min * 1.6 + MARGIN : MARGIN;
  const unit = placeCircles(data.sets, data.overlaps);
  const x0 = Math.min(...unit.map((c) => c.x - c.r));
  const x1 = Math.max(...unit.map((c) => c.x + c.r));
  const y0 = Math.min(...unit.map((c) => c.y - c.r));
  const y1 = Math.max(...unit.map((c) => c.y + c.r));
  const availW = w - 2 * MARGIN;
  const availH = h - topBand - botBand;
  const k = Math.max(0.01, Math.min(availW / (x1 - x0), availH / (y1 - y0)));
  const ox = MARGIN + (availW - (x1 - x0) * k) / 2 - x0 * k;
  const oy = topBand + (availH - (y1 - y0) * k) / 2 - y0 * k;
  const circles = unit.map((c) => ({ x: ox + c.x * k, y: oy + c.y * k, r: c.r * k }));

  circles.forEach((c, i) => {
    const set = data.sets[i];
    svg.append(tip(s('circle', { cx: c.x, cy: c.y, r: c.r, fill: catColor(i), 'fill-opacity': FILL_OPACITY, stroke: catColor(i), 'stroke-width': STROKE_W, class: 'pa-in' }), `${set.label}: ${fmt(set.size, data.unit)}`));
  });

  // set labels sit outside the circles: first two on the top corners, the third below
  const slots = [{ x: MARGIN, y: MARGIN + f * 0.7, anchor: 'start' }, { x: w - MARGIN, y: MARGIN + f * 0.7, anchor: 'end' }, { x: w / 2, y: h - botBand + f * 0.9, anchor: 'middle' }];
  const room = (w - 2 * MARGIN) / 2 - SWATCH_R * 2 - LABEL_GAP * 2;
  data.sets.forEach((set, i) => {
    const sl = slots[i];
    const lw = Math.min(room, textWidth(set.label, f, 700));
    const sw = sl.anchor === 'start' ? sl.x + SWATCH_R : sl.anchor === 'end' ? sl.x - SWATCH_R : sl.x - lw / 2 - SWATCH_R - 4;
    const tx = sl.anchor === 'start' ? sl.x + SWATCH_R * 2 + LABEL_GAP : sl.anchor === 'end' ? sl.x - SWATCH_R * 2 - 6 : sl.x + SWATCH_R;
    svg.append(s('circle', { cx: sw, cy: sl.y, r: SWATCH_R, fill: catColor(i), 'fill-opacity': FILL_OPACITY + 0.2, stroke: catColor(i), 'stroke-width': STROKE_W }));
    txt(svg, tx, sl.y, set.label, { size: f, weight: 700, anchor: sl.anchor, maxW: room });
    txt(svg, tx, sl.y + f * 1.2, fmt(set.size, data.unit), { size: f, cls: 'pa-m', anchor: sl.anchor });
  });

  // region counts at the roomiest spot of each region; item names only where they fit
  const box = { x0: Math.min(...circles.map((c) => c.x - c.r)), x1: Math.max(...circles.map((c) => c.x + c.r)), y0: Math.min(...circles.map((c) => c.y - c.r)), y1: Math.max(...circles.map((c) => c.y + c.r)) };
  const keyOf = (idx) => idx.map((i) => data.sets[i].id).sort().join('+');
  for (const reg of regionCounts(data.sets, data.overlaps)) {
    if (reg.count <= 0) continue;
    const spot = roomiest(circles, reg.idx, box);
    if (spot.room < 0) continue;
    const names = reg.idx.map((i) => data.sets[i].label);
    const items = reg.idx.length > 1 ? data.overlaps.find((o) => [...o.sets].sort().join('+') === keyOf(reg.idx))?.items : undefined;
    const g = svg.appendChild(s('g', {}));
    g.append(s('title', {}, `${reg.idx.length > 1 ? `In ${names.join(' and ')}` : `Only in ${names[0]}`}: ${fmt(reg.count, data.unit)}${items?.length ? ` (${items.join(', ')})` : ''}`));
    const big = f * (spot.room >= f * MIN_COUNT_ROOM ? 1.35 : 1);
    const shown = narrow ? [] : (items ?? []).slice(0, ITEMS_SHOWN);
    const lineH = f * 1.15;
    const fits = shown.filter((_, i) => spot.room >= f * 1.4 + (i + 1) * lineH * 0.5);
    const top = spot.y - ((fits.length * lineH) / 2);
    txt(g, spot.x, top, fmt(reg.count), { size: big, weight: 700, anchor: 'middle', cls: 'pa-t pa-halo' });
    fits.forEach((it, i) => txt(g, spot.x, top + big * 0.95 + i * lineH, ellipsize(it, spot.room * 1.8, px.min), { size: px.min, anchor: 'middle', cls: 'pa-m pa-halo' }));
  }
  if (three) txt(svg, w - MARGIN, h - MARGIN, 'Areas approximate with three sets', { size: px.min, anchor: 'end', cls: 'pa-m', maxW: w - 2 * MARGIN });
}

export const venn = defineAsset({
  kind: 'venn',
  shape: 'overlap between two or three sets (files touched by both agents, changes covered by tests, what is shared vs unique)',
  summary: 'Overlapping circles sized by set size; counts in each region (only A, A and B, ...), a few example names in the overlaps. Two sets are area-exact; three are approximate.',
  keys: ['unit', 'sets', 'overlaps'],
  aspect: 0.7,
  minH: 300,
  maxH: 540,
  sample: {
    unit: 'files',
    sets: [{ id: 'plan', label: 'Planner edits', size: 38 }, { id: 'rev', label: 'Reviewer touched', size: 31 }, { id: 'test', label: 'Covered by tests', size: 44 }],
    overlaps: [
      { sets: ['plan', 'rev'], size: 12, items: ['core.js', 'index.js', 'flow.js'] },
      { sets: ['plan', 'test'], size: 20, items: ['layout.js', 'venn.js'] },
      { sets: ['rev', 'test'], size: 15, items: ['filetree.js'] },
      { sets: ['plan', 'rev', 'test'], size: 9, items: ['hierarchy.js', 'board-frames.ts'] },
    ],
  },
  validate,
  draw: drawVenn,
});
