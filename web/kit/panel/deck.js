// deck.js - slide deck engine for scenes. A strict subset of reveal.js markup:
//   <main class="deck"> <section>slide</section> <section><section>vertical</section><section>stack</section></section> </main>
//   .fragment (+ data-fragment-index), <aside class="notes">, data-auto-animate + data-id, data-background-color|gradient|image,
//   data-transition="slide|fade|zoom|none", data-audio="narration.m4a", data-title.
// `import 'panel/deck'` starts the first <main class="deck"> by itself; `start(root)` does it by hand.
// Slides are a fixed 1280x720 canvas scaled to fit. See deck.css for the theme tokens and README.md for every attribute.
import panel from './panel.mjs';
import {
  SLIDE_WIDTH, SLIDE_HEIGHT, INTERACTIVE_SELECTOR, DEFAULT_TRANSITION,
  parseHash, formatHash, fragmentOrder, fragmentSteps, visibleFragments, clampPos, samePos, navigate, leaves,
  keyToAction, normaliseHostKey, swipeAction, clickAction, scaleToFit, normaliseTransition, slideTitle, deckReport, overviewLayout,
} from './deck-logic.js';

const STYLE_URL = new URL('./deck.css', import.meta.url).href;
const AUTO_ANIMATE_MS = 650;
const AUTO_ANIMATE_EASING = 'cubic-bezier(0.2, 0.7, 0.2, 1)';
const AUTO_ANIMATE_FADE_MS = 400;
const AUTO_ANIMATE_FADE_DELAY_MS = 120;
const NARRATION_HINT = { locked: '♪ Press any key to start narration', on: '♪ Narration (m to mute)', muted: '♪ Narration muted (m)' };
const HOST_EVENTS = { fullscreen: 'deck.fullscreen', drawer: 'deck.drawer' }; // handled by the host page, never forwarded to Claude
const SLIDE_EVENT = 'panel-slide'; // dispatched on a slide <section> when it becomes / stops being the current one

const instances = new WeakMap();
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const isEditable = (el) => !!el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable);

function loadStylesheet() {
  if (document.querySelector('link[href$="deck.css"]')) return Promise.resolve();
  return new Promise((resolve) => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = STYLE_URL;
    link.onload = link.onerror = () => resolve();
    document.head.append(link);
  });
}

function cleanNotes(el) {
  return [...el.querySelectorAll('aside.notes')]
    .map((aside) => aside.textContent.split('\n').map((line) => line.trim()).filter(Boolean).join('\n'))
    .join('\n');
}

class Deck {
  constructor(root) {
    this.root = root;
    this.defaultTransition = normaliseTransition(root.dataset.transition, DEFAULT_TRANSITION);
    this.stacks = [];
    this.slides = []; // flat, reading order
    this.pos = { h: 0, v: 0, f: 0 };
    this.overview = false;
    this.unlocked = false; // true after the first user gesture (browsers refuse audio before)
    this.muted = false;
    this.audio = null;
    this.aaTimer = 0;
    this.#build();
    this.#bind();
    this.#fit();
    this.go(parseHash(location.hash), { instant: true });
    root.classList.add('deck-ready');
  }

  // ---- structure ----
  #build() {
    this.backgrounds = Object.assign(document.createElement('div'), { className: 'deck-backgrounds' });
    this.live = Object.assign(document.createElement('div'), { className: 'deck-live' });
    this.live.setAttribute('aria-live', 'polite');
    this.hint = Object.assign(document.createElement('div'), { className: 'deck-hint', hidden: true });
    this.hint.setAttribute('role', 'status');
    document.body.prepend(this.backgrounds);
    document.body.append(this.live, this.hint);
    for (const section of [...this.root.children].filter((c) => c.tagName === 'SECTION')) {
      const inner = [...section.children].filter((c) => c.tagName === 'SECTION');
      if (inner.length) section.classList.add('stack');
      this.stacks.push((inner.length ? inner : [section]).map((el, v) => this.#makeSlide(el, this.stacks.length, v)));
    }
    this.model = this.stacks.map((stack) => stack.map((s) => s.steps.length));
    this.count = this.stacks.length;
    const total = this.slides.length;
    this.slides.forEach((s, i) => s.el.setAttribute('aria-label', `Slide ${i + 1} of ${total}: ${s.title}`));
  }

  #makeSlide(el, h, v) {
    const index = this.slides.length;
    const fragments = [...el.querySelectorAll('.fragment')];
    const order = fragmentOrder(fragments.map((f) => Number.parseInt(f.dataset.fragmentIndex, 10)));
    const d = el.dataset;
    const slide = {
      el, h, v, index, fragments, order, steps: fragmentSteps(order),
      title: slideTitle(d.title, el.querySelector('h1, h2, h3')?.textContent, index),
      notes: cleanNotes(el),
      transition: d.transition ? normaliseTransition(d.transition, this.defaultTransition) : null,
      audio: d.audio || '',
      autoAnimate: el.hasAttribute('data-auto-animate'),
      bg: this.#makeBackground(d),
    };
    el.classList.add('slide');
    el.setAttribute('role', 'region');
    el.setAttribute('aria-roledescription', 'slide');
    this.slides.push(slide);
    return slide;
  }

  #makeBackground(d) {
    const bg = Object.assign(document.createElement('div'), { className: 'deck-bg' });
    if (d.backgroundColor) bg.style.backgroundColor = d.backgroundColor;
    if (d.backgroundGradient) bg.style.backgroundImage = d.backgroundGradient;
    if (d.backgroundImage) bg.style.backgroundImage = `url(${JSON.stringify(d.backgroundImage)})`;
    if (d.backgroundSize) bg.style.backgroundSize = d.backgroundSize;
    if (d.backgroundPosition) bg.style.backgroundPosition = d.backgroundPosition;
    if (d.backgroundOpacity) bg.style.setProperty('--deck-bg-opacity', d.backgroundOpacity);
    this.backgrounds.append(bg);
    return bg;
  }

  slideAt(pos) { return this.stacks[pos.h][pos.v]; }

  // ---- input ----
  #bind() {
    const on = (target, type, fn, opts) => target.addEventListener(type, fn, opts);
    on(document, 'keydown', (e) => this.#onKey(e));
    on(document, 'click', (e) => this.#onClick(e));
    on(document, 'pointerdown', () => this.#unlock(), { capture: true });
    on(document, 'touchstart', (e) => this.#onTouchStart(e), { passive: true });
    on(document, 'touchend', (e) => this.#onTouchEnd(e), { passive: true });
    on(window, 'resize', () => this.#fit());
    on(window, 'hashchange', () => {
      const target = parseHash(location.hash);
      if (!samePos(clampPos(this.model, target), this.pos)) this.go(target);
    });
    panel.on('key', (data) => {
      const k = normaliseHostKey(data);
      if (!k) return;
      this.#unlock(); // a key the user pressed in the host page counts as a gesture (the frame has allow="autoplay")
      const action = keyToAction(k.key, k);
      if (action) this.act(action);
    });
    panel.on('visible', (data) => { if (data && data.visible === false) this.audio?.pause(); else if (this.unlocked) this.audio?.play().catch(() => {}); });
  }

  #onKey(e) {
    this.#unlock();
    if (e.defaultPrevented || isEditable(e.target)) return;
    if ((e.key === ' ' || e.key === 'Enter') && e.target.closest?.(INTERACTIVE_SELECTOR)) return; // Space/Enter belong to the control
    const slideEl = e.target.closest?.('section.slide');
    if (this.overview && e.key === 'Enter' && slideEl) this.#select(slideEl);
    const action = keyToAction(e.key, { shift: e.shiftKey, ctrl: e.ctrlKey, meta: e.metaKey, alt: e.altKey });
    if (!action) return; // includes Tab: never trapped
    e.preventDefault();
    this.act(action);
  }

  #onClick(e) {
    if (e.button !== 0 || e.defaultPrevented) return;
    if (this.overview) {
      const slideEl = e.target.closest?.('section.slide');
      if (slideEl) this.#select(slideEl);
      else this.toggleOverview(false);
      return;
    }
    if (e.target.closest?.(INTERACTIVE_SELECTOR) || getSelection()?.toString()) return;
    this.act(clickAction(e.clientX, innerWidth));
  }

  #onTouchStart(e) {
    const t = e.touches[0];
    this.touch = e.touches.length === 1 && !e.target.closest?.(INTERACTIVE_SELECTOR) ? { x: t.clientX, y: t.clientY } : null;
  }

  #onTouchEnd(e) {
    if (!this.touch) return;
    const t = e.changedTouches[0];
    const action = swipeAction(t.clientX - this.touch.x, t.clientY - this.touch.y);
    this.touch = null;
    if (action) this.act(action);
  }

  #select(slideEl) {
    const slide = this.slides.find((s) => s.el === slideEl);
    this.toggleOverview(false);
    if (slide) this.go({ h: slide.h, v: slide.v, f: 0 });
  }

  /** Runs a deck action: a navigation verb (next prev left right first last) or overview/fullscreen/drawer/mute/escape/enter. */
  act(action) {
    switch (action) {
      case 'overview': return this.toggleOverview();
      case 'fullscreen': return void panel.emit(HOST_EVENTS.fullscreen);
      case 'drawer': return void panel.emit(HOST_EVENTS.drawer);
      case 'mute': return this.#toggleMute();
      case 'escape':
      case 'enter': return void (this.overview && this.toggleOverview(false));
      default:
        if (this.overview) return this.#moveSelection(action);
        return this.go(navigate(this.model, this.pos, action));
    }
  }

  #moveSelection(action) {
    const flat = leaves(this.model);
    const at = flat.findIndex((l) => l.h === this.pos.h && l.v === this.pos.v);
    const to = { next: at + 1, right: at + 1, prev: at - 1, left: at - 1, first: 0, last: flat.length - 1 }[action] ?? at;
    const target = flat[Math.min(Math.max(to, 0), flat.length - 1)];
    this.go({ h: target.h, v: target.v, f: 0 });
  }

  // ---- layout ----
  #fit() {
    this.root.style.setProperty('--deck-scale', String(scaleToFit(innerWidth, innerHeight)));
    if (this.overview) this.#layoutOverview();
  }

  toggleOverview(on = !this.overview) {
    this.overview = on;
    this.root.classList.toggle('overview', on);
    if (on) this.#layoutOverview();
    else for (const s of this.slides) { s.el.style.removeProperty('--ov-x'); s.el.style.removeProperty('--ov-y'); s.el.style.removeProperty('--ov-s'); s.el.removeAttribute('tabindex'); }
    this.#applyStates();
    if (!on) this.#narrate(this.slideAt(this.pos));
    else this.#narrate(null);
  }

  #layoutOverview() {
    const layout = overviewLayout(this.slides.length, innerWidth, innerHeight);
    this.slides.forEach((s, i) => {
      s.el.style.setProperty('--ov-x', `${layout.cells[i].x}px`);
      s.el.style.setProperty('--ov-y', `${layout.cells[i].y}px`);
      s.el.style.setProperty('--ov-s', String(layout.scale));
      s.el.tabIndex = 0;
    });
  }

  // ---- navigation / rendering ----
  go(target, { instant = false } = {}) {
    const next = clampPos(this.model, target);
    if (this.rendered && samePos(next, this.pos)) return;
    const from = this.rendered ? this.slideAt(this.pos) : null;
    const to = this.slideAt(next);
    const changed = from !== to;
    const animate = changed && !instant && !this.overview && !reducedMotion() && from?.autoAnimate && to.autoAnimate && Math.abs(from.index - to.index) === 1;
    const before = animate ? this.#measure(from.el) : null;
    this.pos = next;
    this.rendered = true;
    clearTimeout(this.aaTimer);
    this.root.classList.toggle('deck-snap', instant || animate);
    this.root.classList.remove('aa-active');
    for (const s of this.slides) s.el.classList.remove('aa-out');
    if (changed) this.root.dataset.activeTransition = to.transition ?? this.defaultTransition;
    this.#applyStates();
    if (animate) {
      from.el.classList.add('aa-out');
      this.#autoAnimate(before, to);
    } else if (instant) {
      void this.root.offsetWidth; // commit the un-animated state, then re-enable transitions
      requestAnimationFrame(() => this.root.classList.remove('deck-snap'));
    }
    this.#sync(changed, to);
  }

  #applyStates() {
    const { h, v, f } = this.pos;
    for (const s of this.slides) {
      const state = s.h < h ? 'past' : s.h > h ? 'future' : s.v < v ? 'above' : s.v > v ? 'below' : 'present';
      const wasPresent = s.el.dataset.state === 'present';
      s.el.dataset.state = state;
      s.bg.classList.toggle('present', state === 'present');
      const hidden = state !== 'present' && !this.overview;
      s.el.inert = hidden;
      if (hidden) s.el.setAttribute('aria-hidden', 'true');
      else s.el.removeAttribute('aria-hidden');
      const shown = state === 'present' ? visibleFragments(s.order, f) : s.order.map(() => state === 'past' || state === 'above');
      s.fragments.forEach((el, i) => el.classList.toggle('visible', shown[i]));
      if (wasPresent !== (state === 'present')) s.el.dispatchEvent(new CustomEvent(SLIDE_EVENT, { detail: { present: state === 'present' } }));
    }
  }

  #sync(changed, slide) {
    try { history.replaceState(null, '', formatHash(this.pos)); } catch { /* opaque origins may refuse */ }
    if (changed) {
      this.live.textContent = `Slide ${slide.index + 1} of ${this.slides.length}: ${slide.title}`;
      if (!this.overview) this.#narrate(slide);
    }
    try { window.parent.postMessage(deckReport(this.pos, this.count, slide.title, slide.notes), '*'); } catch { /* no parent */ }
  }

  // ---- auto-animate: shared elements (same data-id on consecutive slides) tween from their old box to the new one ----
  #measure(slideEl) {
    const boxes = new Map();
    for (const el of slideEl.querySelectorAll('[data-id]')) {
      const cs = getComputedStyle(el);
      boxes.set(el.dataset.id, { rect: el.getBoundingClientRect(), color: cs.color, background: cs.backgroundColor });
    }
    return boxes;
  }

  #autoAnimate(before, to) {
    void this.root.offsetWidth; // settle the new slide at its final place (transitions are off via deck-snap)
    const scale = scaleToFit(innerWidth, innerHeight);
    const timing = { duration: AUTO_ANIMATE_MS, easing: AUTO_ANIMATE_EASING, fill: 'backwards' };
    const matched = new Set();
    for (const el of to.el.querySelectorAll('[data-id]')) {
      const old = before.get(el.dataset.id);
      if (!old) continue;
      matched.add(el);
      const now = el.getBoundingClientRect();
      const dx = (old.rect.left - now.left) / scale;
      const dy = (old.rect.top - now.top) / scale;
      const sx = now.width ? old.rect.width / now.width : 1;
      const sy = now.height ? old.rect.height / now.height : 1;
      el.style.transformOrigin = '0 0';
      el.animate(
        [{ transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`, color: old.color, backgroundColor: old.background }],
        timing,
      ).finished.then(() => el.style.removeProperty('transform-origin'), () => {});
    }
    for (const child of to.el.children) {
      if (child.classList.contains('notes') || matched.has(child) || [...matched].some((m) => child.contains(m))) continue;
      child.animate([{ opacity: 0 }], { duration: AUTO_ANIMATE_FADE_MS, delay: AUTO_ANIMATE_FADE_DELAY_MS, easing: 'ease-out', fill: 'backwards' });
    }
    this.aaTimer = setTimeout(() => {
      this.root.classList.remove('deck-snap');
      for (const s of this.slides) s.el.classList.remove('aa-out');
    }, AUTO_ANIMATE_MS);
  }

  // ---- narration (data-audio): plays when the slide is shown, but only after a user gesture ----
  #unlock() {
    if (this.unlocked) return;
    this.unlocked = true;
    if (this.audio?.paused) this.audio.play().catch(() => {});
    this.#updateHint();
  }

  #narrate(slide) {
    this.audio?.pause();
    this.audio = null;
    if (slide?.audio) {
      this.audio = new Audio();
      this.audio.crossOrigin = 'anonymous';
      this.audio.src = slide.audio;
      this.audio.muted = this.muted;
      if (this.unlocked) this.audio.play().catch(() => {}); // refused (autoplay policy): the hint says to press a key
    }
    this.#updateHint();
  }

  #toggleMute() {
    this.muted = !this.muted;
    if (this.audio) this.audio.muted = this.muted;
    this.#updateHint();
  }

  #updateHint() {
    this.hint.hidden = !this.audio;
    this.hint.textContent = !this.unlocked ? NARRATION_HINT.locked : this.muted ? NARRATION_HINT.muted : NARRATION_HINT.on;
  }
}

/** Starts the deck inside `root` (default: the first <main class="deck">). Resolves to the Deck, or null if there is none. */
export async function start(root = document.querySelector('main.deck')) {
  if (!root) return null;
  if (!instances.has(root)) {
    const ready = loadStylesheet().then(() => new Deck(root));
    instances.set(root, ready);
  }
  return instances.get(root);
}

export { SLIDE_WIDTH, SLIDE_HEIGHT };
export default { start };

const autostart = () => { start(); };
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', autostart, { once: true });
else autostart();
