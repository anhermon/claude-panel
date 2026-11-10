// motion.js - shared pieces for assets whose motion encodes data (galton, particles): a seeded RNG, a throttled frame loop that runs
// only while the element is attached and visible, a compact-mode test for small board tiles, and theme colours resolved for canvas.
// DOM-free until frameLoop / themeColors run, so the pure parts are unit-tested under node (web/assets.test.mjs).

export const SEED_DEFAULT = 1;
export const FPS_DEFAULT = 30;
export const COMPACT_HEIGHT_PX = 400; // a board tile is about 380 px tall in a half-width pane
const UINT32 = 2 ** 32;
// mulberry32 mixing constants and the stateless-hash multipliers (odd 32-bit primes keep neighbouring inputs apart).
const MIX = Object.freeze({ step: 0x6d2b79f5, a: 15, b: 7, c: 61, d: 14 });
const HASH_MUL = Object.freeze({ a: 0x9e3779b1, b: 0x85ebca6b, c: 0xc2b2ae35 });

/** A seeded generator: () -> float in [0, 1). The same seed always gives the same sequence. */
export function seededRng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + MIX.step) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> MIX.a), t | 1);
    t ^= t + Math.imul(t ^ (t >>> MIX.b), t | MIX.c);
    return ((t ^ (t >>> MIX.d)) >>> 0) / UINT32;
  };
}

/** A stateless float in [0, 1) for (seed, a, b): the same inputs give the same value, so state can be a pure function of time. */
export const unitHash = (seed, a, b = 0) => seededRng((Math.imul(seed, HASH_MUL.a) + Math.imul(a + 1, HASH_MUL.b) + Math.imul(b + 1, HASH_MUL.c)) >>> 0)();

/** True when the figure must use its compact layout: a narrow width, or a short fixed height such as a board tile. */
export const compactMode = (ctx) => ctx.narrow || (ctx.h > 0 && ctx.h < COMPACT_HEIGHT_PX);

/** Adds a class by attribute (keeps the class list readable by plain getAttribute, as the node tests do). */
export const addClass = (el, cls) => el.setAttribute('class', `${el.getAttribute('class') ?? ''} ${cls}`.trim());

/** Whether this runtime can animate at all (a browser with requestAnimationFrame); otherwise assets draw their static state. */
export const canAnimate = () => typeof requestAnimationFrame === 'function';

/** `{name: cssColor}` -> `{name: 'rgb(...)'}`: canvas cannot take var(...) or color-mix(...), so the browser resolves them on `el`. Read at draw time so a theme change shows. */
export function themeColors(el, spec) {
  if (typeof getComputedStyle !== 'function') return { ...spec };
  const out = {};
  for (const [name, css] of Object.entries(spec)) { el.style.color = css; out[name] = getComputedStyle(el).color; }
  el.style.color = '';
  return out;
}

/**
 * Calls `step(elapsedMs)` on animation frames, at most every `intervalMs`, only while `el` is attached and visible (tab shown, on screen).
 * `step` returns false when the motion has settled: the loop then disposes itself. A detached element disposes it too and calls `onDetach`
 * (so the caller can leave its final static state). Returns `stop()`, which disposes everything: frame, observer and listener.
 * Without requestAnimationFrame it does nothing and returns a no-op.
 */
export function frameLoop(el, step, { intervalMs = 1000 / FPS_DEFAULT, onDetach } = {}) {
  if (!canAnimate()) return () => {};
  let handle = 0;
  let last = -Infinity;
  let origin = null;
  let visible = true;
  let alive = true;
  let observer = null;
  const attached = () => el.isConnected !== false;
  const dispose = () => {
    alive = false;
    cancelAnimationFrame(handle);
    handle = 0;
    observer?.disconnect();
    document.removeEventListener?.('visibilitychange', wake);
  };
  const detach = () => { dispose(); onDetach?.(); };
  const runnable = () => alive && visible && !document.hidden;
  function schedule() { if (!handle && runnable()) handle = requestAnimationFrame(frame); }
  function pause() { cancelAnimationFrame(handle); handle = 0; }
  function frame(now) {
    handle = 0;
    if (!alive) return;
    if (!attached()) { detach(); return; }
    if (now - last >= intervalMs) {
      origin ??= now;
      last = now;
      if (step(now - origin) === false) { dispose(); return; }
    }
    schedule();
  }
  function wake() {
    if (alive && !attached()) detach();
    else if (document.hidden) pause();
    else schedule();
  }
  if (typeof IntersectionObserver === 'function') {
    observer = new IntersectionObserver((entries) => {
      visible = entries.at(-1).isIntersecting;
      if (alive && !attached()) detach();
      else if (visible) schedule();
      else pause();
    });
    observer.observe(el);
  }
  document.addEventListener?.('visibilitychange', wake);
  schedule();
  return dispose;
}
