// <p-diagram direction="lr|tb" rough><li data-node="a">Client</li><li data-from="a" data-to="b">retry</li></p-diagram> - node-link diagram with automatic
// layered layout, drawn as SVG with animated edges. `data-node` lines name/label nodes (optional: nodes appear from edges too); the
// text of a `data-from/data-to` line is the edge label. `rough` switches to a hand-drawn look (rough.js, loaded on demand).
import { PanelElement, reducedMotion, el } from './base.js';
import { flag, wrapText } from './pure.js';
import { layoutGraph, edgeCurve } from './graph.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const FONT_PX = 16;
const LINE_PX = 20;
const CHAR_PX = FONT_PX * 0.58; // average glyph width used to size nodes without measuring
const NODE_PAD_X = 18;
const NODE_PAD_Y = 12;
const NODE_MIN_W = 84;
const WRAP_CHARS = 20;
const ARROW_PX = 11;
const STAGGER_MS = 110;
const MAX_WIDTH_SCALE = 1.5; // the svg never grows beyond 1.5x its natural size (text would balloon)
const DOT_SECONDS = 2.6;
let diagramCount = 0; // makes the <mpath> targets unique when a page holds several diagrams

const svg = (tag, attrs = {}, ...kids) => {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  node.append(...kids);
  return node;
};

function parse(kids) {
  const labels = new Map();
  const edges = [];
  for (const li of kids.filter((k) => k.tagName === 'LI')) {
    const d = li.dataset;
    if (d.node) labels.set(d.node, li.textContent.trim() || d.node);
    else if (d.from && d.to) edges.push({ from: d.from, to: d.to, label: li.textContent.trim() });
  }
  for (const e of edges) for (const id of [e.from, e.to]) if (!labels.has(id)) labels.set(id, id);
  return { labels, edges };
}

export class PDiagram extends PanelElement {
  static observedAttributes = ['direction', 'rough'];

  async setup() {
    const { labels, edges } = parse(this.kids);
    if (!labels.size) throw new Error('add <li data-node="a">Label</li> and <li data-from="a" data-to="b">label</li> children');
    const direction = this.getAttribute('direction') === 'tb' ? 'tb' : 'lr';
    const rough = flag(this.getAttribute('rough'));
    const rc = rough ? (await this.until(import('roughjs'))).default : null;

    const sized = [...labels].map(([id, text]) => {
      const lines = wrapText(text, WRAP_CHARS);
      const w = Math.max(NODE_MIN_W, Math.max(...lines.map((l) => l.length)) * CHAR_PX + NODE_PAD_X * 2);
      return { id, lines, w, h: lines.length * LINE_PX + NODE_PAD_Y * 2 };
    });
    const layout = layoutGraph(sized, edges.map((e) => [e.from, e.to]), { direction });
    const canvas = svg('svg', { viewBox: `0 0 ${layout.width} ${layout.height}`, role: 'img', class: 'p-dg' });
    canvas.style.maxWidth = `${Math.round(layout.width * MAX_WIDTH_SCALE)}px`;
    canvas.setAttribute('aria-label', `Diagram: ${edges.map((e) => `${labels.get(e.from)} to ${labels.get(e.to)}`).join('; ') || [...labels.values()].join(', ')}`);
    const uid = `pdg${++diagramCount}`;
    const roughSvg = rc ? rc.svg(canvas) : null;
    const seed = (s) => [...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7); // stable hand-drawn wobble per shape

    const edgeLayer = svg('g', { class: 'p-dg-edges' });
    const dotLayer = svg('g', { class: 'p-dg-dots' });
    const nodeLayer = svg('g', { class: 'p-dg-nodes' });
    edges.forEach((e, i) => {
      const a = layout.nodes.get(e.from);
      const b = layout.nodes.get(e.to);
      if (!a || !b || e.from === e.to) return;
      const curve = edgeCurve(a, b, { direction, back: layout.back.has(`${e.from}>${e.to}`) });
      const group = svg('g', { class: 'p-dg-edge' });
      group.style.setProperty('--d', `${i * STAGGER_MS}ms`);
      const [, , c2, tip] = curve.points;
      const angle = Math.atan2(tip.y - c2.y, tip.x - c2.x);
      const wing = (sign) => `${tip.x - Math.cos(angle + sign * 0.45) * ARROW_PX},${tip.y - Math.sin(angle + sign * 0.45) * ARROW_PX}`;
      const arrow = `M${wing(1)} L${tip.x},${tip.y} L${wing(-1)}`;
      if (roughSvg) group.append(roughSvg.path(curve.d, { roughness: 1.1, bowing: 1, seed: seed(`${e.from}${e.to}`) }));
      else group.append(svg('path', { d: curve.d }));
      group.append(svg('path', { d: arrow }));
      for (const p of group.querySelectorAll('path')) p.setAttribute('pathLength', '1');
      edgeLayer.append(group);
      if (e.label) {
        const t = svg('text', { x: curve.mid.x, y: curve.mid.y - 8, class: 'p-dg-label', 'text-anchor': 'middle' });
        t.textContent = e.label;
        group.append(t);
      }
      if (!reducedMotion()) {
        const path = svg('path', { d: curve.d, id: `${uid}-e${i}`, fill: 'none', stroke: 'none' });
        const dot = svg('circle', { r: 3.5, class: 'p-dg-dot' }, svg('animateMotion', { dur: `${DOT_SECONDS}s`, repeatCount: 'indefinite', begin: `${(i * STAGGER_MS) / 1000 + 1}s` }, svg('mpath', { href: `#${path.id}` })));
        dot.style.setProperty('--d', `${i * STAGGER_MS}ms`);
        dotLayer.append(path, dot);
      }
    });
    sized.forEach((n, i) => {
      const p = layout.nodes.get(n.id);
      const g = svg('g', { class: 'p-dg-node' });
      g.style.setProperty('--d', `${i * STAGGER_MS}ms`);
      g.append(svg('rect', { x: p.x, y: p.y, width: p.w, height: p.h, rx: 10, class: 'p-dg-box' }));
      if (roughSvg) g.append(roughSvg.rectangle(p.x, p.y, p.w, p.h, { roughness: 1.2, seed: seed(n.id) }));
      const text = svg('text', { x: p.x + p.w / 2, y: p.y + NODE_PAD_Y + FONT_PX * 0.8, 'text-anchor': 'middle' });
      n.lines.forEach((line, k) => { const span = svg('tspan', { x: p.x + p.w / 2, dy: k ? LINE_PX : 0 }); span.textContent = line; text.append(span); });
      g.append(text);
      nodeLayer.append(g);
    });
    canvas.append(edgeLayer, dotLayer, nodeLayer);
    if (rough) canvas.classList.add('p-dg-rough');
    this.append(el('div', { className: 'p-diagram-box' }, canvas));
    this.own(() => canvas.remove());
    this.watchActive((active) => { // draw edges in each time the diagram is shown
      canvas.classList.remove('in');
      if (active) requestAnimationFrame(() => requestAnimationFrame(() => canvas.classList.add('in')));
    });
  }
}
