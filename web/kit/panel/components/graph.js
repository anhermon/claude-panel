// graph.js - tiny layered auto-layout for <p-diagram> (pure, no DOM). Longest-path layering, barycentre ordering,
// centred columns (direction "lr") or rows ("tb"). Cycles are tolerated: back edges are ignored for layering.

export const LAYER_GAP = 96;
export const NODE_GAP = 28;
export const SWEEPS = 4;
export const MARGIN = 16;

/** Splits edges into forward edges (a DAG) and back edges, by DFS over the nodes in the given order. */
function splitBackEdges(ids, edges) {
  const out = new Map(ids.map((id) => [id, []]));
  for (const [a, b] of edges) out.get(a).push(b);
  const state = new Map(); // 1 = on the stack, 2 = done
  const back = new Set();
  const visit = (id) => {
    state.set(id, 1);
    for (const next of out.get(id)) {
      if (state.get(next) === 1) back.add(`${id}>${next}`);
      else if (!state.has(next)) visit(next);
    }
    state.set(id, 2);
  };
  for (const id of ids) if (!state.has(id)) visit(id);
  return back;
}

/**
 * nodes: [{id, w, h}] (sizes in px), edges: [[from, to]]. Returns {nodes: Map(id -> {x, y, w, h, layer}), width, height, back: Set('a>b')}.
 * Edge endpoints missing from `nodes` must be added by the caller.
 */
export function layoutGraph(nodes, edges, { direction = 'lr' } = {}) {
  const ids = nodes.map((n) => n.id);
  const size = new Map(nodes.map((n) => [n.id, n]));
  const known = edges.filter(([a, b]) => size.has(a) && size.has(b) && a !== b);
  const back = splitBackEdges(ids, known);
  const forward = known.filter(([a, b]) => !back.has(`${a}>${b}`));

  // layers: longest path from the sources
  const layer = new Map(ids.map((id) => [id, 0]));
  for (let pass = 0; pass < ids.length; pass++) {
    let moved = false;
    for (const [a, b] of forward) if (layer.get(b) < layer.get(a) + 1) { layer.set(b, layer.get(a) + 1); moved = true; }
    if (!moved) break;
  }
  const columns = [];
  for (const id of ids) (columns[layer.get(id)] ??= []).push(id);

  // order inside a layer: barycentre sweeps against the neighbouring layer's order
  const preds = new Map(ids.map((id) => [id, []]));
  const succs = new Map(ids.map((id) => [id, []]));
  for (const [a, b] of forward) { preds.get(b).push(a); succs.get(a).push(b); }
  const rank = new Map();
  const reindex = () => columns.forEach((col) => col.forEach((id, i) => rank.set(id, i)));
  reindex();
  const bary = (id, around) => {
    const list = around.get(id);
    return list.length ? list.reduce((sum, n) => sum + rank.get(n), 0) / list.length : rank.get(id);
  };
  for (let sweep = 0; sweep < SWEEPS; sweep++) {
    const down = sweep % 2 === 0;
    const order = down ? columns.slice(1) : columns.slice(0, -1).reverse();
    for (const col of order) {
      col.sort((a, b) => bary(a, down ? preds : succs) - bary(b, down ? preds : succs) || rank.get(a) - rank.get(b));
      reindex();
    }
  }

  // coordinates: L = along the flow, C = across it
  const horizontal = direction !== 'tb';
  const sizeL = (id) => (horizontal ? size.get(id).w : size.get(id).h);
  const sizeC = (id) => (horizontal ? size.get(id).h : size.get(id).w);
  const extent = columns.map((col) => col.reduce((sum, id, i) => sum + sizeC(id) + (i ? NODE_GAP : 0), 0));
  const maxExtent = Math.max(0, ...extent);
  const placed = new Map();
  let l = MARGIN;
  columns.forEach((col, layerIndex) => {
    const thick = Math.max(0, ...col.map(sizeL));
    let c = MARGIN + (maxExtent - extent[layerIndex]) / 2;
    for (const id of col) {
      const { w, h } = size.get(id);
      const along = l + (thick - sizeL(id)) / 2;
      placed.set(id, horizontal ? { x: along, y: c, w, h, layer: layerIndex } : { x: c, y: along, w, h, layer: layerIndex });
      c += sizeC(id) + NODE_GAP;
    }
    l += thick + LAYER_GAP;
  });
  const total = Math.max(MARGIN, l - LAYER_GAP + MARGIN);
  const cross = maxExtent + MARGIN * 2;
  return { nodes: placed, width: horizontal ? total : cross, height: horizontal ? cross : total, back };
}

/** Cubic bezier between two placed nodes. Returns {d, points: [p0, c1, c2, p1], mid} (points in px). */
export function edgeCurve(a, b, { direction = 'lr', back = false } = {}) {
  const horizontal = direction !== 'tb';
  const mid = (n) => ({ x: n.x + n.w / 2, y: n.y + n.h / 2 });
  const ca = mid(a);
  const cb = mid(b);
  let p0;
  let p1;
  let c1;
  let c2;
  if (back || a.layer >= b.layer) { // loop around under/right of the nodes
    const sag = 56;
    if (horizontal) { p0 = { x: ca.x, y: a.y + a.h }; p1 = { x: cb.x, y: b.y + b.h }; c1 = { x: p0.x, y: p0.y + sag }; c2 = { x: p1.x, y: p1.y + sag }; }
    else { p0 = { x: a.x + a.w, y: ca.y }; p1 = { x: b.x + b.w, y: cb.y }; c1 = { x: p0.x + sag, y: p0.y }; c2 = { x: p1.x + sag, y: p1.y }; }
  } else if (horizontal) {
    p0 = { x: a.x + a.w, y: ca.y }; p1 = { x: b.x, y: cb.y };
    const k = (p1.x - p0.x) / 2;
    c1 = { x: p0.x + k, y: p0.y }; c2 = { x: p1.x - k, y: p1.y };
  } else {
    p0 = { x: ca.x, y: a.y + a.h }; p1 = { x: cb.x, y: b.y };
    const k = (p1.y - p0.y) / 2;
    c1 = { x: p0.x, y: p0.y + k }; c2 = { x: p1.x, y: p1.y - k };
  }
  const f = (p) => `${Math.round(p.x * 10) / 10},${Math.round(p.y * 10) / 10}`;
  const t = 0.5;
  const at = (k) => (1 - t) ** 3 * p0[k] + 3 * (1 - t) ** 2 * t * c1[k] + 3 * (1 - t) * t * t * c2[k] + t ** 3 * p1[k];
  return { d: `M${f(p0)} C${f(c1)} ${f(c2)} ${f(p1)}`, points: [p0, c1, c2, p1], mid: { x: at('x'), y: at('y') } };
}
