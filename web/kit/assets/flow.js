// flow.js - quantity moving between things: `sankey` (how much went where, widths = amounts) and `flow` (what moves along which path,
// animated dots show direction and rate). Both share the layered layout of layout.js.
import { AssetError, check, each, ref, defineAsset, s, txt, tip, catColor, toneColor, soft, textWidth, ellipsize, fmt, reducedMotion, px } from './core.js';
import { layerGraph, placeLayers, hCurve, stackLabels } from './layout.js';

const NODE_W = 12;
const NODE_GAP = 10;
const MIN_LINK_PX = 1;
const TWO_LINE_FS = 2.5;
const NARROW_LABEL_SHARE = 0.25; // of the width, for the first and last column's labels on a narrow card
const MID_ROOM_MIN = 32; // the least room a middle column's label gets (it ellipsizes before it covers the next column)
const NAME_SHARE_MIN = 0.6; // share of a label's room the name must keep to also show the value on one line

// ---- sankey ---------------------------------------------------------------------------------------------------------------------
const nodesOf = (links, given) => {
  const order = [...new Map([...(given ?? []).map((n) => [n.id, n])]).keys()];
  for (const l of links) for (const id of [l.from, l.to]) if (!order.includes(id)) order.push(id);
  return order.map((id) => given?.find((n) => n.id === id) ?? { id, label: id });
};

function validateSankey(d) {
  check.object(d, 'data', ['unit', 'nodes', 'links']);
  const unit = check.string(d.unit, 'data.unit', { max: 12, optional: true }) ?? '';
  const seen = new Set();
  const given = d.nodes === undefined ? [] : each(d.nodes, 'data.nodes', {}, (n, p) => {
    check.object(n, p, ['id', 'label', 'tone']);
    return { id: check.id(n.id, `${p}.id`, seen), label: check.string(n.label, `${p}.label`, { optional: true }), tone: check.tone(n.tone, `${p}.tone`) };
  });
  const ids = new Set(given.map((n) => n.id));
  const links = each(d.links, 'data.links', {}, (l, p) => {
    check.object(l, p, ['from', 'to', 'value', 'label']);
    const from = check.string(l.from, `${p}.from`, { max: 40 });
    const to = check.string(l.to, `${p}.to`, { max: 40 });
    if (given.length) { ref(from, `${p}.from`, ids); ref(to, `${p}.to`, ids); }
    if (from === to) throw new AssetError(`${p} goes from "${from}" to itself`);
    return { from, to, value: check.number(l.value, `${p}.value`, { min: 0 }), label: check.string(l.label, `${p}.label`, { optional: true }) };
  });
  const nodes = nodesOf(links, given).map((n) => ({ ...n, label: n.label ?? n.id }));
  const { backEdges } = layerGraph(nodes.map((n) => n.id), links);
  if (backEdges.size) { const e = [...backEdges][0]; throw new AssetError(`data.links form a loop (${e.from} -> ${e.to} comes back): a sankey flows one way; remove the return link`); }
  return { unit, nodes, links };
}

/**
 * Pure sankey geometry: nodes {id, layer, x, y, h, in, out, v}, links {from, to, value, w, y0, y1}.
 * Node height = max(in, out) * k; k is the largest scale at which every layer fits `h` with `gap` between nodes.
 */
export function sankeyLayout(nodes, links, { w, h, left = 0, right = 0, nodeW = NODE_W, gap = NODE_GAP }) {
  const { layerOf, layers } = layerGraph(nodes.map((n) => n.id), links);
  const inSum = new Map(nodes.map((n) => [n.id, 0]));
  const outSum = new Map(nodes.map((n) => [n.id, 0]));
  for (const l of links) { outSum.set(l.from, outSum.get(l.from) + l.value); inSum.set(l.to, inSum.get(l.to) + l.value); }
  const val = (id) => Math.max(inSum.get(id), outSum.get(id));
  const k = Math.min(...layers.map((ids) => (h - gap * (ids.length - 1)) / Math.max(1e-9, ids.reduce((a, id) => a + val(id), 0))));
  const cols = layers.length;
  const span = w - left - right - nodeW;
  const pos = new Map();
  layers.forEach((ids, li) => {
    const total = ids.reduce((a, id) => a + val(id) * k, 0) + gap * (ids.length - 1);
    let y = (h - total) / 2;
    for (const id of ids) {
      const nh = Math.max(MIN_LINK_PX, val(id) * k);
      pos.set(id, { id, layer: li, x: left + (cols === 1 ? 0 : (span * li) / (cols - 1)), y, h: nh, in: inSum.get(id), out: outSum.get(id), v: val(id), inY: y, outY: y });
      y += nh + gap;
    }
  });
  // ribbons: slots at each node ordered by the other end's y so they do not cross needlessly
  const placed = links.map((l) => ({ ...l, w: Math.max(MIN_LINK_PX, l.value * k) }));
  for (const n of pos.values()) {
    for (const l of placed.filter((x) => x.from === n.id).sort((a, b) => pos.get(a.to).y - pos.get(b.to).y)) { l.y0 = n.outY + l.w / 2; n.outY += l.w; }
    for (const l of placed.filter((x) => x.to === n.id).sort((a, b) => pos.get(a.from).y - pos.get(b.from).y)) { l.y1 = n.inY + l.w / 2; n.inY += l.w; }
  }
  void layerOf;
  return { nodes: [...pos.values()], links: placed, nodeW, k, cols };
}

function drawSankey({ data, svg, w, h, fs, narrow }) {
  const total = data.links.reduce((a, l) => a + l.value, 0);
  const share = narrow ? NARROW_LABEL_SHARE : 0.22;
  const left = Math.min(w * share, 190);
  const right = Math.min(w * share, 190);
  const g = sankeyLayout(data.nodes, data.links, { w, h: h - 4, left, right });
  const by = new Map(g.nodes.map((n) => [n.id, n]));
  const info = new Map(data.nodes.map((n, i) => [n.id, { ...n, color: n.tone ? toneColor(n.tone) : catColor(i) }]));
  const ribbons = svg.appendChild(s('g', { fill: 'none' }));
  for (const l of g.links) {
    const a = by.get(l.from);
    const b = by.get(l.to);
    const p = s('path', { d: hCurve(a.x + g.nodeW, l.y0, b.x, l.y1), 'stroke-width': l.w, stroke: info.get(l.from).color, 'stroke-opacity': 0.38, class: 'pa-in' });
    ribbons.append(tip(p, `${info.get(l.from).label} -> ${info.get(l.to).label}: ${fmt(l.value, data.unit)}${total ? ` (${Math.round((l.value / total) * 100)}% of the flow)` : ''}${l.label ? ` - ${l.label}` : ''}`));
  }
  const last = g.cols - 1;
  const twoLine = (n) => n.h >= fs * TWO_LINE_FS;
  const labelY = new Map(); // label centres per column, kept apart and inside the box (a tiny node at the edge would clip its name)
  for (let li = 0; li <= last; li++) {
    const col = g.nodes.filter((n) => n.layer === li);
    const ys = stackLabels(col.map((n) => ({ y: n.y + n.h / 2, h: twoLine(n) ? fs * 2.3 : fs * 1.25 })), 0, h);
    col.forEach((n, k) => labelY.set(n.id, ys[k]));
  }
  for (const n of g.nodes) {
    const i = info.get(n.id);
    svg.append(tip(s('rect', { x: n.x, y: n.y, width: g.nodeW, height: n.h, rx: 2, fill: i.color }), `${i.label}: ${fmt(n.v, data.unit)}`));
    const side = n.layer === 0 ? 'end' : n.layer === last ? 'start' : 'start';
    const x = n.layer === 0 ? n.x - 6 : n.x + g.nodeW + 6;
    const room = n.layer === 0 ? left - 8 : n.layer === last ? right - 8 : Math.max(MID_ROOM_MIN, (w - left - right) / Math.max(1, g.cols - 1) - g.nodeW - 8);
    const two = twoLine(n);
    const cy = labelY.get(n.id);
    const val = fmt(n.v, data.unit);
    const mid = n.layer !== 0 && n.layer !== last;
    const cls = mid ? 'pa-t pa-halo' : 'pa-t';
    if (two) {
      txt(svg, x, cy - fs * 0.6, i.label, { size: fs, anchor: side, maxW: room, cls, weight: 650 });
      txt(svg, x, cy + fs * 0.65, val, { size: Math.max(px.min, fs * 0.9), anchor: side, cls: mid ? 'pa-m pa-halo' : 'pa-m' });
    } else {
      const avail = room - textWidth(` ${val}`, fs) - 4;
      // a one-line label keeps its value only while the name still gets most of the room; otherwise the name wins (the value is in the hover title)
      const line = avail >= room * NAME_SHARE_MIN ? `${ellipsize(i.label, avail, fs, 650)} ${val}` : ellipsize(i.label, room, fs, 650);
      txt(svg, x, cy, line, { size: fs, anchor: side, maxW: room, cls });
    }
  }
}

export const sankey = defineAsset({
  kind: 'sankey',
  shape: 'quantity flowing from sources through stages to destinations (where did it go / come from)',
  summary: 'Ribbons whose width is the amount; nodes in columns left to right. Use for token/time/money/file budgets that split and merge.',
  keys: ['unit', 'nodes', 'links'],
  aspect: 0.62,
  minH: 240,
  sample: {
    unit: 'k tok',
    links: [
      { from: 'Session', to: 'Reading', value: 46 }, { from: 'Session', to: 'Editing', value: 22 }, { from: 'Session', to: 'Thinking', value: 18 }, { from: 'Session', to: 'Tool output', value: 14 },
      { from: 'Reading', to: 'Useful', value: 28 }, { from: 'Reading', to: 'Re-read', value: 18 }, { from: 'Tool output', to: 'Re-read', value: 6 }, { from: 'Tool output', to: 'Useful', value: 8 },
      { from: 'Editing', to: 'Useful', value: 22 }, { from: 'Thinking', to: 'Useful', value: 12 }, { from: 'Thinking', to: 'Dead end', value: 6 },
    ],
  },
  validate: validateSankey,
  draw: drawSankey,
});

// ---- flow (animated particles along edges) ----------------------------------------------------------------------------------------
const DOT_R = 3.2;
const DUR_SLOW = 7;
const DUR_FAST = 1.6;
const MAX_DOTS = 6;
const PILL_PAD = 10;

function validateFlow(d) {
  check.object(d, 'data', ['unit', 'nodes', 'edges']);
  const seen = new Set();
  const nodes = each(d.nodes, 'data.nodes', { max: 24 }, (n, p) => {
    check.object(n, p, ['id', 'label', 'tone']);
    return { id: check.id(n.id, `${p}.id`, seen), label: check.string(n.label, `${p}.label`, { max: 28 }), tone: check.tone(n.tone, `${p}.tone`) };
  });
  const edges = each(d.edges, 'data.edges', { max: 48 }, (e, p) => {
    check.object(e, p, ['from', 'to', 'rate', 'label']);
    return { from: ref(e.from, `${p}.from`, seen), to: ref(e.to, `${p}.to`, seen), rate: check.number(e.rate, `${p}.rate`, { min: 0 }), label: check.string(e.label, `${p}.label`, { max: 28, optional: true }) };
  });
  return { unit: check.string(d.unit, 'data.unit', { max: 14, optional: true }) ?? '', nodes, edges };
}

let pathUid = 0;
function drawFlow({ data, svg, w, h, fs, reduced }) {
  const { layers, backEdges } = layerGraph(data.nodes.map((n) => n.id), data.edges);
  const widths = new Map(data.nodes.map((n) => [n.id, textWidth(n.label, fs, 650) + 2 * PILL_PAD]));
  const maxW = Math.max(...widths.values());
  const place = placeLayers(layers, w, h, Math.min(maxW / 2 + 4, w / 4));
  const nh = fs * 2;
  const rates = data.edges.map((e) => e.rate);
  const top = Math.max(...rates, 1e-9);
  const calm = reduced || reducedMotion();
  const prefix = `pf${++pathUid}-`;
  const edgeLayer = svg.appendChild(s('g', { fill: 'none' }));
  const dotLayer = svg.appendChild(s('g'));
  const labelLayer = svg.appendChild(s('g'));
  data.edges.forEach((e, i) => {
    const a = place.get(e.from);
    const b = place.get(e.to);
    const back = backEdges.has(e);
    const x0 = a.x + (back ? 0 : widths.get(e.from) / 2);
    const x1 = b.x - (back ? 0 : widths.get(e.to) / 2);
    const d = back ? `M${a.x},${a.y + nh / 2} C${a.x},${Math.min(h, a.y + nh * 2.4)} ${b.x},${Math.min(h, b.y + nh * 2.4)} ${b.x},${b.y + nh / 2}` : hCurve(x0, a.y, x1, b.y);
    const strong = 1.4 + (e.rate / top) * 4.6;
    const id = `${prefix}${i}`;
    edgeLayer.append(tip(s('path', { id, d, stroke: soft('var(--ui-acc)', 40), 'stroke-width': strong, 'stroke-linecap': 'round' }), `${e.from} -> ${e.to}: ${fmt(e.rate, data.unit)}`));
    const n = Math.max(1, Math.round((e.rate / top) * MAX_DOTS));
    const dur = DUR_SLOW - (DUR_SLOW - DUR_FAST) * (e.rate / top);
    for (let k = 0; k < n; k++) {
      const dot = s('circle', { r: DOT_R + (e.rate / top) * 1.6, fill: 'var(--ui-acc)' });
      if (calm) { dot.setAttribute('cx', x0 + ((x1 - x0) * (k + 1)) / (n + 1)); dot.setAttribute('cy', a.y + ((b.y - a.y) * (k + 1)) / (n + 1)); } else {
        dot.append(s('animateMotion', { dur: `${dur}s`, begin: `${-(dur * k) / n}s`, repeatCount: 'indefinite' }, s('mpath', { href: `#${id}` })));
      }
      dotLayer.append(dot);
    }
    if (e.label || data.unit) {
      const mx = (x0 + x1) / 2;
      const my = back ? Math.min(h - 4, Math.max(a.y, b.y) + nh * 1.7) : (a.y + b.y) / 2 - strong - 5;
      const lf = Math.max(px.min, fs * 0.9);
      const gapW = Math.max(0, (x1 - x0) * 0.95);
      const full = `${e.label ? `${e.label} ` : ''}${fmt(e.rate, data.unit)}`.trim();
      // the gap between two pills may be narrower than the words: then only the rate stays (the name is in the hover title), and nothing if even that does not fit
      const text = textWidth(full, lf) <= gapW ? full : fmt(e.rate, data.unit);
      if (textWidth(text, lf) <= gapW || back) txt(labelLayer, mx, my, text, { size: lf, anchor: 'middle', cls: 'pa-m pa-halo', maxW: back ? undefined : gapW });
    }
  });
  data.nodes.forEach((n, i) => {
    const p = place.get(n.id);
    const nw = widths.get(n.id);
    const c = n.tone ? toneColor(n.tone) : catColor(i);
    svg.append(s('rect', { x: p.x - nw / 2, y: p.y - nh / 2, width: nw, height: nh, rx: nh / 2, fill: soft(c, 22), stroke: c, 'stroke-width': 1.5 }));
    txt(svg, p.x, p.y, n.label, { size: fs, anchor: 'middle', weight: 650, maxW: nw - 8 });
  });
}

export const flow = defineAsset({
  kind: 'flow',
  shape: 'what moves along which path, and how fast (data, requests, work items); direction and rate are the point',
  summary: 'Nodes as pills, edges as curves with dots moving along them; dot count and speed follow the rate, width too. Motion = direction (static dots under reduced motion).',
  keys: ['unit', 'nodes', 'edges'],
  aspect: 0.7,
  minH: 260,
  sample: {
    unit: '/min',
    nodes: [{ id: 'user', label: 'User' }, { id: 'agent', label: 'Agent' }, { id: 'tools', label: 'Tools' }, { id: 'model', label: 'Model' }, { id: 'cache', label: 'Cache', tone: 'ok' }, { id: 'disk', label: 'Disk' }],
    edges: [
      { from: 'user', to: 'agent', rate: 6, label: 'prompts' }, { from: 'agent', to: 'tools', rate: 30, label: 'calls' }, { from: 'agent', to: 'model', rate: 12, label: 'asks' },
      { from: 'tools', to: 'cache', rate: 21, label: 'hits' }, { from: 'tools', to: 'disk', rate: 9, label: 'reads' }, { from: 'model', to: 'cache', rate: 12, label: 'saves' },
    ],
  },
  validate: validateFlow,
  draw: drawFlow,
});
