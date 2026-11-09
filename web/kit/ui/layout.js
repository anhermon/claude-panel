// layout.js - stack / row / grid / card: containers that arrange other components.
import { h, build, addCss, splitArgs, setChildren } from './core.js';
import { TONES } from './pure.js';

addCss(`
.ui-stack { display: flex; flex-direction: column; gap: var(--g, var(--ui-gap)); align-items: var(--al, stretch); }
.ui-row { display: flex; flex-wrap: var(--wrap, wrap); gap: var(--g, var(--ui-gap)); align-items: var(--al, center); justify-content: var(--jc, flex-start); }
.ui-row > * { min-width: 0; }
.ui-grid { display: grid; gap: var(--g, var(--ui-gap)); align-items: var(--al, stretch);
  grid-template-columns: repeat(auto-fit, minmax(min(max(var(--min, 220px), calc(100% / var(--cols, 99) - var(--g, var(--ui-gap)))), 100%), 1fr)); }
.ui-grid > * { min-width: 0; }
.ui-card { background: linear-gradient(180deg, var(--ui-card-hi) -80%, var(--ui-card) 100%); border: 1px solid var(--ui-line); border-radius: var(--ui-r);
  padding: var(--ui-pad); display: flex; flex-direction: column; gap: 10px; min-width: 0; --tone: var(--ui-line-hi); }
.ui-card[data-tone] { border-left: 3px solid var(--tone); }
.ui-card-head { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
.ui-card-title { font-size: var(--ui-fs-s); font-weight: 600; letter-spacing: .12em; text-transform: uppercase; color: var(--ui-mut); }
.ui-card[data-tone] .ui-card-title { color: var(--tone); }
.ui-card-sub { font-size: var(--ui-fs-s); color: var(--ui-mut); }
.ui-card-body { display: flex; flex-direction: column; gap: var(--ui-gap); min-width: 0; }
`);

const sizeVar = (v) => (typeof v === 'number' ? `${v}px` : v);

// Builds a container component: option -> CSS variable map, children replaced only when `children` changes.
function container(name, vars) {
  return (...args) => {
    const { opts, children } = splitArgs(args);
    const el = h('div');
    return build(el, name, { ...opts, children: opts.children ?? children }, (o, prev) => {
      for (const [css, key] of Object.entries(vars)) {
        if (o[key] !== undefined) el.style.setProperty(css, sizeVar(o[key])); else el.style.removeProperty(css);
      }
      if (name === 'row' && o.wrap === false) el.style.setProperty('--wrap', 'nowrap'); else el.style.removeProperty('--wrap');
      if (!prev || o.children !== prev.children) setChildren(el, o.children);
    });
  };
}

/** stack({gap, align}, ...children): vertical flow. e.g. stack({gap: 8}, text('a'), text('b')) */
export const stack = container('stack', { '--g': 'gap', '--al': 'align' });
/** row({gap, align, justify, wrap}, ...children): horizontal flow that wraps. e.g. row(badge('ok'), badge('warn')) */
export const row = container('row', { '--g': 'gap', '--al': 'align', '--jc': 'justify' });
/** grid({cols, min, gap}, ...children): responsive columns (at most `cols`, each at least `min` px wide). e.g. grid({cols: 3, min: 200}, a, b, c) */
export const grid = container('grid', { '--g': 'gap', '--min': 'min', '--cols': 'cols', '--al': 'align' });

/** card({title, sub, tone}, ...children): framed group; tone = neutral|info|ok|warn|danger paints the left rule and title. e.g. card({title: 'Latency', tone: 'warn'}, chart(...)) */
export function card(...args) {
  const { opts, children } = splitArgs(args);
  const title = h('span.ui-card-title');
  const sub = h('span.ui-card-sub');
  const head = h('div.ui-card-head', null, title, sub);
  const body = h('div.ui-card-body');
  const el = h('div', null, head, body);
  return build(el, 'card', { ...opts, children: opts.children ?? children }, (o, prev) => {
    title.textContent = o.title ?? '';
    sub.textContent = o.sub ?? '';
    head.hidden = !o.title && !o.sub;
    for (const t of TONES) el.classList.toggle(`ui-tone-${t}`, o.tone === t);
    if (TONES.includes(o.tone)) el.dataset.tone = o.tone; else delete el.dataset.tone;
    if (!prev || o.children !== prev.children) setChildren(body, o.children);
  });
}
