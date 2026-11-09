// Pure logic of the diagram engine (no DOM, no Mermaid): highlight maps, element-id parsing, the theme, the view
// transform (fit / zoom / pan). Tested by diagram-logic.test.mjs; diagram.js is the thin DOM side.

export const HIGHLIGHT_STATES = Object.freeze(['active', 'done', 'blocked', 'todo']);
export const HIGHLIGHT_MAX = 24;
/** A Mermaid node id as an author writes it (letters, digits, `_`, `-`). */
export const NODE_ID_RE = /^[A-Za-z0-9_-]{1,40}$/;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Any value -> `{ id: state }` of the valid entries only (at most HIGHLIGHT_MAX); never throws. */
export function normalizeHighlight(raw) {
  if (!isObj(raw)) return {};
  const out = {};
  for (const [id, state] of Object.entries(raw)) {
    if (Object.keys(out).length >= HIGHLIGHT_MAX) break;
    if (NODE_ID_RE.test(id) && HIGHLIGHT_STATES.includes(state)) out[id] = state;
  }
  return out;
}

export const sameHighlight = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Mermaid's element ids, per diagram kind: [<svg id>-]flowchart-<id>-<n>, state-<id>-<n>, classId-<id>-<n>, entity-<id>-<n>.
const NODE_DOM_ID_RE = /(?:^|-)(?:flowchart|state|classId|entity|statediagram)-(.+?)-\d+$/; // Mermaid prefixes them with the svg's own id (`uml-svg-2-flowchart-build-0`)
/** The author's node id from a Mermaid element id (`flowchart-build-3` -> `build`), or null. */
export function nodeIdFromDomId(domId) {
  const m = NODE_DOM_ID_RE.exec(typeof domId === 'string' ? domId : '');
  return m && NODE_ID_RE.test(m[1]) ? m[1] : null;
}

/** Does the flowchart edge with this id (`L_a_b_0`) leave the node `id`? */
export const edgeLeaves = (edgeId, id) => typeof edgeId === 'string' && edgeId.startsWith(`L_${id}_`);

// ---- the theme ------------------------------------------------------------------------------------------------------
/** Token names read from the host element: [our key, the CSS variables to try in order]. The board names come first, then the scene kit's. */
export const TOKEN_VARS = Object.freeze({
  bg: ['--card', '--panel-surface'],
  fg: ['--fg', '--panel-fg'],
  mut: ['--mut', '--panel-muted'],
  line: ['--line-hi', '--panel-line'],
  acc: ['--acc', '--panel-accent'],
  ok: ['--ok', '--panel-ok'],
  warn: ['--warn', '--panel-warn'],
  danger: ['--danger', '--panel-danger'],
});
export const FALLBACK_TOKENS = Object.freeze({
  dark: { bg: '#13151c', fg: '#eceef3', mut: '#8b91a1', line: '#2c3350', acc: '#7c9cff', ok: '#4ade80', warn: '#fbbf24', danger: '#f87171' },
  light: { bg: '#ffffff', fg: '#1c1b1a', mut: '#6b6760', line: '#d6d2ca', acc: '#2f5bd0', ok: '#15803d', warn: '#b45309', danger: '#b91c1c' },
});
export const MERMAID_FONT_PX = 18;
/** Tighter than Mermaid's defaults: in a small tile the same diagram then shows its text bigger. */
export const COMPACT_CONFIG = Object.freeze({
  flowchart: { htmlLabels: false, nodeSpacing: 32, rankSpacing: 40, padding: 8, diagramPadding: 4 },
  sequence: { actorMargin: 36, width: 130, boxMargin: 6, messageMargin: 28, diagramMarginX: 6, diagramMarginY: 6 },
  state: { nodeSpacing: 32, rankSpacing: 40 },
  class: { nodeSpacing: 32, rankSpacing: 40 },
});
export const FONT_FAMILY = 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

/** Tokens for the scheme: `read(name)` gives a CSS variable's color (hex) or ''; a missing one falls back to the scheme's own. */
export function resolveTokens(read, scheme) {
  const base = FALLBACK_TOKENS[scheme === 'light' ? 'light' : 'dark'];
  return Object.fromEntries(Object.entries(TOKEN_VARS).map(([key, names]) => [key, names.map(read).find((v) => v) || base[key]]));
}

/** Mermaid `themeVariables` (base theme) from the tokens: the diagram reads as part of the page, not as a white sheet. */
export function mermaidTheme(t) {
  return {
    darkMode: true,
    background: t.bg, fontFamily: FONT_FAMILY, fontSize: `${MERMAID_FONT_PX}px`,
    primaryColor: t.bg, primaryTextColor: t.fg, primaryBorderColor: t.acc,
    secondaryColor: t.bg, secondaryTextColor: t.fg, secondaryBorderColor: t.line,
    tertiaryColor: t.bg, tertiaryTextColor: t.fg, tertiaryBorderColor: t.line,
    lineColor: t.mut, textColor: t.fg, mainBkg: t.bg, nodeBorder: t.acc, nodeTextColor: t.fg,
    clusterBkg: 'transparent', clusterBorder: t.line, edgeLabelBackground: t.bg, titleColor: t.fg,
    noteBkgColor: t.bg, noteTextColor: t.fg, noteBorderColor: t.warn,
    actorBkg: t.bg, actorBorder: t.acc, actorTextColor: t.fg, actorLineColor: t.line, signalColor: t.mut, signalTextColor: t.fg,
    labelBoxBkgColor: t.bg, labelBoxBorderColor: t.line, labelTextColor: t.fg, loopTextColor: t.mut,
    activationBkgColor: t.line, activationBorderColor: t.acc, sequenceNumberColor: t.bg,
    errorBkgColor: t.danger, errorTextColor: t.fg,
    // mindmap / timeline / gantt colour sections from these; kept to the panel's palette
    cScale0: t.acc, cScale1: t.ok, cScale2: t.warn, cScale3: t.danger, cScale4: t.mut,
    taskBkgColor: t.acc, taskTextColor: t.fg, taskTextOutsideColor: t.fg, activeTaskBkgColor: t.ok, doneTaskBkgColor: t.line,
    critBkgColor: t.danger, gridColor: t.line, sectionBkgColor: t.bg, altSectionBkgColor: t.bg, todayLineColor: t.warn,
    attributeBackgroundColorOdd: t.bg, attributeBackgroundColorEven: t.bg,
    stateBkg: t.bg, altBackground: t.bg, compositeBackground: t.bg, compositeBorder: t.line,
  };
}

// ---- the view transform: scale k, translation (x, y) of the content inside the viewport -----------------------------------
export const VIEW = Object.freeze({
  /** Never zoom out below this much of the diagram's natural size when fitting: text stays near 11 px; a diagram that needs less is cropped and pans (11 / MERMAID_FONT_PX). */
  READABLE_MIN: 11 / MERMAID_FONT_PX,
  FIT_MAX: 1.6,
  ZOOM_MIN: 0.2,
  ZOOM_MAX: 6,
  ZOOM_STEP: 1.0015,
  PAD: 8,
  /** A press that moves less than this many px is a click, not a drag. */
  CLICK_SLOP: 4,
});

/**
 * Where to put content of size (w, h) in a viewport (vw, vh): the largest scale at which all of it fits (at most `max`),
 * but not below `min`; centred when it fits, else anchored at the top-left so the start of the diagram is what shows.
 */
export function fitView({ vw, vh, w, h }, { min = VIEW.READABLE_MIN, max = VIEW.FIT_MAX, pad = VIEW.PAD } = {}) {
  if (!(w > 0 && h > 0 && vw > 0 && vh > 0)) return { k: 1, x: 0, y: 0 };
  const k = Math.max(min, Math.min(max, (vw - 2 * pad) / w, (vh - 2 * pad) / h));
  const place = (v, c) => (c * k + 2 * pad <= v ? (v - c * k) / 2 : pad);
  return { k, x: place(vw, w), y: place(vh, h) };
}

/** Zoom by `factor` around the viewport point (px, py): that point stays under the pointer. */
export function zoomAt(view, px, py, factor, { min = VIEW.ZOOM_MIN, max = VIEW.ZOOM_MAX } = {}) {
  const k = Math.min(max, Math.max(min, view.k * factor));
  const r = k / view.k;
  return { k, x: px - (px - view.x) * r, y: py - (py - view.y) * r };
}

/** The factor for a wheel event's deltaY (smooth for trackpads, bounded for mouse wheels). */
export const wheelFactor = (deltaY) => VIEW.ZOOM_STEP ** -Math.max(-120, Math.min(120, deltaY));

/** A drag of (dx, dy) px; was it more than a click? */
export const isDrag = (dx, dy) => Math.hypot(dx, dy) > VIEW.CLICK_SLOP;

// ---- sequence diagrams in a narrow tile ----------------------------------------------------------------------------------
/** Geometry floor of a squeezed sequence diagram: an actor box never narrower than WIDTH_MIN, the gap between boxes never than MARGIN_MIN
 * (px at Mermaid's own font size); WIDTH_SHARE is the part of one actor's column that is box (the rest is gap). */
export const SEQUENCE = Object.freeze({ WIDTH_MIN: 72, MARGIN_MIN: 18, WIDTH_SHARE: 0.78 });
const ACTOR_DECL_RE = /^\s*(?:participant|actor)\s+(\S+)/gim;
const ARROW_RE = /^\s*(\w+)\s*(?:--?>>|--?>|--?x|--?\)|-?\))\s*[+-]?(\w+)\s*:/gim;

/** The participants of a Mermaid sequence diagram's text (declared ones, plus any that only appear in a message); 0 for any other diagram. */
export function sequenceActors(code) {
  const text = typeof code === 'string' ? code : '';
  if (!/^\s*sequenceDiagram\b/m.test(text)) return 0;
  const ids = new Set();
  for (const m of text.matchAll(ACTOR_DECL_RE)) ids.add(m[1]);
  for (const m of text.matchAll(ARROW_RE)) { ids.add(m[1]); ids.add(m[2]); }
  return ids.size;
}

/**
 * Mermaid `sequence` settings that let the diagram be as wide as the viewport shows legibly (at the fit floor, VIEW.READABLE_MIN):
 * narrower actor boxes and gaps, wrapped text instead of one long line, and the actor row drawn once (not again at the bottom: that height goes to the drawing). `{}` when the compact defaults already fit, for any other
 * diagram kind, or while the viewport has no width yet. Pure: the same code and width always give the same answer.
 */
export function sequenceGeometry(code, viewportW) {
  const n = sequenceActors(code);
  if (n === 0 || !(viewportW > 0)) return {};
  const column = (viewportW - 2 * VIEW.PAD) / VIEW.READABLE_MIN / n; // natural px one actor may take
  if (column >= COMPACT_CONFIG.sequence.width + COMPACT_CONFIG.sequence.actorMargin) return {};
  const width = Math.max(SEQUENCE.WIDTH_MIN, Math.round(column * SEQUENCE.WIDTH_SHARE));
  return { width, actorMargin: Math.max(SEQUENCE.MARGIN_MIN, Math.round(column - width)), wrap: true, mirrorActors: false };
}

/** Which axes of the fitted drawing run past the viewport: '' (all visible), 'x', 'y' or 'xy' (then the person has to pan). */
export function croppedAxes({ vw, vh, w, h }, view, pad = VIEW.PAD) {
  const x = w * view.k + 2 * pad > vw + 1;
  const y = h * view.k + 2 * pad > vh + 1;
  return `${x ? 'x' : ''}${y ? 'y' : ''}`;
}
