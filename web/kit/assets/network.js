// network.js - relationships: `network` (who connects to whom, a force-laid-out graph with labelled edges) and `mindmap` (a concept map
// branching out of one idea). Both are static: the force layout runs a fixed number of ticks from a deterministic start.
import * as d3 from '../d3/d3.mjs';
import { AssetError, check, each, defineAsset, s, txt, tip, catColor, toneColor, soft, textWidth, ellipsize, wrap, clamp, px } from './core.js';
import { paintArea } from './fit.js';

const MAX_NODES = 40;
const MAX_EDGES = 80;
const MAX_BRANCH_NODES = 40;
const MAX_DEPTH = 3;
const MAX_LABEL = 60;
const TICKS = 320;

// ---- network ----------------------------------------------------------------------------------------------------------------
const R_MIN = 7;
const R_MAX = 18;
const NODE_STROKE = 2;
const LABEL_GAP = 4;
const LABEL_MAX_W = 130;
const LABEL_MAX_W_NARROW = 84;
const ARROW_LEN = 9;
const ARROW_HALF_ANGLE = 0.42;
const BEND = 0.28;
const EDGE_W_MIN = 1.2;
const EDGE_W_SPAN = 2.8;
const EDGE_TINT_PCT = 62;
const NODE_TINT_PCT = 30;
const LEGEND_DOT = 5;
const LEGEND_GAP = 14;
const LINK_STRENGTH = 0.55;
const CHARGE_PER_PX = 1.5;
const CENTER_PULL = 0.07;
const COLLIDE_PAD = 5;
const SEED_RADIUS = 0.3;
const PX2_PER_NODE = 5200; // room per node: a crowded graph gets a taller stage instead of overlapping

function validateNetwork(d) {
  check.object(d, 'data', ['nodes', 'edges']);
  const seen = new Set();
  const nodes = each(d.nodes, 'data.nodes', { max: MAX_NODES }, (n, p) => {
    check.object(n, p, ['id', 'label', 'group', 'size']);
    const id = check.id(n.id, `${p}.id`, seen);
    return { id, label: check.string(n.label, `${p}.label`, { max: MAX_LABEL, optional: true }) ?? id, group: check.string(n.group, `${p}.group`, { max: 24, optional: true }), size: check.number(n.size, `${p}.size`, { min: 0, optional: true }) };
  });
  const edges = each(d.edges, 'data.edges', { min: 0, max: MAX_EDGES }, (e, p) => {
    check.object(e, p, ['from', 'to', 'label', 'weight', 'directed']);
    const end = (k) => { const v = check.string(e[k], `${p}.${k}`, { max: 40 }); if (!seen.has(v)) throw new AssetError(`${p}.${k} "${v}" is not a node id of this network (ids: ${[...seen].slice(0, 12).join(', ')})`); return v; };
    const from = end('from');
    const to = end('to');
    if (from === to) throw new AssetError(`${p} connects "${from}" to itself`);
    return { from, to, label: check.string(e.label, `${p}.label`, { max: 30, optional: true }), weight: check.number(e.weight, `${p}.weight`, { min: 0, optional: true }) ?? 1, directed: check.bool(e.directed, `${p}.directed`) === true };
  });
  return { nodes, edges };
}

const overlap = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const hitsCircle = (r, c) => { const nx = clamp(c.x, r.x, r.x + r.w); const ny = clamp(c.y, r.y, r.y + r.h); return (nx - c.x) ** 2 + (ny - c.y) ** 2 < c.r ** 2; };

/** Deterministic force layout inside the w x h box; returns [{...node, x, y, r}] in input order. */
function forceLayout(data, w, h, padX, padY, rOf) {
  const n = data.nodes.length;
  const base = Math.sqrt((w * h) / n);
  const pts = data.nodes.map((nd, i) => {
    const a = (2 * Math.PI * i) / n;
    return { ...nd, r: rOf(nd), x: w / 2 + Math.cos(a) * w * SEED_RADIUS, y: h / 2 + Math.sin(a) * h * SEED_RADIUS };
  });
  const sim = d3.forceSimulation(pts).stop()
    .force('link', d3.forceLink(data.edges.map((e) => ({ source: e.from, target: e.to }))).id((d) => d.id).distance(base * 0.9).strength(LINK_STRENGTH))
    .force('charge', d3.forceManyBody().strength(-base * CHARGE_PER_PX))
    .force('x', d3.forceX(w / 2).strength(CENTER_PULL * (h / w)))
    .force('y', d3.forceY(h / 2).strength(CENTER_PULL * (w / h)))
    .force('collide', d3.forceCollide((d) => d.r + COLLIDE_PAD));
  for (let i = 0; i < TICKS; i++) sim.tick();
  // stretch the cloud to the padded box so it uses the space and nothing leaves it
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const fit = (v, lo, hi, a, b) => (hi - lo < 1e-6 ? (a + b) / 2 : a + ((v - lo) * (b - a)) / (hi - lo));
  for (const p of pts) { p.x = fit(p.x, x0, x1, padX, w - padX); p.y = fit(p.y, y0, y1, padY, h - padY); }
  return pts;
}

/** Quadratic curve geometry for one edge: control point bent per parallel edge so a<->b pairs separate. */
function edgeGeometry(a, b, bend) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const c = { x: (a.x + b.x) / 2 - uy * len * bend, y: (a.y + b.y) / 2 + ux * len * bend };
  const toward = (p, q, r) => { const vx = q.x - p.x; const vy = q.y - p.y; const l = Math.hypot(vx, vy) || 1; return { x: p.x + (vx / l) * r, y: p.y + (vy / l) * r }; };
  const p0 = toward(a, c, a.r + NODE_STROKE);
  const p1 = toward(b, c, b.r + NODE_STROKE);
  return { p0, p1, c, mid: { x: 0.25 * p0.x + 0.5 * c.x + 0.25 * p1.x, y: 0.25 * p0.y + 0.5 * c.y + 0.25 * p1.y } };
}

function drawNetwork(ctx) {
  const { data, svg, w, fs, narrow } = ctx;
  const { g: area, h } = paintArea(ctx, (data.nodes.length * PX2_PER_NODE) / w);
  const groups = [...new Set(data.nodes.map((n) => n.group).filter(Boolean))];
  const degree = new Map(data.nodes.map((n) => [n.id, 0]));
  for (const e of data.edges) { degree.set(e.from, degree.get(e.from) + 1); degree.set(e.to, degree.get(e.to) + 1); }
  const sizeOf = (n) => n.size ?? degree.get(n.id) + 1;
  const top = Math.max(...data.nodes.map(sizeOf), 1e-9);
  const scale = clamp(Math.min(w, h) / 380, 0.75, 1.15);
  const rOf = (n) => (R_MIN + (R_MAX - R_MIN) * Math.sqrt(sizeOf(n) / top)) * scale;
  const labelFs = Math.max(px.min, fs * 0.92);
  const labelMax = narrow ? LABEL_MAX_W_NARROW : LABEL_MAX_W;
  const legendH = groups.length > 1 ? labelFs * 1.8 : 0;
  const padX = R_MAX * scale + (narrow ? 6 : 16);
  const padY = R_MAX * scale + labelFs + 6;
  const pts = forceLayout(data, w, h - legendH, padX + (narrow ? 0 : 20), padY, rOf);
  for (const p of pts) p.y += legendH;
  const byId = new Map(pts.map((p) => [p.id, p]));
  const colorOf = (p) => (p.group ? catColor(groups.indexOf(p.group)) : 'var(--ui-acc)');
  const wmax = Math.max(...data.edges.map((e) => e.weight), 1e-9);
  const edgeLayer = area.appendChild(s('g', { fill: 'none' }));
  const nodeLayer = area.appendChild(s('g'));
  const labelLayer = area.appendChild(s('g'));
  const placed = [];

  // parallel edges between the same pair bend apart
  const pairs = new Map();
  for (const e of data.edges) { const k = [e.from, e.to].sort().join('\u0000'); pairs.set(k, [...(pairs.get(k) ?? []), e]); }
  const geoms = data.edges.map((e) => {
    const group = pairs.get([e.from, e.to].sort().join('\u0000'));
    const canon = e.from < e.to ? 1 : -1;
    const bend = group.length === 1 ? 0 : (group.indexOf(e) - (group.length - 1) / 2) * 2 * BEND * canon;
    return edgeGeometry(byId.get(e.from), byId.get(e.to), bend);
  });
  data.edges.forEach((e, i) => {
    const { p0, p1, c } = geoms[i];
    const stroke = soft('var(--ui-mut)', EDGE_TINT_PCT);
    const width = EDGE_W_MIN + (e.weight / wmax) * EDGE_W_SPAN;
    let end = p1;
    if (e.directed) { // stop the line at the arrow base so the stroke does not poke through the tip
      const ang = Math.atan2(p1.y - c.y, p1.x - c.x);
      end = { x: p1.x - Math.cos(ang) * ARROW_LEN * 0.8, y: p1.y - Math.sin(ang) * ARROW_LEN * 0.8 };
      const wing = (sgn) => `${p1.x - Math.cos(ang + sgn * ARROW_HALF_ANGLE) * ARROW_LEN},${p1.y - Math.sin(ang + sgn * ARROW_HALF_ANGLE) * ARROW_LEN}`;
      edgeLayer.append(s('polygon', { points: `${p1.x},${p1.y} ${wing(1)} ${wing(-1)}`, fill: stroke, stroke: 'none' }));
    }
    edgeLayer.append(tip(s('path', { d: `M${p0.x},${p0.y} Q${c.x},${c.y} ${end.x},${end.y}`, stroke, 'stroke-width': width, 'stroke-linecap': 'round' }), `${byId.get(e.from).label} ${e.directed ? '->' : '--'} ${byId.get(e.to).label}${e.label ? `: ${e.label}` : ''}`));
  });

  pts.forEach((p) => {
    const col = colorOf(p);
    nodeLayer.append(tip(s('circle', { cx: p.x, cy: p.y, r: p.r, fill: soft(col, NODE_TINT_PCT), stroke: col, 'stroke-width': NODE_STROKE }), `${p.label}${p.group ? ` (${p.group})` : ''}: ${degree.get(p.id)} connection${degree.get(p.id) === 1 ? '' : 's'}`));
  });
  const circles = pts.map((p) => ({ x: p.x, y: p.y, r: p.r + NODE_STROKE }));
  const free = (rect, selfIdx) => rect.x >= 0 && rect.y >= legendH && rect.x + rect.w <= w && rect.y + rect.h <= h
    && !placed.some((q) => overlap(rect, q)) && !circles.some((c, i) => i !== selfIdx && hitsCircle(rect, c));

  // node labels, biggest first, each at the first free side of its node; a label with no room is dropped (the <title> keeps it)
  const lh = labelFs * 1.25;
  [...pts.keys()].sort((a, b) => pts[b].r - pts[a].r).forEach((i) => {
    const p = pts[i];
    for (const cap of [labelMax, labelMax * 0.6]) {
      const text = ellipsize(p.label, cap, labelFs, 600);
      if (!text) continue;
      const tw = textWidth(text, labelFs, 600);
      const gap = p.r + NODE_STROKE + LABEL_GAP;
      const tries = [
        { anchor: 'start', x: p.x + gap, y: p.y, rect: { x: p.x + gap, y: p.y - lh / 2, w: tw, h: lh } },
        { anchor: 'end', x: p.x - gap, y: p.y, rect: { x: p.x - gap - tw, y: p.y - lh / 2, w: tw, h: lh } },
        { anchor: 'middle', x: p.x, y: p.y + gap + lh / 2, rect: { x: p.x - tw / 2, y: p.y + gap, w: tw, h: lh } },
        { anchor: 'middle', x: p.x, y: p.y - gap - lh / 2, rect: { x: p.x - tw / 2, y: p.y - gap - lh, w: tw, h: lh } },
      ];
      const spot = tries.find((t) => free(t.rect, i));
      if (!spot) continue;
      placed.push(spot.rect);
      txt(labelLayer, spot.x, spot.y, text, { size: labelFs, anchor: spot.anchor, weight: 600, cls: 'pa-t pa-halo' });
      return;
    }
  });
  // edge labels at the curve middle (relationship words), shifted a little if taken, dropped if still colliding
  data.edges.forEach((e, i) => {
    if (!e.label) return;
    const { mid } = geoms[i];
    const text = ellipsize(e.label, labelMax, labelFs);
    const tw = textWidth(text, labelFs);
    for (const dy of [0, -lh * 0.9, lh * 0.9]) {
      const rect = { x: mid.x - tw / 2, y: mid.y + dy - lh / 2, w: tw, h: lh };
      if (!free(rect)) continue;
      placed.push(rect);
      txt(labelLayer, mid.x, mid.y + dy, text, { size: labelFs, anchor: 'middle', cls: 'pa-m pa-halo' });
      return;
    }
  });
  // group key: a short row of coloured dots (colour needs a name; a hover alone would hide it)
  let lx = 4;
  groups.forEach((g, i) => {
    const gw = textWidth(g, labelFs) + LEGEND_DOT * 2 + 6;
    if (lx + gw > w) return;
    area.append(s('circle', { cx: lx + LEGEND_DOT, cy: legendH / 2, r: LEGEND_DOT, fill: catColor(i) }));
    txt(area, lx + LEGEND_DOT * 2 + 5, legendH / 2, g, { size: labelFs, cls: 'pa-m' });
    lx += gw + LEGEND_GAP;
  });
}

export const network = defineAsset({
  kind: 'network',
  shape: 'who is connected to whom and how (dependencies, imports, ownership, blockers); the pattern of connections is the point',
  summary: 'Nodes laid out by a force simulation (clusters form, hubs grow), coloured by group; each edge says its relationship ("imports", "blocks"); arrowheads show direction.',
  keys: ['nodes', 'edges'],
  aspect: 0.7,
  minH: 260,
  sample: {
    nodes: [
      { id: 'api', label: 'api', group: 'service', size: 8 }, { id: 'auth', label: 'auth', group: 'service', size: 5 }, { id: 'db', label: 'db layer', group: 'service', size: 6 },
      { id: 'ui', label: 'ui app', group: 'client', size: 6 }, { id: 'sdk', label: 'sdk', group: 'client', size: 3 }, { id: 'cache', label: 'cache', group: 'infra', size: 3 },
      { id: 'queue', label: 'queue', group: 'infra', size: 3 }, { id: 'worker', label: 'worker', group: 'service', size: 4 }, { id: 'ci', label: 'CI', group: 'infra', size: 2 },
    ],
    edges: [
      { from: 'ui', to: 'api', label: 'calls', directed: true, weight: 3 }, { from: 'sdk', to: 'api', label: 'calls', directed: true }, { from: 'api', to: 'auth', label: 'imports', directed: true, weight: 2 },
      { from: 'api', to: 'db', label: 'reads', directed: true, weight: 3 }, { from: 'auth', to: 'db', label: 'writes', directed: true }, { from: 'api', to: 'cache', label: 'caches', directed: true },
      { from: 'api', to: 'queue', label: 'enqueues', directed: true }, { from: 'queue', to: 'worker', label: 'feeds', directed: true }, { from: 'worker', to: 'db', label: 'writes', directed: true },
      { from: 'ci', to: 'api', label: 'tests', directed: true }, { from: 'ci', to: 'ui', label: 'builds' },
    ],
  },
  validate: validateNetwork,
  draw: drawNetwork,
});

// ---- mindmap ---------------------------------------------------------------------------------------------------------------
const PILL_PAD_X = 10;
const PILL_PAD_Y = 4;
const COL_GAP = 22;
const COL_GAP_NARROW = 12;
const ROW_GAP = 6;
const MIN_PILL_W = 56;
const CENTER_MAX_FRAC = 0.2;
const CENTER_MAX_FRAC_NARROW = 0.2;
const CENTER_PAD = 12;
const PILL_PAD_NARROW = 6;
const DEPTH_TINT = [0, 30, 18, 10];
const DEPTH_STROKE = [0, 2.6, 1.8, 1.2];
const LINK_BOW = 0.28;
const LINK_DASH = '6 4';
const MIN_LINK_LABEL_W = 60;
const LINK_LABEL_FRAC = 0.22;
const MARGIN = 8;
const WRAP_LINES = 2;
const WRAP_LINES_NARROW = 3;

function validateMindmap(d) {
  check.object(d, 'data', ['center', 'branches', 'links']);
  const center = check.string(d.center, 'data.center', { max: MAX_LABEL });
  const labels = new Set([center]);
  let count = 0;
  const node = (n, p, depth) => {
    check.object(n, p, depth === 1 ? ['label', 'tone', 'children'] : ['label', 'children']);
    if (++count > MAX_BRANCH_NODES) throw new AssetError(`data has more than ${MAX_BRANCH_NODES} branch nodes: keep the ones that matter`);
    const label = check.string(n.label, `${p}.label`, { max: MAX_LABEL });
    labels.add(label);
    const out = { label, children: [] };
    if (depth === 1) { const tone = check.tone(n.tone, `${p}.tone`); if (tone) out.tone = tone; }
    if (n.children !== undefined && !(Array.isArray(n.children) && n.children.length === 0 && depth >= MAX_DEPTH)) {
      if (depth >= MAX_DEPTH) throw new AssetError(`${p}.children is too deep: a mindmap goes ${MAX_DEPTH} levels from the centre`);
      out.children = each(n.children, `${p}.children`, { min: 0, max: MAX_BRANCH_NODES }, (c, cp) => node(c, cp, depth + 1));
    }
    return out;
  };
  const branches = each(d.branches, 'data.branches', { max: MAX_BRANCH_NODES }, (b, p) => node(b, p, 1));
  const links = d.links === undefined ? [] : each(d.links, 'data.links', { min: 0, max: MAX_BRANCH_NODES }, (l, p) => {
    check.object(l, p, ['from', 'to', 'label']);
    const end = (k) => { const v = check.string(l[k], `${p}.${k}`, { max: MAX_LABEL }); if (!labels.has(v)) throw new AssetError(`${p}.${k} "${v}" is not a label in this mindmap (labels: ${[...labels].slice(0, 10).join(', ')})`); return v; };
    return { from: end('from'), to: end('to'), label: check.string(l.label, `${p}.label`, { max: 30, optional: true }) };
  });
  return { center, branches, links };
}

const leaves = (n) => (n.children.length ? n.children.reduce((a, c) => a + leaves(c), 0) : 1);
const depthOf = (n) => (n.children.length ? 1 + Math.max(...n.children.map(depthOf)) : 1);

function drawMindmap(ctx) {
  const { data, w, fs, narrow } = ctx;
  const f = Math.max(px.min, fs * 0.95);
  const lineH = f * 1.2;
  const gap = narrow ? COL_GAP_NARROW : COL_GAP;
  const maxLines = narrow ? WRAP_LINES_NARROW : WRAP_LINES;
  // sides: wide = branches split by leaf count around the centre (right clockwise from the top), narrow = all to the right
  const total = data.branches.reduce((a, b) => a + leaves(b), 0);
  const right = [];
  const left = [];
  if (narrow || data.branches.length < 2) right.push(...data.branches);
  else { let acc = 0; for (const b of data.branches) { (acc < total / 2 ? right : left).push(b); acc += leaves(b); } left.reverse(); }
  const sides = [{ dir: 1, list: right }, { dir: -1, list: left }].filter((sd) => sd.list.length);
  const two = sides.length === 2;

  const centerNat = textWidth(data.center, f * 1.1, 700) + 2 * CENTER_PAD;
  const centerWord = Math.max(...data.center.split(/\s+/).map((wd) => textWidth(wd, f * 1.1, 700))) + 2 * CENTER_PAD;
  const cw = narrow ? Math.min(centerNat, Math.max(centerWord, w * CENTER_MAX_FRAC_NARROW)) : Math.min(centerNat, w * CENTER_MAX_FRAC * 2);
  const padX = narrow ? PILL_PAD_NARROW : PILL_PAD_X;
  const cLines = wrap(data.center, cw - 2 * CENTER_PAD, f * 1.1, 3, 700);
  const ch = cLines.length * f * 1.3 + 16;
  const cx = two ? w / 2 : MARGIN + cw / 2;
  const avail = two ? w / 2 - cw / 2 - gap - MARGIN : w - cx - cw / 2 - gap - MARGIN;

  // column widths per side and depth: natural text width, shrunk together when the side is too narrow
  const depthCount = Math.max(...data.branches.map(depthOf)) ;
  const layoutSide = (sd) => {
    const nat = Array.from({ length: depthCount }, () => MIN_PILL_W);
    const least = nat.slice();
    const walk = (n, d) => {
      const weight = d === 0 ? 700 : 500;
      nat[d] = Math.max(nat[d], textWidth(n.label, f, weight) + 2 * padX);
      least[d] = Math.max(least[d], ...n.label.split(/\s+/).map((wd) => textWidth(wd, f, weight) + 2 * padX));
      n.children.forEach((c) => walk(c, d + 1));
    };
    sd.list.forEach((b) => walk(b, 0));
    // every column gets its longest word first (labels wrap), then the spare width goes to the columns that still want more
    const budget = avail - gap * (depthCount - 1);
    const sumLeast = least.reduce((a, b) => a + b, 0);
    const want = nat.map((v, i) => v - least[i]);
    const sumWant = want.reduce((a, b) => a + b, 0) || 1;
    const grow = Math.min(1, Math.max(0, budget - sumLeast) / sumWant);
    const shrink = Math.min(1, budget / sumLeast);
    sd.colW = least.map((v, i) => v * shrink + want[i] * grow);
    return sd;
  };
  sides.forEach(layoutSide);

  // measure every pill, then the height the busiest side needs
  const pills = [];
  const build = (n, d, sd, branchIdx) => {
    const pw = sd.colW[d];
    const lines = wrap(n.label, pw - 2 * padX, f, maxLines, d === 0 ? 700 : 500);
    const p = { n, d, sd, lines, pw, ph: lines.length * lineH + 2 * PILL_PAD_Y, color: n.tone ? toneColor(n.tone) : catColor(branchIdx), kids: [] };
    p.kids = n.children.map((c) => build(c, d + 1, sd, branchIdx));
    pills.push(p);
    return p;
  };
  const roots = new Map(sides.map((sd) => [sd, sd.list.map((b) => build(b, 0, sd, data.branches.indexOf(b)))]));
  const rowH = Math.max(...pills.map((p) => p.ph)) + ROW_GAP;
  const need = Math.max(...sides.map((sd) => sd.list.reduce((a, b) => a + leaves(b), 0)), (ch + 2 * MARGIN) / rowH) * rowH + 2 * MARGIN;
  const { g, h } = paintArea(ctx, need);

  // positions: leaves evenly down the side, parents at the middle of their children
  for (const sd of sides) {
    const n = sd.list.reduce((a, b) => a + leaves(b), 0);
    const unit = (h - 2 * MARGIN) / n;
    let slot = 0;
    const colX = [];
    let x = 0;
    sd.colW.forEach((cwid) => { colX.push(x); x += cwid + gap; });
    const place = (p) => {
      if (p.kids.length) { p.kids.forEach(place); p.y = (p.kids[0].y + p.kids[p.kids.length - 1].y) / 2; } else p.y = MARGIN + (slot++ + 0.5) * unit;
      const off = cw / 2 + gap + colX[p.d];
      p.x0 = sd.dir > 0 ? cx + off : cx - off - p.pw; // left edge of the pill
    };
    roots.get(sd).forEach(place);
  }
  const cy = h / 2;
  const linkLayer = g.appendChild(s('g', { fill: 'none' }));
  const pillLayer = g.appendChild(s('g'));
  const anchor = new Map([[data.center, { x: cx, y: cy, w: cw, h: ch }]]);
  for (const p of pills) if (!anchor.has(p.n.label)) anchor.set(p.n.label, { x: p.x0 + p.pw / 2, y: p.y, w: p.pw, h: p.ph, side: p.sd.dir });

  // branches: curved links from the parent's edge facing the centre's far side to the child
  const curve = (x0, y0, x1, y1) => { const mx = (x0 + x1) / 2; return `M${x0},${y0} C${mx},${y0} ${mx},${y1} ${x1},${y1}`; };
  const link = (parent, child, sd) => {
    const x0 = parent ? (sd.dir > 0 ? parent.x0 + parent.pw : parent.x0) : cx + sd.dir * (cw / 2 - 2);
    const y0 = parent ? parent.y : cy;
    const x1 = sd.dir > 0 ? child.x0 : child.x0 + child.pw;
    linkLayer.append(s('path', { d: curve(x0, y0, x1, child.y), stroke: child.color, 'stroke-width': DEPTH_STROKE[child.d + 1], 'stroke-linecap': 'round', opacity: 0.85 }));
  };
  const walkLinks = (p, parent) => { link(parent, p, p.sd); p.kids.forEach((k) => walkLinks(k, p)); };
  for (const sd of sides) roots.get(sd).forEach((p) => walkLinks(p, null));

  // cross-links: dashed curves, bowed away from the centre bubble, with a halo label
  data.links.forEach((l) => {
    const a = anchor.get(l.from);
    const b = anchor.get(l.to);
    if (a === b) return;
    const edgeX = (q, other) => (q.side === undefined ? q.x : q.side > 0 ? (other.side === q.side ? q.x + q.w / 2 : q.x - q.w / 2) : (other.side === q.side ? q.x - q.w / 2 : q.x + q.w / 2));
    const p0 = { x: edgeX(a, b), y: a.y };
    const p1 = { x: edgeX(b, a), y: b.y };
    const dx = p1.x - p0.x;
    const dy = p1.y - p0.y;
    const len = Math.hypot(dx, dy) || 1;
    const sameSide = a.side !== undefined && a.side === b.side;
    const mid = { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 };
    const sign = mid.y < cy ? -1 : 1;
    const c = sameSide ? { x: mid.x + a.side * Math.max(40, len * LINK_BOW), y: mid.y } : { x: mid.x - (dy / len) * len * LINK_BOW * -sign, y: mid.y + (dx / len) * len * LINK_BOW * -sign };
    const cxm = clamp(c.x, MARGIN, w - MARGIN);
    linkLayer.append(tip(s('path', { d: `M${p0.x},${p0.y} Q${cxm},${c.y} ${p1.x},${p1.y}`, stroke: 'var(--ui-mut)', 'stroke-width': 1.6, 'stroke-dasharray': LINK_DASH }), `${l.from} -> ${l.to}${l.label ? `: ${l.label}` : ''}`));
    if (l.label) {
      const text = ellipsize(l.label, Math.max(MIN_LINK_LABEL_W, w * LINK_LABEL_FRAC), f);
      const half = textWidth(text, f) / 2;
      txt(pillLayer, clamp(0.25 * p0.x + 0.5 * cxm + 0.25 * p1.x, MARGIN + half, w - MARGIN - half), 0.25 * p0.y + 0.5 * c.y + 0.25 * p1.y, text, { size: f, anchor: 'middle', cls: 'pa-m pa-halo' });
    }
  });

  for (const p of pills) {
    const tint = DEPTH_TINT[p.d + 1];
    const rect = s('rect', { x: p.x0, y: p.y - p.ph / 2, width: p.pw, height: p.ph, rx: Math.min(p.ph / 2, 14), fill: soft(p.color, tint), stroke: p.color, 'stroke-width': p.d === 0 ? 1.8 : 1.2 });
    pillLayer.append(tip(rect, p.n.label));
    const text = s('text', { x: p.x0 + p.pw / 2, y: p.y - ((p.lines.length - 1) * lineH) / 2, class: 'pa-t', 'font-size': f, 'text-anchor': 'middle', 'dominant-baseline': 'middle', 'font-weight': p.d === 0 ? 700 : 500 });
    p.lines.forEach((ln, i) => text.append(s('tspan', { x: p.x0 + p.pw / 2, dy: i === 0 ? 0 : lineH }, ln)));
    pillLayer.append(text);
  }
  const ce = s('rect', { x: cx - cw / 2, y: cy - ch / 2, width: cw, height: ch, rx: Math.min(ch / 2, 22), fill: 'var(--ui-acc)' });
  pillLayer.append(tip(ce, data.center));
  const ct = s('text', { x: cx, y: cy - ((cLines.length - 1) * f * 1.3) / 2, class: 'pa-on', 'font-size': f * 1.1, 'text-anchor': 'middle', 'dominant-baseline': 'middle' });
  cLines.forEach((ln, i) => ct.append(s('tspan', { x: cx, dy: i === 0 ? 0 : f * 1.3 }, ln)));
  pillLayer.append(ct);
}

export const mindmap = defineAsset({
  kind: 'mindmap',
  shape: 'a concept and the ideas branching from it (a plan, a feature breakdown, a brainstorm); grouping and what relates to what, no order or numbers',
  summary: 'The central idea as a bubble, branches fanning left and right in one colour each, pill labels three levels deep; dashed labelled curves link related ideas across branches.',
  keys: ['center', 'branches', 'links'],
  aspect: 0.62,
  minH: 260,
  sample: {
    center: 'Ship auth v2',
    branches: [
      { label: 'Backend', children: [{ label: 'Token service', children: [{ label: 'rotate keys' }, { label: 'refresh flow' }] }, { label: 'Session store' }] },
      { label: 'Frontend', children: [{ label: 'Login form' }, { label: 'SSO buttons' }] },
      { label: 'Testing', children: [{ label: 'Unit tests' }, { label: 'Load test', children: [{ label: '10k logins' }] }] },
      { label: 'Rollout', tone: 'warn', children: [{ label: 'Feature flag' }, { label: 'Canary 5%' }, { label: 'Rollback plan' }] },
    ],
    links: [{ from: 'SSO buttons', to: 'Token service', label: 'needs' }, { from: 'Load test', to: 'Canary 5%', label: 'gates' }],
  },
  validate: validateMindmap,
  draw: drawMindmap,
});
