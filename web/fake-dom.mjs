// Just enough DOM to run the browser scripts (blocks.js, scenes.js, events-client.js, stage.js, rail.js, ui.js) under node:vm.
// Not a spec-compliant DOM: it implements what those scripts use, and records iframe navigations, focus calls, and
// messages posted to frame windows.
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HERE } from './testkit.mjs';

/** Calls every listener with one event object (preventDefault is recorded); returns the event. */
function fire(listeners, type, ev) {
  const e = { type, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...ev };
  [...listeners].forEach((fn) => fn(e));
  return e;
}

class FakeNode {
  constructor(tag, doc) {
    this.tagName = String(tag).toUpperCase();
    this.ownerDocument = doc;
    this.children = [];
    this.parentNode = null;
    this.attrs = {};
    this.dataset = {};
    this.listeners = {};
    this.hidden = false;
    this._text = '';
    this._classes = new Set();
    this.style = { setProperty: (k, v) => { this.style[k] = v; } };
    this.srcLog = [];
    this.classList = {
      add: (...c) => c.forEach((x) => this._classes.add(x)),
      remove: (...c) => c.forEach((x) => this._classes.delete(x)),
      contains: (c) => this._classes.has(c),
      toggle: (c, force) => {
        const on = force === undefined ? !this._classes.has(c) : !!force;
        if (on) this._classes.add(c); else this._classes.delete(c);
        return on;
      },
    };
    this.insertLog = [];
    this.focusLog = 0;
    this.isContentEditable = false;
  }
  get className() { return [...this._classes].join(' '); }
  set className(v) { this._classes = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get src() { return this._src; }
  set src(v) { this._src = v; this.srcLog.push(v); }
  /** A frame's window: records what the page posts to it and focus() calls. */
  get contentWindow() {
    return (this._win ??= { frame: this, posted: [], focusLog: 0, focus() { this.focusLog++; }, postMessage(msg, origin) { this.posted.push({ msg, origin }); } });
  }
  get textContent() { return this.children.length ? this.children.map((c) => c.textContent).join('') : this._text; }
  set textContent(v) { this.children.forEach((c) => { c.parentNode = null; }); this.children = []; this._text = String(v); }
  get childNodes() { return this.children; }
  get firstChild() { return this.children[0] ?? null; }
  get lastChild() { return this.children.at(-1) ?? null; }
  get firstElementChild() { return this.children[0] ?? null; }
  get nextElementSibling() { const s = this.parentNode?.children; return s ? s[s.indexOf(this) + 1] ?? null : null; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  removeAttribute(k) { delete this.attrs[k]; }
  focus() { this.focusLog++; this.ownerDocument.activeElement = this; }
  blur() { if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = this.ownerDocument.body; }
  contains(n) { for (let x = n; x; x = x.parentNode) if (x === this) return true; return false; }
  getAttribute(k) { return this.attrs[k] ?? null; }
  hasAttribute(k) { return k in this.attrs; }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  dispatch(type, ev = {}) { return fire(this.listeners[type] ?? [], type, { target: this, ...ev }); }
  appendChild(c) { return this.insertBefore(c, null); }
  insertBefore(c, ref) {
    c.parentNode?.children.splice(c.parentNode.children.indexOf(c), 1);
    const i = ref ? this.children.indexOf(ref) : this.children.length;
    this.children.splice(i < 0 ? this.children.length : i, 0, c);
    c.parentNode = this;
    c.insertLog.push('inserted');
    return c;
  }
  replaceChildren(...nodes) { this.children.forEach((c) => { c.parentNode = null; }); this.children = []; nodes.forEach((n) => this.appendChild(n)); }
  remove() { this.parentNode?.children.splice(this.parentNode.children.indexOf(this), 1); this.parentNode = null; }
  *walk() { yield this; for (const c of this.children) yield* c.walk(); }
  find(pred) { for (const n of this.walk()) if (pred(n)) return n; return null; }
  findAll(pred) { return [...this.walk()].filter(pred); }
}

const VOID_TAGS = new Set(['meta', 'link', 'br', 'img', 'input', 'hr']);
const TAG_RE = /<(\/?)([a-z][a-z0-9]*)([^>]*)>/gi;
const UI_HTML = () => readFileSync(join(HERE, 'ui.html'), 'utf8');

/** Builds the <body> of ui.html as FakeNodes (tag, id, class, hidden, aria-*, tabindex, nesting), so tests see the real structure. */
function buildBody(doc) {
  const html = UI_HTML().replace(/<!--[\s\S]*?-->/g, '');
  const body = html.slice(html.indexOf('<body') + 5);
  const stack = [doc.body];
  for (const m of body.matchAll(TAG_RE)) {
    const [, closing, name, rest] = m;
    const tag = name.toLowerCase();
    if (closing) {
      if (tag !== 'body' && stack.length > 1) stack.pop();
      continue;
    }
    const node = doc.createElement(tag);
    for (const [, k, v] of rest.matchAll(/([a-z-]+)(?:="([^"]*)")?/g)) {
      if (k === 'id') { node.id = v; doc.byId.set(v, node); }
      else if (k === 'class') node.className = v;
      else if (k === 'hidden') node.hidden = true;
      else node.attrs[k] = v ?? '';
    }
    stack.at(-1).appendChild(node);
    if (!VOID_TAGS.has(tag) && !rest.trimEnd().endsWith('/')) stack.push(node);
  }
}

/** A document whose body is ui.html's markup; getElementById finds its elements. */
export function createDocument() {
  const doc = { fullscreenEnabled: true, fullscreenElement: null, byId: new Map(), listeners: {}, exitCalls: 0 };
  doc.createElement = (tag) => new FakeNode(tag, doc);
  doc.body = doc.createElement('body');
  doc.documentElement = doc.createElement('html');
  doc.activeElement = doc.body;
  doc.addEventListener = (type, fn) => { (doc.listeners[type] ??= []).push(fn); };
  /** Fires a document-level event (keydown, pointermove, fullscreenchange...). */
  doc.dispatch = (type, ev = {}) => fire(doc.listeners[type] ?? [], type, { target: doc.body, ...ev });
  doc.exitFullscreen = () => { doc.exitCalls++; doc.fullscreenElement = null; return Promise.resolve(); };
  doc.createElementNS = (_ns, tag) => new FakeNode(tag, doc);
  doc.getElementById = (id) => doc.byId.get(id) ?? null;
  doc.title = '';
  buildBody(doc);
  return doc;
}

/**
 * Runs the named browser scripts (in order) in one fresh global.
 * Returns { ctx, doc, messageHandlers, timers, windowEvent, post, fetchLog, fetchResult, setNarrow }:
 *  - windowEvent(type, ev) fires window listeners (hashchange, ...); post(ev) delivers a `message` event to all of them
 *  - fetchLog records every fetch(url, opts); set fetchResult to {ok:false} or an Error to make the next fetches fail
 *  - setNarrow(bool) flips the (max-width: 699px) media query and notifies its listeners
 */
export function loadBrowserScripts(files, { doc = createDocument() } = {}) {
  const timers = [];
  const messageHandlers = [];
  const windowListeners = {};
  const fetchLog = [];
  const env = { fetchResult: { ok: true, status: 200 } };
  const media = { matches: false, listeners: [] };
  const ctx = vm.createContext({
    document: doc, console, URL, Date, JSON, Math, Number, String, Array, Object, Set, Map, Promise, TextEncoder,
    setTimeout: (fn, ms) => { timers.push({ fn, ms, live: true }); return timers.length; },
    clearTimeout: (id) => { if (timers[id - 1]) timers[id - 1].live = false; },
    setInterval: () => 0,
    location: { hash: '' },
    matchMedia: () => ({ get matches() { return media.matches; }, addEventListener: (_t, fn) => media.listeners.push(fn) }),
    fetch: (url, opts) => {
      fetchLog.push({ url, opts, body: opts?.body ? JSON.parse(opts.body) : undefined });
      return env.fetchResult instanceof Error ? Promise.reject(env.fetchResult) : Promise.resolve(env.fetchResult);
    },
    window: {
      addEventListener: (type, fn) => {
        (windowListeners[type] ??= []).push(fn);
        if (type === 'message') messageHandlers.push(fn);
      },
    },
  });
  // `workspace/...` is served from builtin/workspace/ (server.mjs), exactly as ui.html names it
  for (const f of ['plain-title.js', ...files]) vm.runInContext(readFileSync(join(HERE, f.startsWith('workspace/') ? 'builtin' : '', f), 'utf8'), ctx, { filename: f });
  return {
    ctx, doc, messageHandlers, timers, fetchLog,
    get fetchResult() { return env.fetchResult; },
    set fetchResult(v) { env.fetchResult = v; },
    windowEvent: (type, ev = {}) => fire(windowListeners[type] ?? [], type, ev),
    post: (ev) => fire(windowListeners.message ?? [], 'message', ev),
    setNarrow: (on) => { media.matches = on; media.listeners.forEach((fn) => fn({ matches: on })); },
  };
}
