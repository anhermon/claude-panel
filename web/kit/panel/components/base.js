// base.js - shared base class of the house elements. Lifecycle: on connect it captures what was written inside the tag,
// shows a skeleton, awaits setup() (which lazy-imports its library) and swaps the skeleton for the result; a failure
// becomes an inline error message, never an exception. Everything a subclass registers with own() is undone on disconnect.
import panel from '../panel.mjs';

export const STALE = Symbol('stale'); // thrown by until() when the element was disconnected/restarted while awaiting
const SLIDE_EVENT = 'panel-slide'; // dispatched by deck.js on a slide section when it becomes/stops being current

export const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
export const cssVar = (name, fallback = '') => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

// The host tells every scene when its frame is hidden (tab switch, drawer cover ...): {visible:boolean}.
let hostVisible = true;
const hostListeners = new Set();
panel.on('visible', (data) => {
  hostVisible = !(data && data.visible === false);
  hostListeners.forEach((fn) => fn());
});

const stylesheets = new Map();
/** Adds <link rel=stylesheet> once and resolves when it loaded (or failed - the caller carries on unstyled). */
export function ensureStylesheet(href) {
  if (!stylesheets.has(href)) {
    stylesheets.set(href, new Promise((resolve) => {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = href;
      link.onload = link.onerror = () => resolve();
      document.head.append(link);
    }));
  }
  return stylesheets.get(href);
}

/** Resolves a scene-relative file name ("data.json", "model.glb") against the document. */
export const sceneUrl = (name) => new URL(name, document.baseURI).href;

export async function fetchSceneFile(name, as = 'text') {
  const res = await fetch(sceneUrl(name));
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  return as === 'json' ? res.json() : as === 'buffer' ? res.arrayBuffer() : res.text();
}

export class PanelElement extends HTMLElement {
  /** Subclasses set this to the attribute names whose change should rebuild the element. */
  static observedAttributes = [];

  #cleanups = [];
  #run = null;

  connectedCallback() {
    if (document.readyState === 'loading') { // children may not be parsed yet: wait, then capture them
      document.addEventListener('DOMContentLoaded', () => { if (this.isConnected) this.connectedCallback(); }, { once: true });
      return;
    }
    this.source ??= this.textContent; // text written inside the tag (p-code, p-md, p-math)
    this.kids ??= [...this.children]; // elements written inside the tag (p-timeline, p-diagram)
    const run = (this.#run = {});
    this.classList.add('p-loading');
    this.replaceChildren(Object.assign(document.createElement('span'), { className: 'p-skel' }));
    this.querySelector(':scope > .p-skel').setAttribute('aria-hidden', 'true');
    Promise.resolve()
      .then(() => this.setup())
      .then(() => { if (run === this.#run) { this.querySelector(':scope > .p-skel')?.remove(); this.classList.remove('p-loading'); } })
      .catch((err) => { if (err !== STALE && run === this.#run) this.fail(err); });
  }

  disconnectedCallback() {
    this.#run = null;
    this.#cleanups.splice(0).reverse().forEach((fn) => { try { fn(); } catch (err) { console.error(err); } });
  }

  attributeChangedCallback(name, before, after) {
    if (this.#run && before !== after) this.restart();
  }

  /** Tears down and rebuilds (attribute or theme change). */
  restart() {
    this.disconnectedCallback();
    this.connectedCallback();
  }

  /** Subclass hook: build the element's content (append to `this`). May be async. */
  async setup() {}

  /** Registers a cleanup to run on disconnect/restart. */
  own(fn) { this.#cleanups.push(fn); return fn; }

  /** Awaits a promise; if the element went away meanwhile, aborts the setup quietly. */
  async until(promise) {
    const run = this.#run;
    const value = await promise;
    if (!run || run !== this.#run || !this.isConnected) throw STALE;
    return value;
  }

  fail(err) {
    console.error(`<${this.localName}>`, err);
    this.classList.remove('p-loading');
    this.replaceChildren(Object.assign(document.createElement('div'), { className: 'p-error', textContent: `<${this.localName}> could not render: ${err?.message ?? err}` }));
    this.lastElementChild.setAttribute('role', 'alert');
  }

  /** Calls cb(true|false) whenever the element becomes visible+current / stops being so (in view, slide current, tab and frame shown). */
  watchActive(cb) {
    let inView = false;
    let last = null;
    const slide = this.closest('section'); // the deck's slide (its `slide` class may not be there yet: the deck starts after the components connect)
    const check = () => {
      const active = inView && !document.hidden && hostVisible && !this.closest('[inert]');
      if (active !== last) { last = active; cb(active); }
    };
    const io = new IntersectionObserver((entries) => { inView = entries.at(-1).isIntersecting; check(); });
    io.observe(this);
    slide?.addEventListener(SLIDE_EVENT, check);
    document.addEventListener('visibilitychange', check);
    hostListeners.add(check);
    this.own(() => {
      io.disconnect();
      slide?.removeEventListener(SLIDE_EVENT, check);
      document.removeEventListener('visibilitychange', check);
      hostListeners.delete(check);
    });
  }

  /** Calls cb when the colour scheme changes (OS setting or a host {dark} message). */
  watchTheme(cb) {
    const mq = matchMedia('(prefers-color-scheme: dark)');
    const mo = new MutationObserver(cb);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    mq.addEventListener('change', cb);
    this.own(() => { mo.disconnect(); mq.removeEventListener('change', cb); });
  }

  /** ResizeObserver that is torn down with the element. */
  watchSize(cb) {
    const ro = new ResizeObserver(cb);
    ro.observe(this);
    this.own(() => ro.disconnect());
  }
}

export const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
};
