// core.js - panel/assets foundations: the asset contract, data validation with clear errors, SVG + text helpers, colours.
// An asset is `defineAsset({kind, shape, summary, sample, validate, draw})`. `validate(data)` returns clean data or throws an
// AssetError naming the field; `draw(ctx)` paints for a known width x height. The wrapper (createAsset) owns the frame:
// optional title, caption, resize handling, the error panel, reduced motion, accessible label. DOM-free until draw runs,
// so validate() and the pure layout helpers are unit-tested under node (web/assets.test.mjs).
import { h, addCss, ensureStyle, reducedMotion } from '../ui/core.js';
import { clamp, isNum, isObj, formatNumber } from '../ui/pure.js';

export { h, reducedMotion, clamp, isNum, isObj, formatNumber };
export const SVG_NS = 'http://www.w3.org/2000/svg';

// ---- limits (named once; the viz frame caps the payload separately in hooks/board-frames.ts) --------------------------------
export const LIMITS = Object.freeze({ items: 400, text: 80, longText: 240, depth: 8, points: 400 });
const NARROW_PX = 520;
const MIN_PX = 12; // the smallest text any asset draws, unless the host raises it (opts.minPx)
const SECONDARY_RATIO = 0.9; // secondary text is this share of the font size, never below px.min
const FS_MIN = 13;
const FS_MAX = 19;
const FS_PER_PX = 50;
const ASPECT_DEFAULT = 0.6;
const H_MIN = 200;
const H_MAX = 640;
const SHOWN_CHARS = 48;
const GLYPH_EM = 0.56; // average glyph width in em when no canvas can measure

// ---- validation -------------------------------------------------------------------------------------------------------------
export class AssetError extends Error {
  constructor(message) { super(message); this.name = 'AssetError'; }
}
const shown = (x) => { try { const t = JSON.stringify(x); return t === undefined ? String(x) : t.length > SHOWN_CHARS ? `${t.slice(0, SHOWN_CHARS)}...` : t; } catch { return typeof x; } };
const absent = (x) => x === undefined || x === null;
const fail = (path, what, got) => { throw new AssetError(`${path} must be ${what} (got ${shown(got)})`); };

export const TONES = Object.freeze(['ok', 'warn', 'danger', 'info', 'neutral']);

/** Field checks. Each returns the clean value; `optional` returns undefined for an absent field. Errors name the path. */
export const check = {
  object(x, path, keys) {
    if (!isObj(x)) fail(path, `an object {${keys.join(', ')}}`, x);
    for (const k of Object.keys(x)) if (!keys.includes(k)) throw new AssetError(`${path}.${k} is not a known field (allowed: ${keys.join(', ')})`);
    return x;
  },
  array(x, path, { min = 1, max = LIMITS.items } = {}) {
    if (!Array.isArray(x)) fail(path, `an array of ${min === 0 ? 'up to' : `${min} to`} ${max} items`, x);
    if (x.length < min) throw new AssetError(`${path} needs at least ${min} item${min === 1 ? '' : 's'} (got ${x.length})`);
    if (x.length > max) throw new AssetError(`${path} has ${x.length} items; the limit is ${max}: keep the ones that matter`);
    return x;
  },
  string(x, path, { max = LIMITS.text, optional = false } = {}) {
    if (absent(x)) { if (optional) return undefined; fail(path, 'a string', x); }
    if (typeof x !== 'string' || x.trim() === '') fail(path, 'a non-empty string', x);
    if (x.length > max) throw new AssetError(`${path} is ${x.length} characters; the limit is ${max}: shorten it`);
    return x.trim();
  },
  number(x, path, { min = -Infinity, max = Infinity, optional = false } = {}) {
    if (absent(x)) { if (optional) return undefined; fail(path, 'a number', x); }
    if (!isNum(x)) fail(path, 'a finite number', x);
    if (x < min || x > max) fail(path, `a number from ${min} to ${max}`, x);
    return x;
  },
  oneOf(x, path, list, { optional = false } = {}) {
    if (absent(x)) { if (optional) return undefined; fail(path, `one of ${list.join('|')}`, x); }
    if (!list.includes(x)) fail(path, `one of ${list.join('|')}`, x);
    return x;
  },
  bool(x, path) { if (absent(x)) return undefined; if (typeof x !== 'boolean') fail(path, 'true or false', x); return x; },
  tone(x, path) { return check.oneOf(x, path, TONES, { optional: true }); },
  /** `src`: a relative path in the scene folder or a data:image URL; never a URL with a scheme. */
  src(x, path) {
    const t = check.string(x, path, { max: 300000 });
    if (/^(https?:)?\/\//i.test(t) || /^(javascript|file):/i.test(t)) throw new AssetError(`${path} must be a relative path in the scene folder or a data:image URL, not a network URL`);
    return t;
  },
  /** An id: letters, digits, _ and -; unique within `seen` (a Set). */
  id(x, path, seen) {
    const t = check.string(x, path, { max: 40 });
    if (seen) { if (seen.has(t)) throw new AssetError(`${path} "${t}" is used twice: give each its own id`); seen.add(t); }
    return t;
  },
};
/** Every item of an array through `fn(item, path, index)`. */
export const each = (arr, path, opts, fn) => check.array(arr, path, opts).map((it, i) => fn(it, `${path}[${i}]`, i));
/** A series of finite numbers. */
export const numbers = (arr, path, opts) => each(arr, path, opts, (n, p) => check.number(n, p));
/** A value that must name an id seen before. */
export function ref(x, path, seen, what = 'node') {
  const t = check.string(x, path, { max: 40 });
  if (!seen.has(t)) throw new AssetError(`${path} "${t}" is not a ${what} id of this asset (ids: ${[...seen].slice(0, 12).join(', ')})`);
  return t;
}

// ---- colours: theme tokens only, so dark and light both work -----------------------------------------------------------------
export const TONE_VAR = Object.freeze({ ok: 'var(--ui-ok)', warn: 'var(--ui-warn)', danger: 'var(--ui-danger)', info: 'var(--ui-acc)', neutral: 'var(--ui-mut)' });
const CAT_COUNT = 6;
const CAT_FADE_PCT = 62;
/** Categorical colour i (0-based); past six, the same hues faded toward the text colour so they stay distinct. */
export const catColor = (i) => {
  const base = `var(--ui-c${(i % CAT_COUNT) + 1})`;
  return i < CAT_COUNT ? base : `color-mix(in srgb, ${base} ${CAT_FADE_PCT}%, var(--ui-fg))`;
};
export const toneColor = (tone, fallback = 'var(--ui-acc)') => TONE_VAR[tone] ?? fallback;
/** `pct`% of colour `c` over the card background (a soft fill). */
export const soft = (c, pct) => `color-mix(in srgb, ${c} ${pct}%, var(--ui-card))`;
/** Sequential heat: 0..1 -> accent over the card background. */
export const heat = (t, c = 'var(--ui-acc)') => soft(c, Math.round(8 + 92 * clamp(t, 0, 1)));

// ---- SVG + text ---------------------------------------------------------------------------------------------------------------
const STYLE_KEYS = new Set(['fill', 'stroke', 'stop-color', 'color']);
const needsStyle = (v) => typeof v === 'string' && (v.startsWith('var(') || v.startsWith('color-mix('));
/** s('rect', {x, y, fill: 'var(--ui-acc)'}, child, 'text') -> SVG element. Text children become text nodes. */
export function s(tag, attrs, ...kids) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (STYLE_KEYS.has(k) && needsStyle(v)) el.style.setProperty(k, v);
    else if (k === 'text') el.textContent = String(v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  return el;
}
/** Native hover tooltip for an SVG element. */
export const tip = (el, text) => { el.append(s('title', {}, text)); return el; };

let measureCtx = null;
/** Width in px of `str` at `px` font size (canvas-measured in a browser, estimated elsewhere). */
export function textWidth(str, px, weight = 500) {
  const t = String(str ?? '');
  if (typeof document === 'undefined') return t.length * px * GLYPH_EM;
  measureCtx ??= document.createElement('canvas').getContext('2d');
  measureCtx.font = `${weight} ${px}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  return measureCtx.measureText(t).width;
}
/** `str` cut with an ellipsis so it fits `maxW` px. */
export function ellipsize(str, maxW, px, weight) {
  const t = String(str ?? '');
  if (maxW <= 0) return '';
  if (textWidth(t, px, weight) <= maxW) return t;
  let lo = 0;
  let hi = t.length;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (textWidth(`${t.slice(0, mid)}...`, px, weight) <= maxW) lo = mid; else hi = mid - 1; }
  return lo > 0 ? `${t.slice(0, lo).trimEnd()}...` : '';
}
/** `str` broken into at most `maxLines` lines of at most `maxW` px; the last line is ellipsized when text is left over. */
export function wrap(str, maxW, px, maxLines = 3, weight) {
  const words = String(str ?? '').split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (cur && textWidth(next, px, weight) > maxW) { lines.push(cur); cur = w; } else cur = next;
  }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) { const rest = lines.slice(maxLines - 1).join(' '); lines.length = maxLines - 1; lines.push(ellipsize(rest, maxW, px, weight)); }
  return lines.map((l) => (textWidth(l, px, weight) > maxW ? ellipsize(l, maxW, px, weight) : l));
}
/**
 * Text in an SVG parent. opts: size (px), anchor start|middle|end, cls (pa-t | pa-m | pa-d | pa-b), baseline middle|hanging|auto, maxW (ellipsize), lines (wrap
 * to maxW, line height 1.2). Returns the <text>.
 */
export function txt(parent, x, y, str, { size = 14, anchor = 'start', cls = 'pa-t', baseline = 'middle', maxW, lines, fill, weight } = {}) {
  const body = maxW ? (lines ? wrap(str, maxW, size, lines, weight) : [ellipsize(str, maxW, size, weight)]) : [String(str ?? '')];
  const el = s('text', { x, y: lines ? y - ((body.length - 1) * size * 0.6) : y, class: cls, 'font-size': size, 'text-anchor': anchor, 'dominant-baseline': baseline, fill, 'font-weight': weight });
  if (body.length === 1) el.textContent = body[0];
  else body.forEach((l, i) => el.append(s('tspan', { x, dy: i === 0 ? 0 : size * 1.2 }, l)));
  parent.append(el);
  return el;
}
/** A number for labels: 1,200 / 1.2k / 3.4M with an optional unit. */
export const fmt = (v, unit = '', compact = true) => `${formatNumber(v, { compact: compact && Math.abs(v) >= 10000, decimals: Math.abs(v) < 10 && !Number.isInteger(v) ? 1 : undefined })}${unit ? (unit.length <= 2 ? unit : ` ${unit}`) : ''}`;

// ---- the wrapper ---------------------------------------------------------------------------------------------------------------
addCss(`
.pa [hidden] { display: none !important; }
.pa { margin: 0; display: flex; flex-direction: column; gap: 6px; min-width: 0; width: 100%; font: var(--ui-fs)/1.35 var(--ui-font); color: var(--ui-fg); }
.pa-fill { position: absolute; inset: 0; }
.pa-title { font-size: max(var(--ui-fs-s), var(--pa-min, 0px)); font-weight: 650; color: var(--ui-mut); letter-spacing: .06em; text-transform: uppercase; }
.pa-stage { position: relative; min-width: 0; width: 100%; }
.pa-fill .pa-stage { flex: 1 1 0; min-height: 0; }
.pa-stage > svg { display: block; width: 100%; overflow: visible; }
.pa-cap { color: var(--ui-mut); font-size: max(var(--ui-fs-s), var(--pa-min, 0px)); line-height: 1.35; }
.pa-err { border: 1px dashed var(--ui-danger); border-radius: var(--ui-r-s); padding: 10px 12px; color: var(--ui-fg); font-size: var(--ui-fs-s); overflow-wrap: anywhere; }
.pa-err b { color: var(--ui-danger); }
.pa-err code { font-family: var(--ui-mono); font-size: .92em; color: var(--ui-mut); }
.pa svg text { font-family: var(--ui-font); font-variant-numeric: tabular-nums; }
.pa-t { fill: var(--ui-fg); } .pa-m { fill: var(--ui-mut); } .pa-d { fill: var(--ui-dim); } .pa-b { fill: var(--ui-fg); font-weight: 700; } .pa-on { fill: var(--ui-on-acc); font-weight: 650; }
.pa-halo { paint-order: stroke; stroke: var(--ui-card); stroke-width: 3px; stroke-linejoin: round; }
.pa-grid { stroke: var(--ui-line); stroke-width: 1; fill: none; }
.pa-axis { stroke: var(--ui-line-hi); stroke-width: 1; fill: none; }
.pa-flow { stroke-dasharray: 3 9; animation: pa-flow 1.1s linear infinite; }
@keyframes pa-flow { to { stroke-dashoffset: -12; } }
.pa-in { animation: pa-in .5s var(--ui-ease) backwards; }
@keyframes pa-in { from { opacity: 0; } }
@media (prefers-reduced-motion: reduce) { .pa-flow, .pa-in { animation: none !important; } }
`);

/** Font size for a stage `w` px wide (13..19 px, growing with width) unless the caller fixed it. */
/** The current smallest text size in px. Assets read `px.min` while they draw; createAsset sets it from opts.minPx and the font size just before each draw. */
export const px = { min: MIN_PX };
export const fontFor = (w, fixed) => (isNum(fixed) ? fixed : clamp(w / FS_PER_PX, FS_MIN, FS_MAX));

function errorPanel(def, err) {
  const keys = def.keys ? `Fields: ${def.keys.join(', ')}.` : '';
  return h('div.pa-err', { role: 'alert' }, h('b', `${def.kind}: `), err.message, h('div', h('code', keys)));
}

/**
 * The element for one asset. opts: title, caption, fill (fill the parent's height: the board frame), height (px), fs (fixed font px), minPx (raise the smallest text; the board passes its own floor).
 * Returns a <figure> with `update(data, optsPatch?)`, `data()`, `destroy()`, and `kind`. Never throws: bad data shows an error panel that names the field.
 */
export function createAsset(def, data, opts = {}) {
  ensureStyle();
  let cur = opts;
  let clean = null;
  let cleanup = null;
  let token = 0;
  let last = '';
  const titleEl = h('div.pa-title');
  const stage = h('div.pa-stage');
  const capEl = h('figcaption.pa-cap');
  const root = h('figure.pa.ui', { 'data-kind': def.kind }, titleEl, stage, capEl);

  const stop = () => { token++; try { cleanup?.(); } catch { /* a draw cleanup must not break the next paint */ } cleanup = null; };
  function paint(force = false) {
    if (!clean) return;
    const w = Math.round(stage.clientWidth);
    if (w <= 0) return;
    const fill = Boolean(cur.fill);
    const natural = def.html && !cur.height && !fill;
    const hh = fill ? Math.round(stage.clientHeight) : natural ? 0 : Math.round(cur.height ?? clamp(w * (def.aspect ?? ASPECT_DEFAULT), def.minH ?? H_MIN, def.maxH ?? H_MAX));
    if (!natural && hh <= 0) return;
    const key = `${w}x${hh}`;
    if (!force && key === last) return;
    last = key;
    stop();
    stage.replaceChildren();
    if (!fill && !natural) stage.style.height = `${hh}px`; else if (!fill) stage.style.height = '';
    const svg = def.html ? null : s('svg', { viewBox: `0 0 ${w} ${hh}`, width: w, height: hh, role: 'img', 'aria-label': [cur.title, def.kind, cur.caption].filter(Boolean).join(': ') });
    stage.append(svg ?? '');
    const mine = token;
    const ctx = { data: clean, w, h: hh, fs: fontFor(w, cur.fs), narrow: w < NARROW_PX, svg, root: stage, reduced: reducedMotion(), fill, emit: (name, d) => globalThis.panel?.emit?.(name, d) };
    const onFail = (e) => { if (mine === token) stage.replaceChildren(errorPanel(def, e)); };
    px.min = Math.max(MIN_PX, cur.minPx ?? 0, ctx.fs * SECONDARY_RATIO);
    try {
      const out = def.draw(ctx);
      if (out && typeof out.then === 'function') out.then((fn) => { if (mine === token && typeof fn === 'function') cleanup = fn; else if (typeof fn === 'function') fn(); }, onFail);
      else if (typeof out === 'function') cleanup = out;
    } catch (e) { onFail(e); }
  }
  function setData(d) {
    try { clean = def.validate(d); root.dataset.state = 'ok'; stage.hidden = false; root.querySelector(':scope > .pa-err')?.remove(); } catch (e) {
      clean = null; stop(); root.dataset.state = 'error';
      root.querySelector(':scope > .pa-err')?.remove();
      stage.hidden = true; stage.replaceChildren(); root.insertBefore(errorPanel(def, e), capEl);
    }
  }
  function decorate() {
    root.classList.toggle('pa-fill', Boolean(cur.fill));
    root.style.setProperty('--pa-min', `${cur.minPx ?? 0}px`);
    titleEl.textContent = cur.title ?? ''; titleEl.hidden = !cur.title;
    capEl.textContent = cur.caption ?? ''; capEl.hidden = !cur.caption;
  }
  decorate();
  setData(data);
  let ro = null;
  let pending = 0;
  if (typeof ResizeObserver === 'function') {
    ro = new ResizeObserver(() => { cancelAnimationFrame(pending); pending = requestAnimationFrame(() => paint()); });
    ro.observe(stage);
  }
  queueMicrotask(() => paint(true));
  root.kind = def.kind;
  root.data = () => clean;
  root.update = (next, optsPatch) => { if (optsPatch) { cur = { ...cur, ...optsPatch }; decorate(); } setData(next); last = ''; paint(true); return root; };
  root.destroy = () => { ro?.disconnect(); cancelAnimationFrame(pending); stop(); };
  return root;
}

// ---- defining -----------------------------------------------------------------------------------------------------------------
/**
 * def: {kind, shape (the information shape it answers), summary, keys (field names), sample (valid data), validate(data) -> clean, draw(ctx),
 * aspect (height/width, default .6), minH, maxH, html (true: draw into ctx.root instead of an SVG)}.
 * Returns `make(data, opts) -> element` with the definition on `make.def`.
 */
export function defineAsset(def) {
  for (const k of ['kind', 'shape', 'summary', 'sample', 'validate', 'draw']) if (!def[k]) throw new Error(`asset definition is missing ${k}`);
  const make = (data, opts) => createAsset(def, data, opts);
  make.def = def;
  return make;
}
