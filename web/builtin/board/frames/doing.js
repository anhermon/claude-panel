// doing: what KIND of work every agent is doing right now, one line each (frames/lanes.js has the detail). A colored kind glyph,
// the agent's short name, the kind ("UI", "Tests", "Thinking") and up to two file basenames; running agents first. Under the
// rows a one-line legend of the kinds that are on screen, nothing else. Drawn from data.lanes (board-logic injects them), so it
// changes exactly when an agent's work does; the clock ticks once a second so a kind that went quiet turns into "thinking".
import { doingRows, legendKinds } from '../doing-logic.mjs';
import { kindMeta } from '../kind-meta.mjs';
import { h } from './dom.js';
import { loadCssOnce } from './css.js';
import { fitStack } from './fit.js';

await loadCssOnce(new URL('./doing.css', import.meta.url).href, 'doing');

const TICK_MS = 1000;
const FILES_JOIN = ', ';
const FIT_SHARE = 0.07;
const LEGEND_ITEMS = 1;
const FIT_MAX_TIMES = 1.4;
const SPREAD_MAX_EM = 0.6;
const COMPACT_MAX_TIMES = 1.15;
const FIT_LEVELS = [{ name: 'roomy' }, { name: 'compact', maxTimes: COMPACT_MAX_TIMES }]; // see doing.css: files under the name, then one line each
const fits = new WeakMap(); // .doing root -> { stop, refit }
const colorOf = (kind) => `--kc:${kindMeta(kind).color}`;

const rowEl = (r) => {
  const meta = kindMeta(r.kind);
  return h('li', { class: 'dg-row', 'data-kind': r.kind, 'data-running': r.running ? 'true' : 'false', style: colorOf(r.kind) },
    h('i', { class: 'dg-glyph', text: meta.glyph }),
    h('b', { class: 'dg-name', text: r.name }),
    h('span', { class: 'dg-kind', text: meta.label }),
    h('span', { class: 'dg-files', text: r.files.join(FILES_JOIN) }));
};

const legendEl = (kinds) => h('p', { class: 'dg-legend' }, kinds.map((k) => h('span', { class: 'dg-lg', style: colorOf(k) }, h('i', { text: kindMeta(k).glyph }), h('span', { class: 'dg-lg-label', text: kindMeta(k).label }))));

function paint(root, lanes) {
  const rows = doingRows(lanes, Date.now());
  root.querySelector('.doing-body').replaceChildren(h('ul', { class: 'dg-list' }, rows.map(rowEl)), legendEl(legendKinds(rows)));
  root.dataset.n = String(rows.length);
}

export function render(el, f, ctx) {
  const body = h('div', { class: 'doing-body' });
  const root = h('div', { class: 'doing' }, body);
  const box = { lanes: f.lanes };
  el.append(root);
  paint(root, box.lanes);
  const stack = fitStack({ box: root, content: body, share: FIT_SHARE, maxTimes: FIT_MAX_TIMES, maxSpreadEm: SPREAD_MAX_EM, levels: FIT_LEVELS, clamped: '.dg-name, .dg-legend', rows: () => root.querySelectorAll('.dg-row').length + LEGEND_ITEMS }); // the legend is one more stacked item: its gap is spread too
  fits.set(root, { ...stack, box });
  const tick = setInterval(() => { paint(root, box.lanes); stack.refit(); }, TICK_MS);
  ctx.onDispose(() => { clearInterval(tick); stack.stop(); });
}

export function update(el, f) {
  const root = el.querySelector('.doing');
  const fit = fits.get(root);
  if (!fit) return false;
  fit.box.lanes = f.lanes;
  paint(root, f.lanes);
  fit.refit();
  return true;
}
