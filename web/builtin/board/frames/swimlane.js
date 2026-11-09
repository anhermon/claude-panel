// swimlane: one lane per agent over the session. Each lane has the agent's name and how long it ran ("26 min 4 s") above a
// track whose bars are colored by the kind of work (the shared axis starts at the session's first start, so a late agent starts
// late). Under the lanes a one-line legend of the kinds present. No call counts. The track is an svg of rects in a 0..AXIS box
// stretched to the lane's width; times are seconds from the session start (hooks/board-agents.ts agentSwimlane).
import { laneDuration, legendKinds, normalizeSwimlane, share } from '../doing-logic.mjs';
import { kindMeta } from '../kind-meta.mjs';
import { h } from './dom.js';
import { loadCssOnce } from './css.js';
import { fitStack } from './fit.js';

await loadCssOnce(new URL('./doing.css', import.meta.url).href, 'doing');

const AXIS = 1000; // the svg's own width units
const MIN_BAR = 3; // a stretch is never thinner than this many units
const TRACK_H = 10;
const FIT_SHARE = 0.07;
const LEGEND_ITEMS = 1;
const FIT_MAX_TIMES = 1.3;
const SPREAD_MAX_EM = 0.5;
const COMPACT_MAX_TIMES = 1.15;
const FIT_LEVELS = [{ name: 'roomy' }, { name: 'compact', maxTimes: COMPACT_MAX_TIMES }];
const fits = new WeakMap();

const barEl = (s, end) => {
  const x = Math.round(share(s.a, end) * AXIS);
  const w = Math.max(MIN_BAR, Math.round(share(s.b, end) * AXIS) - x);
  return h('rect', { x: Math.min(x, AXIS - MIN_BAR), y: 0, width: w, height: TRACK_H, fill: kindMeta(s.k).color, 'data-k': s.k });
};

const laneEl = (it, end) => h('li', { class: 'sw-lane', 'data-state': it.state },
  h('b', { class: 'sw-name', text: it.label }),
  h('span', { class: 'sw-dur', text: laneDuration(it) }),
  h('svg', { class: 'sw-track', viewBox: `0 0 ${AXIS} ${TRACK_H}`, preserveAspectRatio: 'none', 'aria-hidden': 'true' }, it.segs.map((s) => barEl(s, end))));

const legendEl = (kinds) => h('p', { class: 'dg-legend dg-wrap' }, kinds.map((k) => h('span', { class: 'dg-lg', style: `--kc:${kindMeta(k).color}` }, h('i', { text: kindMeta(k).glyph }), h('span', { class: 'dg-lg-label', text: kindMeta(k).label }))));

function paint(root, f) {
  const data = normalizeSwimlane(f);
  root.querySelector('.swimlane-body').replaceChildren(h('ol', { class: 'sw-list' }, data.items.map((it) => laneEl(it, data.end))), legendEl(data.kinds));
}

export function render(el, f, ctx) {
  const body = h('div', { class: 'swimlane-body' });
  const root = h('div', { class: 'swimlane' }, body);
  el.append(root);
  paint(root, f);
  const stack = fitStack({ box: root, content: body, share: FIT_SHARE, maxTimes: FIT_MAX_TIMES, maxSpreadEm: SPREAD_MAX_EM, levels: FIT_LEVELS, clamped: '.sw-name, .dg-legend', rows: () => root.querySelectorAll('.sw-lane').length + LEGEND_ITEMS }); // the legend is one more stacked item: its gap is spread too
  fits.set(root, stack);
  ctx.onDispose(stack.stop);
}

export function update(el, f) {
  const root = el.querySelector('.swimlane');
  if (!root) return false;
  paint(root, f);
  fits.get(root)?.refit();
  return true;
}
