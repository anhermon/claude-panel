// diagram: nodes and edges, laid out by diagram-layout.mjs to the pixel box the frame has. Edges are dashed lines that
// flow toward their arrowheads. No coordinates come from the data. Plain SVG, 1 unit = 1 css px.
import { labelFont, layoutDiagram, normalizeDiagram } from '../diagram-layout.mjs';
import { h, measureText, nextId, uiScale, watchSize } from './dom.js';

const FONT_MIN = 14;
const FONT_MAX = 24;
const FONT_DIVISOR_W = 36;
const FONT_DIVISOR_H = 7;
const ARROW_FONT_RATIO = 0.62;
const NODE_RADIUS_RATIO = 0.7;
const LINE_HEIGHT = 1.3;
const STAGGER_S = 0.07;
const TONES = new Set(['ok', 'warn', 'danger', 'info', 'accent', 'muted']);

function draw(svg, spec, w, ph, animate) {
  svg.replaceChildren();
  svg.setAttribute('viewBox', `0 0 ${w} ${ph}`);
  svg.setAttribute('width', w);
  svg.setAttribute('height', ph);
  const u = uiScale();
  const minFont = FONT_MIN * u;
  const down = document.documentElement.dataset.shape === 'portrait'; // a tall pane: layers stack top to bottom
  const fit = down ? FONT_MAX * u : Math.min(w / FONT_DIVISOR_W, ph / FONT_DIVISOR_H); // the layout shrinks it until it fits
  const font = Math.max(minFont, Math.min(FONT_MAX * u, Math.round(fit)));
  const lay = layoutDiagram(spec, { width: w, height: ph, font, measure: measureText, minFont, direction: down ? 'down' : 'right' });
  const mark = nextId('arrow');
  const ms = lay.font * ARROW_FONT_RATIO;
  svg.append(h('defs', {}, h('marker', { id: mark, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: ms, markerHeight: ms, markerUnits: 'userSpaceOnUse', orient: 'auto' }, h('path', { class: 'arrow', d: 'M0,1 L10,5 L0,9 Z' }))));
  const g = h('g', { transform: `translate(${lay.offset.x.toFixed(1)},${lay.offset.y.toFixed(1)}) scale(${lay.scale.toFixed(3)})` });
  svg.append(g);
  lay.edges.forEach((e, i) => g.append(h('path', { class: `edge${e.back ? ' back' : ''}`, d: e.d, 'marker-end': `url(#${mark})`, style: animate ? `--i:${i}` : null })));
  lay.edges.filter((e) => e.label).forEach((e) => g.append(h('g', { class: 'chip-g' },
    h('rect', { class: 'edge-chip', x: e.lx - e.lw / 2, y: e.ly - e.lh / 2, width: e.lw, height: e.lh, rx: e.lh / 2 }),
    h('text', { class: 'edge-label', x: e.lx, y: e.ly, style: `font-size:${labelFont(lay.font, minFont)}px`, text: e.label }))));
  lay.nodes.forEach((n, i) => {
    const tone = TONES.has(n.tone) ? n.tone : '';
    g.append(h('g', { class: `node${animate ? ' enter' : ''}`, 'data-tone': tone, style: animate ? `animation-delay:${(i * STAGGER_S).toFixed(2)}s` : null },
      h('rect', { x: n.x, y: n.y, width: n.w, height: n.h, rx: lay.font * NODE_RADIUS_RATIO }),
      n.lines.map((line, k) => h('text', { x: n.x + n.w / 2, y: n.y + n.h / 2 + (k - (n.lines.length - 1) / 2) * lay.font * LINE_HEIGHT, style: `font-size:${lay.font}px`, text: line }))));
  });
}

export function render(el, f, ctx) {
  const spec = normalizeDiagram(f);
  const svg = h('svg', { class: 'diagram-svg', role: 'img', 'aria-label': spec.nodes.map((n) => n.label).join(', ') });
  el.append(h('div', { class: 'diagram' }, svg));
  let first = true;
  const stop = watchSize(el.firstChild, ({ w, h: ph }) => { draw(svg, spec, w, ph, first && !ctx.reduced); first = false; });
  ctx.onDispose(stop);
}
