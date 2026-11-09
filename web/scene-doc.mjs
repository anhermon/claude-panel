// Entry-document wrapping for scenes (pure functions, no I/O).
//
// A scene's entry file is either a FRAGMENT (no <html> tag: just markup, maybe a <style>/<script>) or a FULL
// document. Fragments are wrapped here with a base stylesheet (system font, theme tokens as CSS custom
// properties that follow prefers-color-scheme, transparent background). EVERY entry document (fragment or full)
// then gets the kit head injected as the first children of <head> (a <head> is created when a full document has
// none), in this order:
//   1. <script type="importmap">  kit specifiers -> absolute /<token>/kit/... URLs. If the document already has an
//      importmap script, the kit map is MERGED into that one instead (author keys win; `scopes`/`integrity` kept);
//      we never emit two maps. An author map that is not valid JSON is replaced (a browser ignores it anyway).
//   2. <link rel="stylesheet" href=".../kit/panel/panel.css">   unless <meta name="panel-css" content="off">
//   3. <script src=".../kit/panel/panel.js">                     classic script that defines window.panel
//   4. an inline fallback that defines window.panel = { fit } only when step 3 did not (kit file missing).
// Without a `kit` argument (standalone use, unit tests) only step 4 is injected.
//
// `panel.fit()` measures where the content ends and posts `{ type: 'panel-fit', height }` to the parent page
// (clamped to MAX_FIT_HEIGHT; the page clamps again). It measures content bounds instead of scrollHeight because
// html/body are 100% tall in fragments (so `height: 100%` canvases work) and scrollHeight could then only grow.

export const FIT_MESSAGE_TYPE = 'panel-fit';
export const MAX_FIT_HEIGHT = 1200;
export const KIT_PANEL_CSS = 'panel/panel.css';
export const KIT_PANEL_JS = 'panel/panel.js';
export const PANEL_CSS_META = 'panel-css';
const FULL_DOCUMENT_RE = /<html[\s>]/i;
const COMMENT_RE = /<!--[\s\S]*?-->/g;
const HEAD_OPEN_RE = /<head(?=[\s>/])[^>]*>/i;
const HTML_OPEN_RE = /<html(?=[\s>/])[^>]*>/i;
const META_RE = /<meta\b[^>]*>/gi;
// Groups: 1 = open tag, 2 = body, 3 = close tag. `type=importmap` quoted or bare, never `importmap-shim`.
const IMPORTMAP_RE = /(<script\b[^>]*?\btype\s*=\s*(?:"importmap"|'importmap'|importmap(?=[\s>]))[^>]*>)([\s\S]*?)(<\/script\s*>)/i;

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

// Theme tokens mirror ui.html's :root (same names for the ones scenes are likely to use).
const BASE_CSS = `
:root {
  color-scheme: light dark;
  --bg: transparent; --surface: #ffffff; --text: #1c1b1a; --muted: #6b6760;
  --border: #e4e1db; --accent: #2f5bd0; --accent-bg: #eaf0fc; --amber: #d97706;
  --green: #15803d; --red: #b91c1c; --code-bg: #f1efeb;
  --font: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
}
@media (prefers-color-scheme: dark) {
  :root {
    --surface: #1c1b1a; --text: #ecebe8; --muted: #a19d95; --border: #2f2d2a;
    --accent: #7aa2ff; --accent-bg: #172036; --amber: #fbbf24; --green: #4ade80; --red: #f87171; --code-bg: #121211;
  }
}
*, *::before, *::after { box-sizing: border-box; }
html, body { height: 100%; margin: 0; background: transparent; }
body { padding: 12px 14px; color: var(--text); font: 15px/1.5 var(--font); }
a { color: var(--accent); }
code, pre { font-family: var(--mono); }
pre { background: var(--code-bg); padding: 10px 12px; border-radius: 8px; overflow-x: auto; }
`;

// Only defines window.panel when the kit's panel.js did not (it runs just before this tag).
const FALLBACK_JS = `
(function () {
  var MAX = ${MAX_FIT_HEIGHT};
  function fit() {
    var body = document.body;
    var range = document.createRange();
    range.selectNodeContents(body);
    var bottom = range.getBoundingClientRect().bottom;
    for (var e = body.lastElementChild; e; e = e.previousElementSibling) {
      var cs = getComputedStyle(e);
      if (cs.display === 'none' || cs.position === 'fixed' || cs.position === 'absolute') continue;
      bottom = Math.max(bottom, e.getBoundingClientRect().bottom + (parseFloat(cs.marginBottom) || 0));
      break;
    }
    var bs = getComputedStyle(body);
    var height = Math.ceil(bottom + (window.pageYOffset || 0) + (parseFloat(bs.paddingBottom) || 0) + (parseFloat(bs.marginBottom) || 0));
    if (!isFinite(height)) return;
    parent.postMessage({ type: '${FIT_MESSAGE_TYPE}', height: Math.min(MAX, Math.max(0, height)) }, '*');
  }
  window.panel || (window.panel = { fit: fit });
})();
`;

const FALLBACK_TAG = `<script>${FALLBACK_JS}</script>`;

/** True when the text has an `<html` tag, i.e. it is a whole document rather than a fragment. */
export function isFullDocument(text) {
  return FULL_DOCUMENT_RE.test(text);
}

// Same-length copy with comments blanked out, so tag searches ignore commented-out markup but offsets still map
// 1:1 onto the original string.
const maskComments = (s) => s.replace(COMMENT_RE, (m) => ' '.repeat(m.length));

const attr = (tag, name) => {
  const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  return m ? (m[1] ?? m[2] ?? m[3]).toLowerCase() : null;
};

const panelCssOptedOut = (view) =>
  [...view.matchAll(META_RE)].some(([tag]) => attr(tag, 'name') === PANEL_CSS_META && attr(tag, 'content') === 'off');

// `<` is escaped so no value in the map can close the script element.
const mapJson = (map) => JSON.stringify(map).replace(/</g, '\\u003c');

/** Merges the kit imports into the first importmap script of `doc` (author keys win), or returns null if there is none. */
function mergeImportMap(doc, imports) {
  const m = IMPORTMAP_RE.exec(maskComments(doc));
  if (!m) return null;
  const bodyStart = m.index + m[1].length;
  const bodyEnd = bodyStart + m[2].length;
  let author = {};
  try {
    const parsed = JSON.parse(doc.slice(bodyStart, bodyEnd));
    if (isObj(parsed)) author = parsed;
  } catch { /* invalid author map: the browser would ignore it, so ours replaces it */ }
  const merged = { ...author, imports: { ...imports, ...(isObj(author.imports) ? author.imports : {}) } };
  return doc.slice(0, bodyStart) + mapJson(merged) + doc.slice(bodyEnd);
}

/** Puts `tags` first in <head>; creates the <head> after <html> when the document has none. */
function insertInHead(doc, tags) {
  const view = maskComments(doc);
  const head = HEAD_OPEN_RE.exec(view);
  if (head) {
    const at = head.index + head[0].length;
    return doc.slice(0, at) + tags + doc.slice(at);
  }
  const html = HTML_OPEN_RE.exec(view);
  const at = html ? html.index + html[0].length : 0;
  return `${doc.slice(0, at)}<head>${tags}</head>${doc.slice(at)}`;
}

/**
 * Entry file text -> the document to serve.
 * `kit` = `{ url, imports }`: `url` the kit's URL prefix (`/<token>/kit/`), `imports` the importmap `imports`
 * object with absolute URLs. Omit it to skip the kit (only the window.panel fallback is injected).
 */
export function wrapEntry(text, kit = null) {
  let doc = isFullDocument(text)
    ? text
    : `<!doctype html><html><head><meta charset="utf-8">` +
      `<meta name="viewport" content="width=device-width, initial-scale=1">` +
      `<style>${BASE_CSS}</style></head><body>${text}</body></html>`;
  let tags = '';
  if (kit) {
    const merged = mergeImportMap(doc, kit.imports);
    if (merged === null) tags += `<script type="importmap">${mapJson({ imports: kit.imports })}</script>`;
    else doc = merged;
    if (!panelCssOptedOut(maskComments(doc))) tags += `<link rel="stylesheet" href="${kit.url}${KIT_PANEL_CSS}">`;
    tags += `<script src="${kit.url}${KIT_PANEL_JS}"></script>`;
  }
  return insertInHead(doc, tags + FALLBACK_TAG);
}
