// dom.js - tiny DOM helpers shared by the frame modules. Text always goes in as textContent, never as markup.
export const SVG_NS = 'http://www.w3.org/2000/svg';
export const PALETTE = ['#7c9cff', '#c084fc', '#fb7185', '#4ade80', '#fbbf24', '#22d3ee'];
export const TONES = { info: 'var(--acc)', ok: 'var(--ok)', warn: 'var(--warn)', danger: 'var(--danger)', muted: 'var(--mut)', accent: 'var(--acc)' };
export const toneColor = (tone) => TONES[tone] ?? null;

const NS_BY_TAG = (tag) => (SVG_TAGS.has(tag) ? SVG_NS : null);
const SVG_TAGS = new Set(['svg', 'g', 'path', 'circle', 'ellipse', 'rect', 'line', 'text', 'tspan', 'defs', 'marker', 'linearGradient', 'stop', 'polyline']);

/** h('div', {class: 'x', style: 'a:b', text: 'hi'}, child, 'text', ...) - svg tags get the svg namespace. */
export function h(tag, props = {}, ...kids) {
  const ns = NS_BY_TAG(tag);
  const el = ns ? document.createElementNS(ns, tag) : document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'text') el.textContent = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid);
  return el;
}

/** Two animation frames later: the element has been laid out in its start state, so a CSS transition will run. */
export const nextPaint = (fn) => requestAnimationFrame(() => requestAnimationFrame(fn));

export const easeOutCubic = (u) => 1 - (1 - u) ** 3;

/** Animates a number; the rAF loop ends by itself (a finished frame holds no timers). Returns cancel(). */
export function tween({ from, to, ms, onUpdate, ease = easeOutCubic }) {
  let raf = 0;
  const t0 = performance.now();
  const tick = (now) => {
    const u = Math.min(1, (now - t0) / ms);
    onUpdate(from + (to - from) * ease(u), u === 1);
    raf = u < 1 ? requestAnimationFrame(tick) : 0;
  };
  raf = requestAnimationFrame(tick);
  return () => { if (raf) cancelAnimationFrame(raf); raf = 0; };
}

/** Calls fn({w, h}) with the element's content box now and whenever it changes. Returns stop(). */
export function watchSize(el, fn) {
  let last = '';
  const run = () => {
    const w = Math.round(el.clientWidth);
    const h = Math.round(el.clientHeight);
    if (w > 0 && h > 0 && `${w}x${h}` !== last) { last = `${w}x${h}`; fn({ w, h }); }
  };
  const ro = new ResizeObserver(run);
  ro.observe(el);
  run();
  return () => ro.disconnect();
}

const SCALE_MAX = 3;
const VU_REF_PX = 9.6; // 1 type unit at 960x540
const PORTRAIT_TVU_BOOST = 1.8; // keep in step with --tvu in board.css
const VU_PER_VH = 1.7778;
/** How many times bigger the type is than at 960x540 (1 at and below it); follows --tvu of board.css, so svg text matches the html. */
export function uiScale() {
  const portrait = document.documentElement.dataset.shape === 'portrait';
  const vu = Math.min((portrait ? PORTRAIT_TVU_BOOST : 1) * innerWidth / 100, VU_PER_VH * innerHeight / 100);
  return Math.min(SCALE_MAX, Math.max(1, vu / VU_REF_PX));
}

let measureCtx = null;
/** Text width in px at a font size (system-ui, semi-bold), measured on a canvas. */
export function measureText(text, px) {
  measureCtx ??= document.createElement('canvas').getContext('2d');
  measureCtx.font = `600 ${px}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  return measureCtx.measureText(text).width;
}

let uid = 0;
export const nextId = (prefix) => `${prefix}-${++uid}`;
