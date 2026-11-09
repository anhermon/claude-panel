// renderDiagram(el, { code, highlight?, theme?, animate?, wheel?, minScale?, emit? }) draws Mermaid text (sequence, flowchart, state,
// class, ER, C4, mindmap, timeline, gantt, ...) into `el`, themed to the host's tokens, with wheel/drag zoom-pan, a fit button, click
// -> emit('diagram', { id }) and a motion that explains state only: `highlight` {nodeId: 'active'|'done'|'blocked'|'todo'} colours
// nodes; an `active` node pulses and the edges leaving it flow. Returns { update(code, highlight), fit(), destroy() }.
// update() renders offscreen and swaps the finished SVG in, keeping zoom/pan; invalid Mermaid keeps the last good render and
// shows its error text in the corner. Mermaid (kit lib `mermaid`) is loaded on first use; the pure parts are in diagram-logic.mjs.
import { COMPACT_CONFIG, croppedAxes, edgeLeaves, fitView, isDrag, mermaidTheme, nodeIdFromDomId, normalizeHighlight, resolveTokens, sameHighlight, sequenceGeometry, wheelFactor, zoomAt } from './diagram-logic.mjs';
import { STYLE_ID, UML_CSS } from './diagram-style.mjs';

const EMIT_NAME = 'diagram';
const WHEEL_ALWAYS = 'always';
const ERROR_CHARS = 200;
const RENDER_ID_PREFIX = 'uml-svg-';
const SVG_NS = 'http://www.w3.org/2000/svg';
const FIT_ICON = 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5';
const FIT_LABEL = 'Fit to view';
const ACTOR = 'rect.actor[name]';
const EDGE_SELECTOR = 'path[data-id^="L_"]';
const COLOR_PROBE = '#000';
const PAN_CUE = 'Drag to see the rest';

let mermaidReady = null;
let renderLock = Promise.resolve();
let uid = 0;
const loadMermaid = () => (mermaidReady ??= import('mermaid').then((m) => m.default).catch((err) => { mermaidReady = null; throw err; }));

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = UML_CSS;
  document.head.append(style);
}

/** A CSS variable of `el` as a canvas-normalised colour ('' when unset or not a colour). */
function colorProbe() {
  const ctx = document.createElement('canvas').getContext('2d');
  return (el, name) => {
    const raw = getComputedStyle(el).getPropertyValue(name).trim();
    if (!raw) return '';
    ctx.fillStyle = COLOR_PROBE;
    ctx.fillStyle = raw;
    return ctx.fillStyle;
  };
}

/** The element a click landed on -> the author's node id (flowchart/state/class/ER element ids, sequence actor names), or null. */
function idAt(target, root) {
  for (let n = target; n && n !== root; n = n.parentNode) {
    if (n.nodeType !== 1) continue;
    const byDom = nodeIdFromDomId(n.id);
    if (byDom) return byDom;
    if (n.matches(ACTOR)) return n.getAttribute('name');
    const actor = n.tagName === 'g' ? n.querySelector(`:scope > ${ACTOR}`) : null;
    if (actor) return actor.getAttribute('name');
  }
  return null;
}

export function renderDiagram(el, opts = {}) {
  ensureStyle();
  const root = document.createElement('div');
  root.className = 'uml';
  const pan = document.createElement('div');
  pan.className = 'uml-pan';
  const err = document.createElement('p');
  err.className = 'uml-err';
  err.hidden = true;
  err.setAttribute('role', 'status');
  const fitBtn = document.createElement('button');
  fitBtn.type = 'button';
  fitBtn.className = 'uml-fit';
  fitBtn.title = FIT_LABEL;
  fitBtn.setAttribute('aria-label', FIT_LABEL);
  const icon = document.createElementNS(SVG_NS, 'svg');
  icon.setAttribute('viewBox', '0 0 24 24');
  const iconPath = document.createElementNS(SVG_NS, 'path');
  iconPath.setAttribute('d', FIT_ICON);
  icon.append(iconPath);
  fitBtn.append(icon);
  const cue = document.createElement('p'); // shown while the fitted drawing is wider / taller than the tile (it is then cut at the edge: pan to see it)
  cue.className = 'uml-cue';
  cue.hidden = true;
  cue.textContent = PAN_CUE;
  root.append(pan, fitBtn, cue, err);
  el.append(root);

  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const dark = matchMedia('(prefers-color-scheme: dark)');
  const emit = opts.emit ?? ((name, data) => globalThis.panel?.emit?.(name, data));
  const wheelAlways = opts.wheel === WHEEL_ALWAYS;
  const fitOpts = opts.minScale === undefined ? {} : { min: opts.minScale };
  let code = '';
  let highlight = {};
  let view = { k: 1, x: 0, y: 0 };
  let size = { w: 0, h: 0 };
  let moved = false; // the person zoomed or panned: a resize or a new render keeps the view
  let dead = false;
  let drawn = false;
  let index = { nodes: new Map(), edges: [] };
  let themeKey = '';
  let geometryKey = '{}'; // the sequence geometry the drawing was made with: another tile width may need another drawing

  const scheme = () => (opts.theme === 'light' || opts.theme === 'dark' ? opts.theme : dark.matches ? 'dark' : 'light');
  const applyView = () => {
    pan.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.k})`;
    const cut = croppedAxes({ vw: root.clientWidth, vh: root.clientHeight, w: size.w, h: size.h }, view);
    root.dataset.crop = moved ? '' : cut; // the fade and the hint are for the first look; once the person pans they know
    cue.hidden = cut === '' || moved;
  };
  const fit = () => {
    moved = false;
    view = fitView({ vw: root.clientWidth, vh: root.clientHeight, w: size.w, h: size.h }, fitOpts);
    applyView();
  };

  function tokens() {
    const probe = colorProbe();
    const t = resolveTokens((name) => probe(el, name), scheme());
    const vars = { fg: t.fg, mut: t.mut, line: t.line, bg: t.bg, danger: t.danger, active: t.acc, done: t.ok, blocked: t.danger, todo: t.mut };
    for (const [k, v] of Object.entries(vars)) root.style.setProperty(`--uml-${k}`, v);
    root.dataset.animate = opts.animate !== false && !reduced.matches ? 'on' : 'off';
    return t;
  }

  function buildIndex(svg) {
    const nodes = new Map();
    const add = (id, target) => { if (id) nodes.set(id, [...(nodes.get(id) ?? []), target]); };
    for (const n of svg.querySelectorAll('[id]')) if (n.tagName === 'g') add(nodeIdFromDomId(n.id), n);
    for (const r of svg.querySelectorAll(ACTOR)) add(r.getAttribute('name'), r);
    index = { nodes, edges: [...svg.querySelectorAll(EDGE_SELECTOR)] };
  }

  function applyHighlight() {
    for (const n of pan.querySelectorAll('[data-hl], [data-flow]')) { delete n.dataset.hl; delete n.dataset.flow; }
    for (const [id, state] of Object.entries(highlight)) {
      for (const n of index.nodes.get(id) ?? []) n.dataset.hl = state;
      if (state !== 'active') continue;
      for (const edge of index.edges) if (edgeLeaves(edge.dataset.id, id)) edge.dataset.flow = 'on';
    }
  }

  function showError(message) {
    const full = String(message ?? 'Mermaid could not draw this');
    err.textContent = full.split('\n').find((l) => l.trim())?.slice(0, ERROR_CHARS) ?? '';
    err.title = full; // the whole message on hover
    err.hidden = false;
  }

  async function draw(text) {
    const mermaid = await loadMermaid();
    const t = tokens();
    const geometry = sequenceGeometry(text, root.clientWidth); // a sequence diagram squeezed to what the tile shows legibly ({} for the rest)
    mermaid.initialize({
      startOnLoad: false, securityLevel: 'strict', theme: 'base', themeVariables: mermaidTheme(t), logLevel: 'fatal',
      suppressErrorRendering: true, htmlLabels: false, ...COMPACT_CONFIG, sequence: { ...COMPACT_CONFIG.sequence, ...geometry }, fontFamily: mermaidTheme(t).fontFamily,
    });
    geometryKey = JSON.stringify(geometry);
    const id = `${RENDER_ID_PREFIX}${++uid}`;
    try {
      const { svg } = await mermaid.render(id, text);
      if (dead) return;
      const holder = document.createElement('div');
      holder.innerHTML = svg;
      const node = holder.querySelector('svg');
      if (!node) throw new Error('Mermaid returned no drawing');
      const box = node.viewBox.baseVal;
      size = { w: box.width || parseFloat(node.getAttribute('width')) || 0, h: box.height || parseFloat(node.getAttribute('height')) || 0 };
      node.setAttribute('width', size.w);
      node.setAttribute('height', size.h);
      node.style.removeProperty('max-width');
      pan.replaceChildren(node);
      buildIndex(node);
      applyHighlight();
      code = text;
      themeKey = `${scheme()}|${JSON.stringify(t)}`;
      err.hidden = true;
      if (!moved || !drawn) fit();
      drawn = true;
    } catch (e) { // a failed render can leave its scratch element in <body>; on success the id belongs to the live svg (its CSS is scoped by it)
      document.getElementById(`d${id}`)?.remove();
      throw e;
    }
  }

  const schedule = (text) => {
    renderLock = renderLock.then(() => (dead ? undefined : draw(text))).catch((e) => { if (!dead) showError(e?.message); });
    return renderLock;
  };

  function update(nextCode, nextHighlight) {
    highlight = normalizeHighlight(nextHighlight);
    if (typeof nextCode === 'string' && nextCode !== code) return schedule(nextCode);
    if (drawn) applyHighlight();
    return renderLock;
  }

  // ---- interaction ----------------------------------------------------------------------------------------------
  let press = null;
  root.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'touch' || e.button !== 0 || e.target.closest('.uml-fit')) return;
    press = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, target: e.target, dragged: false };
    root.setPointerCapture?.(e.pointerId);
  });
  root.addEventListener('pointermove', (e) => {
    if (!press) return;
    const dx = e.clientX - press.x;
    const dy = e.clientY - press.y;
    if (!press.dragged && !isDrag(dx, dy)) return;
    press.dragged = true;
    moved = true;
    root.classList.add('dragging');
    view = { ...view, x: press.vx + dx, y: press.vy + dy };
    applyView();
  });
  const release = (e) => {
    if (!press) return;
    const { dragged, target } = press;
    press = null;
    root.classList.remove('dragging');
    root.releasePointerCapture?.(e.pointerId);
    const id = dragged ? null : idAt(target, root);
    if (id) emit(EMIT_NAME, { id });
  };
  root.addEventListener('pointerup', release);
  root.addEventListener('pointercancel', () => { press = null; root.classList.remove('dragging'); });
  root.addEventListener('wheel', (e) => {
    if (!wheelAlways && !e.ctrlKey && !e.metaKey) return; // a plain wheel scrolls the board
    e.preventDefault();
    const r = root.getBoundingClientRect();
    moved = true;
    view = zoomAt(view, e.clientX - r.left, e.clientY - r.top, wheelFactor(e.deltaY));
    applyView();
  }, { passive: false });
  root.addEventListener('dblclick', fit);
  fitBtn.addEventListener('click', fit);

  const ro = new ResizeObserver(() => {
    if (!drawn) return;
    if (code !== '' && JSON.stringify(sequenceGeometry(code, root.clientWidth)) !== geometryKey) { const c = code; code = ''; update(c, highlight); return; } // redrawn, then fitted
    if (!moved) fit(); else applyView();
  });
  ro.observe(root);
  const onScheme = () => { if (code && themeKey !== '') { const c = code; code = ''; update(c, highlight); } };
  dark.addEventListener?.('change', onScheme);

  update(opts.code, opts.highlight);
  return {
    update,
    fit,
    destroy() {
      dead = true;
      ro.disconnect();
      dark.removeEventListener?.('change', onScheme);
      root.remove();
    },
  };
}
