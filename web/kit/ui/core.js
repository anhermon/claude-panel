// core.js - panel/ui foundations: theme tokens, one auto-injected stylesheet, the h() DOM helper, mount(), update plumbing,
// tweens and reduced-motion. Every component is `name(opts) -> HTMLElement` with `el.update(patch)`; see README.md.
import { progressAt, tweenAt, isNum, isObj } from './pure.js';

export const STYLE_ID = 'panel-ui-style';
export const SVG_NS = 'http://www.w3.org/2000/svg';
export const DUR = Object.freeze({ count: 700, grow: 550, flash: 1100, flip: 380, tip: 120 });
const REDUCED_QUERY = '(prefers-reduced-motion: reduce)';
const FIT_EVENT_GAP_MS = 60;

// Tokens: dark by default (palette of the Board scene), light under prefers-color-scheme or when the host sends {dark:false}
// (panel.js then sets data-theme). Series colours --ui-c1..c6 are the categorical order charts use.
const TOKENS_CSS = `
:root {
  color-scheme: dark light;
  --ui-bg: #0b0c10; --ui-card: #13151c; --ui-card-hi: #1b2033; --ui-line: #232735; --ui-line-hi: #2c3350;
  --ui-fg: #eceef3; --ui-mut: #8b91a1; --ui-dim: #5c6275;
  --ui-acc: #7c9cff; --ui-ok: #4ade80; --ui-warn: #fbbf24; --ui-danger: #f87171; --ui-violet: #c084fc; --ui-pink: #fb7185; --ui-cyan: #22d3ee;
  --ui-on-acc: #0b1020;
  --ui-c1: var(--ui-acc); --ui-c2: var(--ui-cyan); --ui-c3: var(--ui-warn); --ui-c4: var(--ui-violet); --ui-c5: var(--ui-ok); --ui-c6: var(--ui-pink);
  --ui-font: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --ui-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
  --ui-fs: 15px; --ui-fs-s: 13px; --ui-fs-l: 18px; --ui-fs-xl: 28px;
  --ui-r: 12px; --ui-r-s: 8px; --ui-gap: 12px; --ui-pad: 14px;
  --ui-ease: cubic-bezier(.2, .8, .2, 1);
}
@media (prefers-color-scheme: light) {
  :root:not([data-theme="dark"]) {
    --ui-bg: #fafaf9; --ui-card: #ffffff; --ui-card-hi: #f1efeb; --ui-line: #e4e1db; --ui-line-hi: #d3cfc6;
    --ui-fg: #1c1b1a; --ui-mut: #6b6760; --ui-dim: #a09b92;
    --ui-acc: #2f5bd0; --ui-ok: #15803d; --ui-warn: #b45309; --ui-danger: #b91c1c; --ui-violet: #7c3aed; --ui-pink: #be185d; --ui-cyan: #0e7490;
    --ui-on-acc: #ffffff;
  }
}
:root[data-theme="light"] {
  color-scheme: light;
  --ui-bg: #fafaf9; --ui-card: #ffffff; --ui-card-hi: #f1efeb; --ui-line: #e4e1db; --ui-line-hi: #d3cfc6;
  --ui-fg: #1c1b1a; --ui-mut: #6b6760; --ui-dim: #a09b92;
  --ui-acc: #2f5bd0; --ui-ok: #15803d; --ui-warn: #b45309; --ui-danger: #b91c1c; --ui-violet: #7c3aed; --ui-pink: #be185d; --ui-cyan: #0e7490;
  --ui-on-acc: #ffffff;
}
:root[data-theme="dark"] { color-scheme: dark; }
.ui-page, .ui-page body { margin: 0; background: var(--ui-bg); color: var(--ui-fg); }
.ui, .ui *, .ui *::before, .ui *::after { box-sizing: border-box; }
.ui { font: var(--ui-fs)/1.45 var(--ui-font); color: var(--ui-fg); min-width: 0; -webkit-font-smoothing: antialiased; }
.ui-root { padding: var(--ui-pad); display: flex; flex-direction: column; gap: var(--ui-gap); }
.ui [hidden] { display: none !important; }
.ui-tone-neutral, .ui.ui-tone-neutral { --tone: var(--ui-mut); } .ui-tone-info, .ui.ui-tone-info { --tone: var(--ui-acc); } .ui-tone-ok, .ui.ui-tone-ok { --tone: var(--ui-ok); }
.ui-tone-warn, .ui.ui-tone-warn { --tone: var(--ui-warn); } .ui-tone-danger, .ui.ui-tone-danger { --tone: var(--ui-danger); }
.ui-flash { animation: ui-flash ${DUR.flash}ms var(--ui-ease); }
@keyframes ui-flash { from { background: color-mix(in srgb, var(--ui-acc) 20%, transparent); } }
@media (prefers-reduced-motion: reduce) {
  .ui *, .ui *::before, .ui *::after { transition: none !important; animation: none !important; }
}
`;

const pending = [TOKENS_CSS];
let styleEl = null;

/** Registers component CSS (once per module); injected into the single <style id="panel-ui-style"> as soon as one exists. */
export function addCss(css) {
  pending.push(css);
  if (styleEl) styleEl.textContent += `\n${css}`;
}

/** Injects the stylesheet (idempotent). Called by mount() and by every component constructor. */
export function ensureStyle() {
  if (typeof document === 'undefined') return;
  styleEl = styleEl ?? document.getElementById(STYLE_ID);
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = STYLE_ID;
    styleEl.textContent = pending.join('\n');
    (document.head || document.documentElement).append(styleEl);
  }
}

/** True when the user asked for less motion: tweens jump to their end value, CSS transitions are off. */
export const reducedMotion = () => typeof matchMedia === 'function' && matchMedia(REDUCED_QUERY).matches;
/** Duration for a transition: 0 under reduced motion. */
export const dur = (ms) => (reducedMotion() ? 0 : ms);

const SVG_TAGS = new Set(['svg', 'g', 'path', 'circle', 'rect', 'line', 'text', 'tspan', 'polyline', 'polygon', 'ellipse', 'defs', 'clipPath', 'linearGradient', 'stop', 'title']);
const ATTR_ALIASES = { className: 'class', htmlFor: 'for' };

function applyProps(el, props, isSvg) {
  for (const [key, val] of Object.entries(props ?? {})) {
    if (val === undefined || val === null || val === false) continue;
    if (key.startsWith('on') && typeof val === 'function') el.addEventListener(key.slice(2).toLowerCase(), val);
    else if (key === 'style' && isObj(val)) {
      for (const [k, v] of Object.entries(val)) if (v !== undefined && v !== null) el.style.setProperty(k.startsWith('--') ? k : k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`), String(v));
    } else if (key === 'dataset' && isObj(val)) Object.assign(el.dataset, val);
    else if (key === 'text') el.textContent = String(val);
    else if (!isSvg && (key === 'value' || key === 'checked' || key === 'disabled' || key === 'selected') && key in el) el[key] = val;
    else el.setAttribute(ATTR_ALIASES[key] ?? key, val === true ? '' : String(val));
  }
}

/** Appends children: nodes, strings/numbers (as text), arrays (flattened); null/undefined/false are skipped. */
export function append(el, children) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

/** Replaces the children of `el`. */
export function setChildren(el, ...children) {
  el.replaceChildren();
  return append(el, children);
}

/**
 * h('div.card.wide', {onclick, style:{gap:'8px'}, 'aria-label':'x'}, child, 'text') -> element. Tag may carry .classes and #id.
 * SVG tags (svg, g, path, ...) get the SVG namespace automatically. Text is always set as a text node, never as HTML.
 */
export function h(tag, props, ...children) {
  const [name, ...rest] = (/^[.#]/.test(tag) ? `div${tag}` : tag).split(/(?=[.#])/);
  const isSvg = SVG_TAGS.has(name);
  const el = isSvg ? document.createElementNS(SVG_NS, name) : document.createElement(name || 'div');
  const classes = rest.filter((s) => s.startsWith('.')).map((s) => s.slice(1));
  const id = rest.find((s) => s.startsWith('#'));
  if (classes.length) el.setAttribute('class', classes.join(' '));
  if (id) el.id = id.slice(1);
  const hasProps = isObj(props) && !(props instanceof Node);
  applyProps(el, hasProps ? props : null, isSvg);
  return append(el, hasProps ? children : [props, ...children]);
}

/** Splits `(opts, ...children)` or `(...children)` call styles: a leading plain object is opts. */
export function splitArgs(args) {
  const [first, ...rest] = args;
  const hasOpts = isObj(first) && !(first instanceof Node);
  return { opts: hasOpts ? first : {}, children: (hasOpts ? rest : args).flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false) };
}

/**
 * Component plumbing: gives `el` the `ui` class, a merged-options `update(patch)` and `opts()`, then runs `apply(opts, prev, first)`
 * once now and again on every update. `apply` must diff against the existing DOM (no teardown) so updates animate.
 */
export function build(el, name, opts, apply, extraClass = '') {
  ensureStyle();
  el.classList.add('ui', `ui-${name}`);
  if (extraClass) el.classList.add(...extraClass.split(' ').filter(Boolean));
  let cur = { ...opts };
  el.update = (patch = {}) => {
    const prev = cur;
    cur = { ...cur, ...patch };
    apply(cur, prev, false);
    return el;
  };
  el.opts = () => cur;
  apply(cur, null, true);
  return el;
}

/** Mounts components into `root` (element, CSS selector, or document.body by default) and keeps the host height in sync. */
export function mount(root, ...components) {
  ensureStyle();
  const target = typeof root === 'string' ? document.querySelector(root) : root instanceof Node ? root : document.body;
  if (!target) throw new Error(`panel/ui mount: no element for ${String(root)}`);
  if (target === document.body) document.documentElement.classList.add('ui-page');
  target.classList.add('ui', 'ui-root');
  append(target, components.flat(Infinity));
  const fit = () => { try { globalThis.panel?.fit?.(); } catch { /* the host may be gone */ } };
  let timer = 0;
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(() => { clearTimeout(timer); timer = setTimeout(fit, FIT_EVENT_GAP_MS); }).observe(target);
  }
  fit();
  return target;
}

/** Tweens a number from `from` to `to` over `ms`, calling onFrame(v) each animation frame (last call is exactly `to`). Returns {cancel}. */
export function tween(from, to, onFrame, ms = DUR.count) {
  if (reducedMotion() || ms <= 0 || !isNum(from) || !isNum(to) || from === to || typeof requestAnimationFrame !== 'function') {
    onFrame(to);
    return { cancel() {} };
  }
  const start = performance.now();
  let id = 0;
  const step = (now) => {
    const t = progressAt(start, now, ms);
    onFrame(tweenAt(from, to, t));
    if (t < 1) id = requestAnimationFrame(step);
  };
  id = requestAnimationFrame(step);
  return { cancel: () => cancelAnimationFrame(id) };
}

/**
 * Count-up helper: returns `set(value)` that animates a number into `node.textContent` through `format(v)`.
 * Non-numeric values are written as text. The first call is instant (nothing to count from) unless `first` is true.
 */
export function counter(node, format = String) {
  let shown = null;
  let job = null;
  return function set(value, { first = false } = {}) {
    job?.cancel();
    if (!isNum(value)) { shown = null; node.textContent = value === undefined || value === null ? '' : String(value); return; }
    const from = shown === null ? (first ? 0 : value) : shown;
    job = tween(from, value, (v) => { shown = v; node.textContent = format(v); });
  };
}

/** Flashes an element (a brief tint) to say "this changed". No-op under reduced motion (CSS disables the animation). */
export function flash(el) {
  el.classList.remove('ui-flash');
  void el.offsetWidth; // restart the animation
  el.classList.add('ui-flash');
}

/**
 * FLIP: runs `mutate()` (which reorders/moves children carrying data-key inside `root`), then slides every kept element
 * from its old position to the new one. Nothing is cloned or re-created.
 */
export function flip(root, mutate) {
  const keyed = () => [...root.querySelectorAll('[data-key]')];
  const before = new Map(keyed().map((el) => [el, el.getBoundingClientRect()]));
  mutate();
  if (reducedMotion()) return;
  for (const el of keyed()) {
    const a = before.get(el);
    if (!a || typeof el.animate !== 'function') continue;
    const b = el.getBoundingClientRect();
    const dx = a.left - b.left;
    const dy = a.top - b.top;
    if (dx || dy) el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: DUR.flip, easing: 'cubic-bezier(.2,.8,.2,1)' });
  }
}

/** The colour (CSS value) of series i from the categorical palette. */
export const SERIES_COLORS = Object.freeze([1, 2, 3, 4, 5, 6].map((n) => `var(--ui-c${n})`));
export const seriesColor = (i, own) => own ?? SERIES_COLORS[i % SERIES_COLORS.length];
