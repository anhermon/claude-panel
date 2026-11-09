// insight-dom.js - what the four workflow-insight frames (kindstack, sinks, repeats, hints) share: the stacked-body skeleton that
// fits its font to the frame (frames/fit.js), the caption, and the key of the kinds' colours. Each frame supplies only `paint`.
import { kindMeta } from '../kind-meta.mjs';
import { h } from './dom.js';
import { loadCssOnce } from './css.js';
import { fitStack } from './fit.js';

await loadCssOnce(new URL('./insight-frames.css', import.meta.url).href, 'insight-frames');

const FIT_SHARE = 0.045;
const FIT_MAX_TIMES = 1.25;
const SPREAD_MAX_EM = 0.5;
const COMPACT_MAX_TIMES = 1.1;
const FIT_LEVELS = [{ name: 'roomy' }, { name: 'compact', maxTimes: COMPACT_MAX_TIMES }]; // see insight-frames.css: compact drops the secondary lines
const KIND_LEGEND_GAP = 1;

const fits = new WeakMap(); // .ix root -> { stop, refit }

/** The headline: one line stating what the numbers found (computed by the mod), above the chart. */
export const captionEl = (text) => (text ? h('p', { class: 'ix-caption ix-headline', text }) : null);

/** The method behind the numbers: one muted line under the chart, hidden when the frame is tight. */
export const footEl = (text) => (text ? h('p', { class: 'ix-foot', text, title: text }) : null);

/** The key of the kinds' colours: colored glyph + the kind's word, wrapping. */
export const kindKeyEl = (kinds) => (kinds.length === 0 ? null : h('p', { class: 'ix-key' }, kinds.map((k) => h('span', { class: 'ix-key-item', style: `--kc:${kindMeta(k).color}` }, h('i', { text: kindMeta(k).glyph }), h('span', { text: kindMeta(k).label })))));

/**
 * The module of an insight frame. `name` is its css class, `paint(body, frame)` fills the body from scratch (called again on
 * every update: the data is small and changes only when the numbers do).
 */
export function insightFrame({ name, paint, clamped }) {
  const draw = (root, f) => { const body = root.querySelector('.ix-body'); body.replaceChildren(); paint(body, f); };
  return {
    render(el, f, ctx) {
      const body = h('div', { class: 'ix-body' });
      const root = h('div', { class: `ix ${name}` }, body);
      el.append(root);
      draw(root, f);
      const stack = fitStack({ box: root, content: body, share: FIT_SHARE, maxTimes: FIT_MAX_TIMES, maxSpreadEm: SPREAD_MAX_EM, levels: FIT_LEVELS, clamped, rows: () => body.children.length + KIND_LEGEND_GAP - 1 });
      fits.set(root, stack);
      ctx.onDispose(stack.stop);
    },
    update(el, f) {
      const root = el.querySelector(`.${name}`);
      if (!root) return false;
      draw(root, f);
      fits.get(root)?.refit();
      return true;
    },
  };
}
