// layout.js - pure graph layout shared by several assets (sankey, flow, sketch, decision, layers). No DOM.
const SWEEPS = 4;

/**
 * Layers a directed graph: layer = longest path from a source, cycles tolerated (a back edge is ignored for layering), order inside a
 * layer = barycentre of the neighbours (a few sweeps) so edges cross less. `ids` in input order; `edges` [{from, to}].
 * Returns {layerOf: Map, layers: string[][], backEdges: Set<edge>}.
 */
export function layerGraph(ids, edges) {
  const out = new Map(ids.map((id) => [id, []]));
  for (const e of edges) if (out.has(e.from) && out.has(e.to)) out.get(e.from).push(e);
  // find back edges with an iterative-free DFS (graphs here are small)
  const state = new Map();
  const back = new Set();
  const visit = (id) => {
    state.set(id, 1);
    for (const e of out.get(id)) {
      const st = state.get(e.to);
      if (st === 1) back.add(e);
      else if (!st) visit(e.to);
    }
    state.set(id, 2);
  };
  for (const id of ids) if (!state.get(id)) visit(id);
  const fwd = edges.filter((e) => out.has(e.from) && out.has(e.to) && !back.has(e));
  const layerOf = new Map(ids.map((id) => [id, 0]));
  for (let pass = 0; pass < ids.length; pass++) {
    let moved = false;
    for (const e of fwd) if (layerOf.get(e.to) < layerOf.get(e.from) + 1) { layerOf.set(e.to, layerOf.get(e.from) + 1); moved = true; }
    if (!moved) break;
  }
  const n = Math.max(0, ...layerOf.values()) + 1;
  const layers = Array.from({ length: n }, () => []);
  for (const id of ids) layers[layerOf.get(id)].push(id);
  const pos = new Map();
  const index = () => layers.forEach((l) => l.forEach((id, i) => pos.set(id, i)));
  index();
  const bary = (id, towards) => {
    const near = fwd.filter((e) => (towards < 0 ? e.to === id : e.from === id)).map((e) => pos.get(towards < 0 ? e.from : e.to));
    return near.length ? near.reduce((a, b) => a + b, 0) / near.length : pos.get(id);
  };
  for (let k = 0; k < SWEEPS; k++) {
    const dir = k % 2 === 0 ? -1 : 1;
    const order = dir < 0 ? layers.keys() : [...layers.keys()].reverse();
    for (const li of order) {
      layers[li].sort((a, b) => bary(a, dir) - bary(b, dir));
      layers[li].forEach((id, i) => pos.set(id, i));
    }
  }
  return { layerOf, layers, backEdges: back };
}

/**
 * Places layered nodes on a w x h box: x by layer (even columns), y by order inside the layer (even rows). `pad` keeps nodes off the edge.
 * Returns Map id -> {x, y} (centres).
 */
export function placeLayers(layers, w, h, pad = 0) {
  const out = new Map();
  const cols = layers.length;
  layers.forEach((ids, li) => {
    ids.forEach((id, i) => {
      out.set(id, {
        x: cols === 1 ? w / 2 : pad + ((w - 2 * pad) * li) / (cols - 1),
        y: pad + ((h - 2 * pad) * (i + 0.5)) / ids.length,
      });
    });
  });
  return out;
}

/** Cubic path between two points leaving horizontally (a flow ribbon centre line). */
export const hCurve = (x0, y0, x1, y1) => {
  const mx = (x0 + x1) / 2;
  return `M${x0},${y0} C${mx},${y0} ${mx},${y1} ${x1},${y1}`;
};

/** Greedy non-overlap of 1-D labels: `ys` sorted by input order, each at least `gap` apart inside [lo, hi]; returns new ys (same order). */
export function spread(ys, gap, lo, hi) {
  const idx = ys.map((y, i) => [y, i]).sort((a, b) => a[0] - b[0]);
  const out = new Array(ys.length);
  let prev = lo - gap;
  for (const [y, i] of idx) { prev = Math.max(y, prev + gap); out[i] = prev; }
  const over = (out.length ? Math.max(...out) : 0) - hi;
  if (over > 0) { const order = idx.map(([, i]) => i); let next = hi + gap; for (let k = order.length - 1; k >= 0; k--) { next = Math.min(out[order[k]], next - gap); out[order[k]] = next; } }
  return out;
}

/**
 * Vertical label placement: each item {y, h} (wanted centre, its height) keeps its place when it can, is pushed down past the label above,
 * and the whole stack is pulled back up if it overflows `hi`. Returns the centres in input order.
 */
export function stackLabels(items, lo, hi, gap = 2) {
  const order = items.map((it, i) => i).sort((a, b) => items[a].y - items[b].y);
  const out = new Array(items.length);
  let edge = lo;
  for (const i of order) { out[i] = Math.max(items[i].y, edge + items[i].h / 2); edge = out[i] + items[i].h / 2 + gap; }
  let limit = hi;
  for (let k = order.length - 1; k >= 0; k--) { const i = order[k]; out[i] = Math.min(out[i], limit - items[i].h / 2); limit = out[i] - items[i].h / 2 - gap; }
  return out;
}
