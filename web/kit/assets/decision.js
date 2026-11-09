// decision.js - `decision`: a branching what-if. Questions branch into options, options end in outcomes; the path that was taken is
// emphasised, the rest stays visible but muted. Wide: left -> right tree with the option text on each link. Narrow: an indented
// outline (top -> down) so boxes keep the full width.
import { AssetError, check, each, defineAsset, s, txt, tip, toneColor, soft, textWidth, wrap, clamp, px } from './core.js';
import { hCurve } from './layout.js';
import { paintArea } from './fit.js';

const MAX_NODES = 30;
const MAX_DEPTH = 6;
const MAX_LABEL = 90;
const BOX_PAD_X = 9;
const BOX_PAD_Y = 6;
const BOX_RADIUS = 8;
const LINE_H = 1.22;
const MAX_LINES = 3;
const GAP_Y = 10;
const MARGIN = 8;
const GAP_X_MIN = 64;
const GAP_X_MAX = 96;
const INDENT = 16;
const NEUTRAL_PCT = 10;
const TINT_PCT = 20;
const OUTCOME_PCT = 24; // an outcome without a tone: a stronger neutral than a question, never the accent (that means 'chosen')
const CHOSEN_PCT = 16;
const EDGE_LIFT = 8; // px between the link and the bottom of its text
const LINK_W = 1.5;
const LINK_W_CHOSEN = 3.2;
const MUTED_OPACITY = 0.72;
const KINDS = ['question', 'outcome'];

function validateDecision(d) {
  check.object(d, 'data', ['root', 'chosen']);
  const ids = new Set();
  let count = 0;
  const node = (n, p, depth) => {
    check.object(n, p, ['id', 'label', 'kind', 'tone', 'edge', 'children']);
    if (++count > MAX_NODES) throw new AssetError(`data has more than ${MAX_NODES} nodes: keep the branches that matter`);
    if (depth > MAX_DEPTH) throw new AssetError(`${p} is nested deeper than ${MAX_DEPTH} levels`);
    const out = { label: check.string(n.label, `${p}.label`, { max: MAX_LABEL }), children: [] };
    const id = check.string(n.id, `${p}.id`, { max: 40, optional: true });
    if (id !== undefined) { if (ids.has(id)) throw new AssetError(`${p}.id "${id}" is used twice: give each its own id`); ids.add(id); out.id = id; }
    for (const [k, v] of [['kind', check.oneOf(n.kind, `${p}.kind`, KINDS, { optional: true })], ['tone', check.tone(n.tone, `${p}.tone`)], ['edge', check.string(n.edge, `${p}.edge`, { max: 40, optional: true })]]) if (v !== undefined) out[k] = v;
    if (n.children !== undefined) out.children = each(n.children, `${p}.children`, { min: 0, max: MAX_NODES }, (c, cp) => node(c, cp, depth + 1));
    return out;
  };
  const root = node(d.root, 'data.root', 1);
  const names = new Set();
  const collect = (n) => { names.add(n.label); if (n.id) names.add(n.id); n.children.forEach(collect); };
  collect(root);
  const out = { root };
  if (d.chosen !== undefined) {
    out.chosen = each(d.chosen, 'data.chosen', { min: 0, max: MAX_NODES }, (c, p) => {
      const v = check.string(c, p, { max: MAX_LABEL });
      if (!names.has(v)) throw new AssetError(`${p} "${v}" is not a label or id in this tree`);
      return v;
    });
  }
  return out;
}

const isLeaf = (n) => n.children.length === 0;

function drawDecision(ctx) {
  const { data, w, narrow } = ctx;
  const f = Math.max(px.min, ctx.fs * 0.95);
  const lineH = f * LINE_H;
  const chosenSet = new Set(data.chosen ?? []);
  const hasChosen = chosenSet.size > 0;
  const nodes = [];
  const build = (n, depth, parent) => {
    const kind = n.kind ?? (isLeaf(n) ? 'outcome' : 'question');
    const on = chosenSet.has(n.label) || (n.id && chosenSet.has(n.id));
    const nd = { n, depth, parent, kind, on, kids: [] };
    nodes.push(nd);
    nd.kids = n.children.map((c) => build(c, depth + 1, nd));
    return nd;
  };
  const root = build(data.root, 0, null);
  const maxDepth = Math.max(...nodes.map((x) => x.depth));
  const colorOf = (nd) => (nd.kind === 'outcome' ? (nd.n.tone ? toneColor(nd.n.tone) : 'var(--ui-mut)') : 'var(--ui-mut)');
  const fillOf = (nd) => (nd.on ? soft('var(--ui-acc)', CHOSEN_PCT) : nd.kind === 'outcome' ? soft(colorOf(nd), nd.n.tone ? TINT_PCT : OUTCOME_PCT) : soft('var(--ui-mut)', NEUTRAL_PCT));
  const strokeOf = (nd) => (nd.on ? 'var(--ui-acc)' : colorOf(nd));
  const linkOn = (nd) => Boolean(nd.on && nd.parent?.on);

  const paintBox = (g, nd, x, y, bw, bh, lines, extra) => {
    const rect = s('rect', { x, y, width: bw, height: bh, rx: BOX_RADIUS, fill: fillOf(nd), stroke: strokeOf(nd), 'stroke-width': nd.on ? 2.4 : 1.3, opacity: hasChosen && !nd.on ? MUTED_OPACITY : 1 });
    g.append(tip(rect, `${nd.kind}: ${nd.n.label}${nd.n.edge ? ` (via: ${nd.n.edge})` : ''}`));
    const all = extra ? [{ text: extra, cls: 'pa-m' }, ...lines.map((text) => ({ text, cls: 'pa-t' }))] : lines.map((text) => ({ text, cls: 'pa-t' }));
    const el = s('text', { x: x + BOX_PAD_X, y: y + BOX_PAD_Y + lineH / 2, 'font-size': f, 'dominant-baseline': 'middle', 'font-weight': nd.kind === 'question' || nd.on ? 650 : 500, opacity: hasChosen && !nd.on ? MUTED_OPACITY + 0.1 : 1 });
    all.forEach((ln, i) => el.append(s('tspan', { x: x + BOX_PAD_X, dy: i === 0 ? 0 : lineH, class: ln.cls, 'font-size': f }, ln.text)));
    g.append(el);
  };

  if (narrow) return drawOutline(ctx, { root, nodes, f, lineH, linkOn, paintBox, hasChosen });

  // ---- wide: columns by depth, boxes sized by wrapped text, leaves stacked, parents centred over their children ----
  const gapX = clamp(w * 0.07, GAP_X_MIN, GAP_X_MAX);
  const colW = (w - 2 * MARGIN - gapX * maxDepth) / (maxDepth + 1);
  const natural = Array.from({ length: maxDepth + 1 }, () => 0);
  for (const nd of nodes) natural[nd.depth] = Math.max(natural[nd.depth], textWidth(nd.n.label, f, 650) + 2 * BOX_PAD_X);
  const boxW = natural.map((v) => Math.min(v, colW));
  const colX = [];
  let acc = MARGIN;
  boxW.forEach((bw, i) => { colX.push(acc); acc += bw + gapX; });
  // the tree is narrower than the box: spread the columns so it uses the width
  const spare = w - MARGIN - (acc - gapX);
  const stretch = maxDepth > 0 ? Math.max(0, spare) / maxDepth : 0;
  colX.forEach((_, i) => { colX[i] += stretch * i; });
  for (const nd of nodes) {
    nd.lines = wrap(nd.n.label, boxW[nd.depth] - 2 * BOX_PAD_X, f, MAX_LINES, 650);
    nd.bw = boxW[nd.depth];
    nd.bh = nd.lines.length * lineH + 2 * BOX_PAD_Y;
  }
  let cursor = MARGIN;
  const shift = (nd, dy) => { nd.y += dy; nd.kids.forEach((k) => shift(k, dy)); };
  const place = (nd) => {
    const start = cursor;
    if (!nd.kids.length) { nd.y = cursor + nd.bh / 2; cursor += nd.bh + GAP_Y; return; }
    nd.kids.forEach(place);
    nd.y = (nd.kids[0].y + nd.kids[nd.kids.length - 1].y) / 2;
    if (nd.y - nd.bh / 2 < start) shift(nd, start - (nd.y - nd.bh / 2)); // a tall parent over short children pushes its subtree down
    cursor = Math.max(cursor, nd.y + nd.bh / 2 + GAP_Y);
  };
  place(root);
  const used = Math.max(...nodes.map((nd) => nd.y + nd.bh / 2)) + MARGIN;
  const { g, h } = paintArea(ctx, used);
  const dy = Math.max(0, (h - used) / 2); // short trees sit in the middle of the box
  for (const nd of nodes) { nd.y += dy; nd.x = colX[nd.depth]; }

  const linkLayer = g.appendChild(s('g', { fill: 'none' }));
  const boxLayer = g.appendChild(s('g'));
  const labelLayer = g.appendChild(s('g'));
  // muted links first so the chosen path is painted on top
  for (const on of [false, true]) {
    for (const nd of nodes) {
      if (!nd.parent || linkOn(nd) !== on) continue;
      const p = nd.parent;
      const x0 = p.x + p.bw;
      linkLayer.append(s('path', { d: hCurve(x0, p.y, nd.x, nd.y), stroke: on ? 'var(--ui-acc)' : soft('var(--ui-mut)', 70), 'stroke-width': on ? LINK_W_CHOSEN : LINK_W, 'stroke-linecap': 'round', opacity: hasChosen && !on ? MUTED_OPACITY : 1 }));
    }
  }
  for (const nd of nodes) {
    paintBox(boxLayer, nd, nd.x, nd.y - nd.bh / 2, nd.bw, nd.bh, nd.lines);
    if (nd.n.edge) txt(labelLayer, nd.x - 4, nd.y - EDGE_LIFT - (Math.min(wrap(nd.n.edge, gapX - 4, f, 2).length, 2) * lineH) / 2, nd.n.edge, { size: f, anchor: 'end', cls: `${linkOn(nd) ? 'pa-b' : 'pa-m'} pa-halo`, maxW: gapX - 4, lines: 2 });
  }
}

/** Narrow: DFS rows, each box indented by depth and as wide as what is left; elbow lines hang from the parent's left side. */
function drawOutline(ctx, { root, nodes, f, lineH, linkOn, paintBox, hasChosen }) {
  const { w } = ctx;
  let y = MARGIN;
  const order = [];
  const walk = (nd) => {
    order.push(nd);
    nd.x = MARGIN + nd.depth * INDENT;
    nd.bw = w - nd.x - MARGIN;
    nd.lines = wrap(nd.n.label, nd.bw - 2 * BOX_PAD_X, f, MAX_LINES, 650);
    nd.bh = (nd.lines.length + (nd.n.edge ? 1 : 0)) * lineH + 2 * BOX_PAD_Y;
    nd.top = y;
    nd.y = y + nd.bh / 2;
    y += nd.bh + GAP_Y;
    nd.kids.forEach(walk);
  };
  walk(root);
  const { g } = paintArea(ctx, y - GAP_Y + MARGIN);
  const linkLayer = g.appendChild(s('g', { fill: 'none' }));
  const boxLayer = g.appendChild(s('g'));
  for (const on of [false, true]) {
    for (const nd of order) {
      if (!nd.parent || linkOn(nd) !== on) continue;
      const p = nd.parent;
      const x0 = p.x + INDENT / 2 + 2;
      linkLayer.append(s('path', { d: `M${x0},${p.top + p.bh} V${nd.y} H${nd.x}`, stroke: on ? 'var(--ui-acc)' : soft('var(--ui-mut)', 70), 'stroke-width': on ? LINK_W_CHOSEN : LINK_W, 'stroke-linejoin': 'round', opacity: hasChosen && !on ? MUTED_OPACITY : 1 }));
    }
  }
  for (const nd of order) paintBox(boxLayer, nd, nd.x, nd.top, nd.bw, nd.bh, nd.lines, nd.n.edge ? `${nd.n.edge} ->` : undefined);
}

export const decision = defineAsset({
  kind: 'decision',
  shape: 'a choice with consequences (which approach, what if): questions branch into options and outcomes, and the path that was taken matters',
  summary: 'A left-to-right tree of rounded boxes: questions neutral, outcomes tinted by tone, the option text on each link; the chosen path is thick and accented, the alternatives muted. On narrow screens an indented outline.',
  keys: ['root', 'chosen'],
  aspect: 0.6,
  minH: 240,
  sample: {
    root: {
      id: 'q1', label: 'Flaky checkout test: how to fix?', children: [
        { id: 'retry', edge: 'retry in CI', label: 'Retry failed tests?', children: [
          { edge: 'yes', label: 'Masks the real race, CI +2 min', kind: 'outcome', tone: 'warn' },
          { edge: 'no', label: 'Keep red builds', kind: 'outcome', tone: 'danger' },
        ] },
        { id: 'fix', edge: 'fix the race', label: 'Can we reproduce it locally?', children: [
          { id: 'yes', edge: 'yes', label: 'Add a lock around the cart write', kind: 'outcome', tone: 'ok' },
          { edge: 'no', label: 'Add tracing, revisit tomorrow', kind: 'outcome' },
        ] },
        { edge: 'delete test', label: 'Lose coverage of checkout', kind: 'outcome', tone: 'danger' },
      ],
    },
    chosen: ['q1', 'fix', 'yes'],
  },
  validate: validateDecision,
  draw: drawDecision,
});
