// deck-logic.js - pure, DOM-free logic of the deck engine (hash, fragments, navigation, keys, gestures, overview grid).
// deck.js wires it to the DOM; deck-logic.test.mjs exercises it under node.
//
// Vocabulary: a deck "model" is an array (horizontal slides) of arrays (vertical slides) of numbers (fragment steps of
// that slide): model[h][v] === how many fragment steps slide (h, v) has. A position is {h, v, f}: slide plus the number of
// fragment steps already revealed (0 = none).

export const SLIDE_WIDTH = 1280;
export const SLIDE_HEIGHT = 720;
export const MIN_SCALE = 0.05;
export const CLICK_PREV_ZONE = 0.3; // clicks in the left 30 % go back, the rest go forward
export const SWIPE_MIN_PX = 50;
export const SWIPE_DOMINANCE = 1.5; // the main axis must beat the other one by this factor
export const OVERVIEW_GAP = 24;
export const OVERVIEW_PAD = 32;
export const OVERVIEW_MIN_SCALE = 0.16; // below this the overview scrolls instead of shrinking further
export const REPORT_TITLE_MAX = 120;
export const REPORT_NOTES_MAX = 2000;
export const KEY_MAX_LENGTH = 24;
export const TRANSITIONS = ['slide', 'fade', 'zoom', 'none'];
export const DEFAULT_TRANSITION = 'slide';

const toInt = (value) => {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
};

// ---- hash: #/h[/v[/f]] -------------------------------------------------------------------------------------------

export function parseHash(hash) {
  const m = /^#?\/(\d+)(?:\/(\d+))?(?:\/(\d+))?\/?$/.exec(String(hash ?? ''));
  if (!m) return { h: 0, v: 0, f: 0 };
  return { h: toInt(m[1]), v: toInt(m[2]), f: toInt(m[3]) };
}

export function formatHash({ h, v, f }) {
  if (f > 0) return `#/${h}/${v}/${f}`;
  if (v > 0) return `#/${h}/${v}`;
  return `#/${h}`;
}

// ---- fragments ---------------------------------------------------------------------------------------------------

/** explicit: per fragment (DOM order) its data-fragment-index or null/NaN. Unindexed ones follow the previous one. */
export function fragmentOrder(explicit) {
  let last = -1;
  return explicit.map((e) => {
    const idx = Number.isInteger(e) && e >= 0 ? e : last + 1;
    last = idx;
    return idx;
  });
}

/** Distinct, ascending fragment indices = the reveal steps of a slide. */
export const fragmentSteps = (order) => [...new Set(order)].sort((a, b) => a - b);

/** Which fragments are shown after `f` steps. */
export function visibleFragments(order, f) {
  const rank = new Map(fragmentSteps(order).map((value, i) => [value, i]));
  return order.map((idx) => rank.get(idx) < f);
}

// ---- navigation --------------------------------------------------------------------------------------------------

export function clampPos(model, pos) {
  const h = Math.min(Math.max(toInt(pos.h), 0), model.length - 1);
  const v = Math.min(Math.max(toInt(pos.v), 0), model[h].length - 1);
  const f = Math.min(toInt(pos.f), model[h][v]);
  return { h, v, f };
}

export const samePos = (a, b) => a.h === b.h && a.v === b.v && a.f === b.f;

/** next/prev walk every slide in reading order; right/left skip the rest of a vertical stack. Fragments go first. */
export function navigate(model, pos, action) {
  const { h, v, f } = pos;
  const steps = (hh, vv) => model[hh][vv];
  const lastV = (hh) => model[hh].length - 1;
  switch (action) {
    case 'next':
      if (f < steps(h, v)) return { h, v, f: f + 1 };
      if (v < lastV(h)) return { h, v: v + 1, f: 0 };
      if (h < model.length - 1) return { h: h + 1, v: 0, f: 0 };
      return pos;
    case 'prev':
      if (f > 0) return { h, v, f: f - 1 };
      if (v > 0) return { h, v: v - 1, f: steps(h, v - 1) };
      if (h > 0) return { h: h - 1, v: lastV(h - 1), f: steps(h - 1, lastV(h - 1)) };
      return pos;
    case 'right':
      if (f < steps(h, v)) return { h, v, f: f + 1 };
      if (h < model.length - 1) return { h: h + 1, v: 0, f: 0 };
      return pos;
    case 'left':
      if (f > 0) return { h, v, f: f - 1 };
      if (h > 0) return { h: h - 1, v: 0, f: steps(h - 1, 0) };
      return pos;
    case 'first':
      return { h: 0, v: 0, f: 0 };
    case 'last':
      return { h: model.length - 1, v: lastV(model.length - 1), f: steps(model.length - 1, lastV(model.length - 1)) };
    default:
      return pos;
  }
}

/** Every slide as {h, v} in reading order (used by the overview). */
export const leaves = (model) => model.flatMap((stack, h) => stack.map((_, v) => ({ h, v })));

// ---- keys & gestures ---------------------------------------------------------------------------------------------

const KEY_ACTIONS = {
  ArrowRight: 'right',
  ArrowLeft: 'left',
  ArrowDown: 'next',
  ArrowUp: 'prev',
  PageDown: 'next',
  PageUp: 'prev',
  ' ': 'next',
  Home: 'first',
  End: 'last',
  o: 'overview',
  f: 'fullscreen',
  i: 'drawer', // host notes/summary drawer
  s: 'drawer', // reveal.js habit: speaker notes
  m: 'mute',
  Escape: 'escape',
  Enter: 'enter',
};

/** Maps a key (DOM KeyboardEvent.key or a host `key` message) to a deck action, or null. Modified keys are never ours. */
export function keyToAction(key, mods = {}) {
  if (typeof key !== 'string' || mods.ctrl || mods.meta || mods.alt) return null;
  const k = key === 'Space' || key === 'Spacebar' ? ' ' : key.length === 1 ? key.toLowerCase() : key;
  if (k === ' ' && mods.shift) return 'prev';
  return Object.hasOwn(KEY_ACTIONS, k) ? KEY_ACTIONS[k] : null;
}

/** Validates the data of a host `key` message ({key, shift?, ctrl?, meta?, alt?}); returns it normalised or null. */
export function normaliseHostKey(data) {
  if (!data || typeof data !== 'object' || typeof data.key !== 'string') return null;
  if (data.key.length === 0 || data.key.length > KEY_MAX_LENGTH) return null;
  return { key: data.key, shift: data.shift === true, ctrl: data.ctrl === true, meta: data.meta === true, alt: data.alt === true };
}

export function swipeAction(dx, dy) {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (ax >= SWIPE_MIN_PX && ax > ay * SWIPE_DOMINANCE) return dx < 0 ? 'next' : 'prev';
  if (ay >= SWIPE_MIN_PX && ay > ax * SWIPE_DOMINANCE) return dy < 0 ? 'next' : 'prev';
  return null;
}

export const clickAction = (x, width) => (width > 0 && x < width * CLICK_PREV_ZONE ? 'prev' : 'next');

/** Elements whose own clicks/drags/keys must never turn a page (controls, canvases, house widgets). */
export const INTERACTIVE_SELECTOR =
  'a,button,input,select,textarea,label,summary,canvas,video,audio,iframe,[contenteditable],[data-no-nav],p-3d,p-compare,p-audio,p-chart';

// ---- scaling, transitions, titles, report ------------------------------------------------------------------------

export const scaleToFit = (vw, vh) => Math.max(MIN_SCALE, Math.min(vw / SLIDE_WIDTH, vh / SLIDE_HEIGHT));

/** `data-transition` value -> one of TRANSITIONS. Accepts reveal's "fade-in slide-out" style (first word, suffix dropped). */
export function normaliseTransition(value, fallback = DEFAULT_TRANSITION) {
  const word = String(value ?? '').trim().toLowerCase().split(/\s+/)[0]?.replace(/-(in|out)$/, '');
  return TRANSITIONS.includes(word) ? word : fallback;
}

const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

export const slideTitle = (dataTitle, headingText, index) =>
  clip((dataTitle || headingText || '').replace(/\s+/g, ' ').trim() || `Slide ${index + 1}`, REPORT_TITLE_MAX);

/** The `panel-deck` message sent to the host on every change. */
export function deckReport(pos, count, title, notes) {
  return { type: 'panel-deck', h: pos.h, v: pos.v, f: pos.f, count, title: clip(title, REPORT_TITLE_MAX), notes: clip(notes, REPORT_NOTES_MAX) };
}

// ---- overview grid -----------------------------------------------------------------------------------------------

/** Picks the column count that gives the biggest thumbnails; scrolls when they would get too small. */
export function overviewLayout(count, vw, vh) {
  let best = null;
  for (let cols = 1; cols <= Math.max(1, count); cols++) {
    const rows = Math.ceil(count / cols);
    const scale = Math.min(
      (vw - OVERVIEW_PAD * 2 - OVERVIEW_GAP * (cols - 1)) / (cols * SLIDE_WIDTH),
      (vh - OVERVIEW_PAD * 2 - OVERVIEW_GAP * (rows - 1)) / (rows * SLIDE_HEIGHT),
    );
    if (!best || scale > best.scale) best = { cols, rows, scale };
  }
  if (best.scale < OVERVIEW_MIN_SCALE) {
    const cols = Math.max(1, Math.floor((vw - OVERVIEW_PAD * 2 + OVERVIEW_GAP) / (SLIDE_WIDTH * OVERVIEW_MIN_SCALE + OVERVIEW_GAP)));
    best = { cols, rows: Math.ceil(count / cols), scale: OVERVIEW_MIN_SCALE };
  }
  const cellW = SLIDE_WIDTH * best.scale;
  const cellH = SLIDE_HEIGHT * best.scale;
  const used = best.cols * cellW + (best.cols - 1) * OVERVIEW_GAP;
  const left = Math.max(OVERVIEW_PAD, (vw - used) / 2);
  const cells = Array.from({ length: count }, (_, i) => ({
    x: left + (i % best.cols) * (cellW + OVERVIEW_GAP),
    y: OVERVIEW_PAD + Math.floor(i / best.cols) * (cellH + OVERVIEW_GAP),
  }));
  return { ...best, cells };
}
