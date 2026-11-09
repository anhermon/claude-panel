// matrix.js - `matrix`: a heatmap of rows x columns (which agent touched which file, which test failed in which build). Cell colour is the
// value; numbers print inside when they fit; empty cells stay empty. Pure layout numbers live in named constants so the render is predictable.
import { AssetError, check, each, defineAsset, s, txt, tip, heat, textWidth, ellipsize, fmt, clamp } from './core.js';
import { fitHeight, labelColumn } from './compare.js';

const MAX_AXIS = 30;
const CELL_GAP = 2;
const ROTATE_DEG = 40;
const COL_LABEL_MAX_PX = 96;
const CELL_RATIO = 0.62;
const CELL_MAX_H = 44;
const CELL_PAD = 6;
const ON_ACC_AT = 0.62; // above this heat the cell is dark enough to need the light text colour
const RAMP_STEPS = 6;
const RAMP_W = 18;
const SMALL = 0.95;

function validateMatrix(d) {
  check.object(d, 'data', ['unit', 'rows', 'cols', 'values', 'rowTitle', 'colTitle', 'totals']);
  const rows = each(d.rows, 'data.rows', { max: MAX_AXIS }, (r, p) => check.string(r, p, { max: 32 }));
  const cols = each(d.cols, 'data.cols', { max: MAX_AXIS }, (c, p) => check.string(c, p, { max: 32 }));
  const values = each(d.values, 'data.values', { min: rows.length, max: rows.length }, (row, p) => each(row, p, { min: cols.length, max: cols.length }, (v, q) => (v === null ? null : check.number(v, q))));
  if (values.flat().every((v) => v === null)) throw new AssetError('data.values has no numbers: at least one cell needs a value');
  return {
    unit: check.string(d.unit, 'data.unit', { max: 12, optional: true }), rows, cols, values,
    rowTitle: check.string(d.rowTitle, 'data.rowTitle', { max: 24, optional: true }), colTitle: check.string(d.colTitle, 'data.colTitle', { max: 24, optional: true }), totals: check.bool(d.totals, 'data.totals') ?? false,
  };
}

function drawMatrix(ctx) {
  const { data, svg, w, fs } = ctx;
  const small = fs * SMALL;
  const labW = labelColumn(data.rows, fs, w, 500, 0.3);
  const colMax = Math.min(COL_LABEL_MAX_PX, Math.max(...data.cols.map((c) => textWidth(c, small, 600))));
  const nCols = data.cols.length;
  const totalW = data.totals ? textWidth(fmt(Math.max(...data.values.map((r) => r.reduce((a, v) => a + (v ?? 0), 0)), 0)), small, 700) + CELL_PAD * 2 : 0;
  // rotate the column labels only when they do not fit flat over a cell
  const roughCw = (w - labW - totalW) / nCols;
  const flat = colMax + 4 <= roughCw;
  const rad = (ROTATE_DEG * Math.PI) / 180;
  const rightPad = flat ? 0 : Math.max(0, colMax * Math.cos(rad) - roughCw / 2 + 4);
  const gridW = w - labW - totalW - rightPad;
  const cw = gridW / nCols;
  const ch = clamp(cw * CELL_RATIO, fs * 1.8, CELL_MAX_H);
  const titleH = data.colTitle ? small * 1.4 : 0;
  const headH = titleH + (flat ? small * 1.6 : colMax * Math.sin(rad) + small * 1.2);
  const nRows = data.rows.length;
  const footH = (data.totals ? ch : 0) + small * 2.4;
  const hh = fitHeight(ctx, ctx.fill ? ctx.h : Math.ceil(headH + nRows * ch + footH));
  const x0 = labW;
  const y0 = headH;
  const flatVals = data.values.flat().filter((v) => v !== null);
  const lo = Math.min(...flatVals);
  const hi = Math.max(...flatVals);
  const t = (v) => (hi === lo ? 1 : (v - lo) / (hi - lo));
  if (data.colTitle) txt(svg, x0, small * 0.7, data.colTitle, { size: small, cls: 'pa-d', weight: 600, maxW: gridW });
  if (data.rowTitle) txt(svg, labW - 8, headH - small * 0.7, data.rowTitle, { size: small, anchor: 'end', cls: 'pa-d', weight: 600, maxW: labW - 8 });
  data.cols.forEach((c, j) => {
    const cx = x0 + cw * (j + 0.5);
    if (flat) txt(svg, cx, headH - small * 0.8, c, { size: small, anchor: 'middle', cls: 'pa-m', weight: 600, maxW: cw });
    else {
      const el = txt(svg, cx, headH - 4, ellipsize(c, COL_LABEL_MAX_PX, small, 600), { size: small, anchor: 'start', cls: 'pa-m', weight: 600, baseline: 'auto' });
      el.setAttribute('transform', `rotate(${-ROTATE_DEG} ${cx} ${headH - 4})`);
    }
  });
  data.rows.forEach((r, i) => {
    const y = y0 + i * ch;
    txt(svg, labW - 8, y + ch / 2, r, { size: fs, anchor: 'end', maxW: labW - 8, cls: 'pa-t' });
    data.values[i].forEach((v, j) => {
      const x = x0 + j * cw;
      const box = { 'data-r': i, 'data-c': j, x: x + CELL_GAP / 2, y: y + CELL_GAP / 2, width: cw - CELL_GAP, height: ch - CELL_GAP, rx: 4 };
      if (v === null) { svg.append(tip(s('rect', { ...box, fill: 'none', stroke: 'var(--ui-line)', 'stroke-dasharray': '3 3' }), `${r} / ${data.cols[j]}: no data`)); return; }
      const heatT = t(v);
      svg.append(tip(s('rect', { ...box, fill: heat(heatT), class: 'pa-in' }), `${r} / ${data.cols[j]}: ${fmt(v, data.unit)}`));
      const label = fmt(v);
      if (textWidth(label, small, 650) + CELL_PAD <= cw - CELL_GAP) txt(svg, x + cw / 2, y + ch / 2, label, { size: small, anchor: 'middle', cls: heatT > ON_ACC_AT ? 'pa-on' : 'pa-t', weight: 650 });
    });
    if (data.totals) txt(svg, x0 + gridW + CELL_PAD, y + ch / 2, fmt(data.values[i].reduce((a, v) => a + (v ?? 0), 0)), { size: small, cls: 'pa-b' });
  });
  if (data.totals) {
    const y = y0 + nRows * ch;
    txt(svg, labW - 8, y + ch / 2, 'Total', { size: small, anchor: 'end', cls: 'pa-m', weight: 600 });
    data.cols.forEach((_, j) => txt(svg, x0 + cw * (j + 0.5), y + ch / 2, fmt(data.values.reduce((a, row) => a + (row[j] ?? 0), 0)), { size: small, anchor: 'middle', cls: 'pa-b', maxW: cw }));
  }
  // colour key: the ramp with its min and max, so the shade means a number
  const ky = hh - small * 1.2;
  const kx = x0;
  txt(svg, kx, ky, fmt(lo, data.unit), { size: small, anchor: 'start', cls: 'pa-m' });
  const rx = kx + textWidth(fmt(lo, data.unit), small) + 8;
  for (let k = 0; k < RAMP_STEPS; k++) svg.append(s('rect', { x: rx + k * RAMP_W, y: ky - small / 2, width: RAMP_W, height: small, fill: heat(k / (RAMP_STEPS - 1)) }));
  txt(svg, rx + RAMP_STEPS * RAMP_W + 8, ky, fmt(hi, data.unit), { size: small, anchor: 'start', cls: 'pa-m' });
}

export const matrix = defineAsset({
  kind: 'matrix',
  shape: 'how two categories co-occur (file x agent, test x build, kind x hour); where the hot cells are',
  summary: 'A heatmap grid: shade = value, number inside when it fits, dashed empty cell = no data, optional row/column totals and a colour key with the range.',
  keys: ['unit', 'rows', 'cols', 'values', 'rowTitle', 'colTitle', 'totals'],
  aspect: 0.7,
  minH: 200,
  maxH: 640,
  sample: {
    unit: 'edits', rowTitle: 'File', colTitle: 'Agent', totals: true,
    rows: ['core.js', 'layout.js', 'flow.js', 'compare.js', 'index.js'],
    cols: ['W1', 'W2', 'W3', 'W4', 'Lead'],
    values: [[null, null, null, null, 9], [null, 2, null, null, 1], [null, null, null, null, 7], [null, null, 12, null, null], [1, 1, 1, 1, 4]],
  },
  validate: validateMatrix,
  draw: drawMatrix,
});
