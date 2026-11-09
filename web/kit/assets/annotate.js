// annotate.js - `annotate`: a picture (screenshot, diagram) with numbered markers on the places that matter and callout text beside it.
// Wide: callouts in the left and right margins with arrows to their markers. Narrow: the picture, then the numbered list below.
import { check, each, defineAsset, s, txt, toneColor, soft, wrap, clamp, px } from './core.js';
import { spread } from './layout.js';

const MAX_NOTES = 8;
const RATIO_DEFAULT = 16 / 10;
const MARKER_R = 10;
const RING_R = 15;
const BOX_MIN = 0.03; // smallest box side, as a share of the picture
const MARGIN_MIN = 130;
const MARGIN_MAX = 210;
const MARGIN_SHARE = 0.23;
const GAP = 12;
const PAD = 8;
const MAX_LINES = 4;
const SHAPES = ['dot', 'ring', 'box'];

function validateAnnotate(d) {
  check.object(d, 'data', ['src', 'alt', 'ratio', 'notes']);
  const unit = (x, p) => check.number(x, p, { min: 0, max: 1 });
  return {
    src: d.src === undefined ? undefined : check.src(d.src, 'data.src'),
    alt: check.string(d.alt, 'data.alt', { max: 160, optional: true }),
    ratio: check.number(d.ratio, 'data.ratio', { min: 0.2, max: 5, optional: true }) ?? RATIO_DEFAULT,
    notes: each(d.notes, 'data.notes', { max: MAX_NOTES }, (n, p) => {
      check.object(n, p, ['x', 'y', 'text', 'tone', 'shape', 'w', 'h']);
      return {
        x: unit(n.x, `${p}.x`), y: unit(n.y, `${p}.y`), text: check.string(n.text, `${p}.text`, { max: 160 }), tone: check.tone(n.tone, `${p}.tone`),
        shape: check.oneOf(n.shape, `${p}.shape`, SHAPES, { optional: true }) ?? 'dot',
        w: n.w === undefined ? undefined : check.number(n.w, `${p}.w`, { min: BOX_MIN, max: 1 }), h: n.h === undefined ? undefined : check.number(n.h, `${p}.h`, { min: BOX_MIN, max: 1 }),
      };
    }),
  };
}

/** Draws the picture (or an honest placeholder) into box {x, y, w, h}; returns nothing. */
function paintPicture(svg, data, box, fs) {
  svg.append(s('rect', { ...box, rx: 6, fill: 'var(--ui-card-hi)', stroke: 'var(--ui-line-hi)' }));
  if (data.src) {
    svg.append(s('image', { href: data.src, x: box.x, y: box.y, width: box.width, height: box.height, preserveAspectRatio: 'xMidYMid meet' }, data.alt ? s('title', {}, data.alt) : null));
    return;
  }
  // no picture was given: a neutral wireframe, labelled as such so nobody mistakes it for the real thing
  const cols = 8;
  const rows = 5;
  for (let i = 1; i < cols; i++) svg.append(s('line', { x1: box.x + (box.width * i) / cols, x2: box.x + (box.width * i) / cols, y1: box.y, y2: box.y + box.height, class: 'pa-grid' }));
  for (let i = 1; i < rows; i++) svg.append(s('line', { x1: box.x, x2: box.x + box.width, y1: box.y + (box.height * i) / rows, y2: box.y + (box.height * i) / rows, class: 'pa-grid' }));
  txt(svg, box.x + box.width / 2, box.y + box.height / 2, 'no image: wireframe placeholder', { size: Math.max(px.min, fs * 0.9), anchor: 'middle', cls: 'pa-m pa-halo', maxW: box.width - 16 });
}

function marker(svg, n, i, px, py, pic, color) {
  const g = svg.appendChild(s('g'));
  if (n.shape === 'box') {
    const bw = (n.w ?? 0.15) * pic.width;
    const bh = (n.h ?? 0.12) * pic.height;
    const bx = clamp(px - bw / 2, pic.x, pic.x + pic.width - bw);
    const by = clamp(py - bh / 2, pic.y, pic.y + pic.height - bh);
    g.append(s('rect', { x: bx, y: by, width: bw, height: bh, rx: 4, fill: color, 'fill-opacity': 0.16, stroke: color, 'stroke-width': 2 }));
    return { x: bx + bw / 2, y: by + bh / 2, edge: { l: bx, r: bx + bw }, badge: [bx, by] };
  }
  if (n.shape === 'ring') g.append(s('circle', { cx: px, cy: py, r: RING_R, fill: 'none', stroke: color, 'stroke-width': 2.5 }));
  return { x: px, y: py, edge: { l: px - (n.shape === 'ring' ? RING_R : MARKER_R), r: px + (n.shape === 'ring' ? RING_R : MARKER_R) }, badge: n.shape === 'ring' ? [px - RING_R * 0.7, py - RING_R * 0.7] : [px, py] };
}

function badge(svg, x, y, i, color) {
  svg.append(s('circle', { cx: x, cy: y, r: MARKER_R, fill: color, stroke: 'var(--ui-card)', 'stroke-width': 2 }));
  txt(svg, x, y, String(i + 1), { size: px.min, anchor: 'middle', cls: 'pa-on', weight: 700 });
}

function drawWide(ctx) {
  const { data, svg, w, h, fs } = ctx;
  const margin = clamp(w * MARGIN_SHARE, MARGIN_MIN, MARGIN_MAX);
  const area = { w: w - 2 * (margin + GAP), h: h - 4 };
  const pw = Math.min(area.w, area.h * data.ratio);
  const ph = pw / data.ratio;
  const pic = { x: (w - pw) / 2, y: (h - ph) / 2, width: pw, height: ph };
  paintPicture(svg, data, pic, fs);
  const textW = margin - 2 * PAD - MARKER_R * 2 - 4;
  const items = data.notes.map((n, i) => {
    const color = toneColor(n.tone);
    const px = pic.x + n.x * pw;
    const py = pic.y + n.y * ph;
    const lines = wrap(n.text, textW, px.min + 1, MAX_LINES);
    return { n, i, color, px, py, lines, bh: lines.length * (px.min + 1) * 1.25 + 2 * PAD, side: n.x < 0.5 ? 'l' : 'r' };
  });
  const marks = items.map((it) => ({ ...it, m: marker(svg, it.n, it.i, it.px, it.py, pic, it.color) }));
  for (const side of ['l', 'r']) {
    const group = marks.filter((it) => it.side === side);
    if (!group.length) continue;
    const gap = Math.max(...group.map((it) => it.bh)) + 6;
    const ys = spread(group.map((it) => it.m.y), gap, gap / 2, Math.max(gap / 2, h - gap / 2));
    group.forEach((it, k) => {
      const bx = side === 'l' ? 2 : w - margin - 2 + GAP;
      const bw = margin - GAP + 0;
      const cy = ys[k];
      const edgeX = side === 'l' ? bx + bw : bx;
      const tx = side === 'l' ? it.m.edge.l : it.m.edge.r;
      const elbow = side === 'l' ? edgeX + GAP / 2 : edgeX - GAP / 2;
      svg.insertBefore(s('polyline', { points: `${edgeX},${cy} ${elbow},${cy} ${tx},${it.m.y}`, fill: 'none', stroke: it.color, 'stroke-width': 1.5 }), svg.firstChild);
      svg.append(s('rect', { x: bx, y: cy - it.bh / 2, width: bw, height: it.bh, rx: 8, fill: soft(it.color, 12), stroke: soft(it.color, 55) }));
      badge(svg, bx + PAD + MARKER_R, cy - it.bh / 2 + PAD + MARKER_R * 0.4 + 1, it.i, it.color);
      it.lines.forEach((l, li) => txt(svg, bx + PAD + MARKER_R * 2 + 6, cy - it.bh / 2 + PAD + (li + 0.5) * (px.min + 1) * 1.25 + 1, l, { size: px.min + 1, cls: 'pa-t' }));
    });
  }
  marks.forEach((it) => badge(svg, it.m.badge[0], it.m.badge[1], it.i, it.color));
}

function drawNarrow(ctx) {
  const { data, svg, w, fs } = ctx;
  const pw = w - 4;
  const ph = pw / data.ratio;
  const pic = { x: 2, y: 2, width: pw, height: ph };
  paintPicture(svg, data, pic, fs);
  const marks = data.notes.map((n, i) => ({ n, i, color: toneColor(n.tone) }));
  marks.forEach((it) => { it.m = marker(svg, it.n, it.i, pic.x + it.n.x * pw, pic.y + it.n.y * ph, pic, it.color); });
  marks.forEach((it) => badge(svg, it.m.badge[0], it.m.badge[1], it.i, it.color));
  // the list below: number badge + wrapped text
  const textW = w - MARKER_R * 2 - 14;
  let y = ph + 14;
  const lines = marks.map((it) => wrap(it.n.text, textW, fs, MAX_LINES));
  const total = y + lines.reduce((a, l) => a + l.length * fs * 1.25 + 10, 0);
  if (!ctx.fill && total > ctx.h) {
    ctx.root.style.height = `${total}px`;
    svg.setAttribute('height', total);
    svg.setAttribute('viewBox', `0 0 ${w} ${total}`);
  }
  marks.forEach((it, k) => {
    badge(svg, MARKER_R + 2, y + MARKER_R, it.i, it.color);
    lines[k].forEach((l, li) => txt(svg, MARKER_R * 2 + 12, y + MARKER_R + li * fs * 1.25, l, { size: fs, cls: 'pa-t' }));
    y += lines[k].length * fs * 1.25 + 10;
  });
}

// a tiny UI mock-up (<1.5 KB) so the sample works without files; hex colours are fine inside an image
const MOCK_SVG = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 320 200'><rect width='320' height='200' fill='%23f4f5f8'/><rect width='320' height='24' fill='%23273049'/><circle cx='14' cy='12' r='5' fill='%237c9cff'/><rect x='30' y='8' width='70' height='8' rx='4' fill='%23aab2c8'/><rect x='0' y='24' width='62' height='176' fill='%23e3e6ee'/><rect x='10' y='38' width='42' height='7' rx='3' fill='%23b3bace'/><rect x='10' y='54' width='42' height='7' rx='3' fill='%23b3bace'/><rect x='10' y='70' width='42' height='7' rx='3' fill='%23b3bace'/><rect x='76' y='36' width='112' height='62' rx='6' fill='%23fff' stroke='%23d3d7e2'/><rect x='86' y='46' width='60' height='8' rx='4' fill='%23273049'/><rect x='86' y='64' width='92' height='22' rx='4' fill='%23dfe6ff'/><rect x='200' y='36' width='108' height='62' rx='6' fill='%23fff' stroke='%23d3d7e2'/><rect x='210' y='46' width='50' height='8' rx='4' fill='%23273049'/><rect x='270' y='44' width='30' height='12' rx='6' fill='%2316a34a'/><rect x='210' y='66' width='88' height='6' rx='3' fill='%23c8cddb'/><rect x='210' y='78' width='70' height='6' rx='3' fill='%23c8cddb'/><rect x='76' y='110' width='232' height='78' rx='6' fill='%23fff' stroke='%23d3d7e2'/><rect x='86' y='122' width='40' height='8' rx='4' fill='%23273049'/><rect x='86' y='140' width='212' height='6' rx='3' fill='%23dfe3ee'/><rect x='86' y='152' width='212' height='6' rx='3' fill='%23dfe3ee'/><rect x='236' y='166' width='62' height='16' rx='8' fill='%23dc2626'/></svg>`;

export const annotate = defineAsset({
  kind: 'annotate',
  shape: 'a picture (screenshot, diagram, rendered page) where specific spots need explaining; look HERE, because of THIS',
  summary: 'The picture with numbered markers (dot, ring or box) and callouts in the margins joined by arrows; a numbered list below on narrow widths. A wireframe placeholder when no image is given.',
  keys: ['src', 'alt', 'ratio', 'notes'],
  aspect: 0.5,
  minH: 260,
  sample: {
    src: `data:image/svg+xml,${MOCK_SVG}`,
    alt: 'Dashboard mock-up',
    ratio: 1.6,
    notes: [
      { x: 0.42, y: 0.12, text: 'Header total uses the old count (42, should be 57)', tone: 'danger' },
      { x: 0.89, y: 0.28, text: 'Status chip is clipped at narrow widths', tone: 'warn', shape: 'ring' },
      { x: 0.41, y: 0.37, text: 'Chart fills the card: this one is correct', tone: 'ok', shape: 'box', w: 0.29, h: 0.13 },
      { x: 0.83, y: 0.87, text: 'Retry button has no focus ring', tone: 'danger', shape: 'ring' },
    ],
  },
  validate: validateAnnotate,
  draw: (ctx) => (ctx.narrow ? drawNarrow(ctx) : drawWide(ctx)),
});
