// sanitize.mjs - the `html` frame's sanitiser: the freeform escape hatch (text, a little layout, inline SVG).
// It never edits the input: it TOKENISES it and re-emits only allow-listed tags and attributes, every value decoded
// and re-escaped, so the output is safe by construction (it does not depend on the browser parsing the input the way
// we do). No DOM, so Node tests it. Kept: basic text tags, <svg> and its drawing elements, `class`, `id` (prefixed),
// `style` limited to ALLOWED_STYLE, and <a> with an absolute http(s) `href` only (re-emitted as the parsed URL with a
// forced target="_blank" rel="noopener noreferrer"; the author's target/rel/anything else is ignored). Dropped (with their content): script, style, iframe, object, embed, foreignObject,
// template... Dropped (tag only, text kept): everything else, e.g. <a> without a valid href, <a> in <svg>, <img>, <use>, <image>, <animate>, <set>, <form>.

export const HTML_MAX = 8192;
const DEPTH_MAX = 24;
const STYLE_VALUE_MAX = 120;
const HREF_MAX = 2048;

const HTML_TAGS = new Set(['a', 'div', 'span', 'p', 'b', 'strong', 'i', 'em', 'small', 'br', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'code', 'pre', 'sub', 'sup', 'u', 's', 'mark', 'hr']);
const SVG_TAGS = new Map(['svg', 'g', 'path', 'circle', 'rect', 'line', 'polyline', 'polygon', 'ellipse', 'text', 'tspan', 'defs', 'linearGradient', 'radialGradient', 'stop', 'title', 'desc']
  .map((t) => [t.toLowerCase(), t]));
const VOID_TAGS = new Set(['br', 'hr']);
const DROP_WITH_CONTENT = new Set(['script', 'style', 'iframe', 'object', 'embed', 'applet', 'foreignobject', 'template', 'noscript', 'textarea', 'select', 'head', 'frameset', 'math', 'audio', 'video', 'canvas', 'button']);

// presentation attributes of SVG elements (canonical case); anything else is dropped
const SVG_ATTRS = new Map(['viewBox', 'preserveAspectRatio', 'd', 'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'stroke-dasharray', 'stroke-dashoffset', 'stroke-opacity', 'fill-opacity', 'fill-rule', 'opacity',
  'cx', 'cy', 'r', 'rx', 'ry', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'width', 'height', 'points', 'transform', 'font-size', 'font-weight', 'font-family', 'text-anchor', 'dominant-baseline', 'letter-spacing',
  'offset', 'stop-color', 'stop-opacity', 'gradientUnits', 'gradientTransform', 'dx', 'dy', 'pathLength']
  .map((a) => [a.toLowerCase(), a]));
const URL_ATTRS = new Set(['fill', 'stroke']);

export const ALLOWED_STYLE = new Set(['color', 'background', 'font-size', 'font-weight', 'padding', 'margin', 'border', 'border-radius', 'text-align', 'display', 'flex', 'grid', 'gap', 'width', 'height', 'opacity', 'transform']);
const STYLE_FORBIDDEN = /[\\<>@{}]|url\s*\(|expression|javascript|vbscript|behavior|binding|import|var\s*\(|attr\s*\(/i;
const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", colon: ':', tab: '\t', newline: '\n', nbsp: ' ', lpar: '(', rpar: ')' };
// control chars, spaces, DEL/C1, zero-width and line-separator chars, BOM: browsers ignore them inside a URL scheme
const IGNORED_IN_SCHEME = /[\u0000-\u0020\u007f-\u009f\u200b-\u200f\u2028\u2029\ufeff]/g;
const BAD_SCHEME = /(?:javascript|vbscript|data|livescript):/i;
const ABS_HTTP_RE = /^https?:\/\/[^/]/i;
const ID_RE = /^[A-Za-z][\w-]{0,31}$/;
const LOCAL_URL_RE = /^url\(#([A-Za-z][\w-]{0,31})\)$/;
const TAG_RE = /^<([a-zA-Z][a-zA-Z0-9:-]*)((?:\s+[^\s"'<>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>/;
const ATTR_RE = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
const CLOSE_RE = /^<\/([a-zA-Z][a-zA-Z0-9:-]*)\s*>/;

function decodeEntities(text) {
  return text.replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z][a-z0-9]*));?/gi, (whole, dec, hex, name) => {
    if (name) return Object.hasOwn(NAMED_ENTITIES, name.toLowerCase()) ? NAMED_ENTITIES[name.toLowerCase()] : whole;
    const code = dec ? Number.parseInt(dec, 10) : Number.parseInt(hex, 16);
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '�';
  });
}
const escapeAttr = (v) => v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeText = (v) => v.replace(/&(?![a-z0-9#]+;)/gi, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** `style="..."` text -> only the allow-listed declarations with harmless values ('' when none survive). */
export function cleanStyle(value) {
  const out = [];
  for (const decl of decodeEntities(value).split(';')) {
    const at = decl.indexOf(':');
    if (at < 0) continue;
    const prop = decl.slice(0, at).trim().toLowerCase();
    const val = decl.slice(at + 1).trim();
    if (!ALLOWED_STYLE.has(prop) || val === '' || val.length > STYLE_VALUE_MAX || STYLE_FORBIDDEN.test(val)) continue;
    if (BAD_SCHEME.test(val.replace(IGNORED_IN_SCHEME, ''))) continue;
    out.push(`${prop}:${val}`);
  }
  return out.join(';');
}

/** decoded href text -> the normalised absolute http(s) URL, or '' (relative, protocol-relative, other schemes, too long). */
function cleanHref(val) {
  const v = val.trim();
  if (v.length > HREF_MAX || !ABS_HTTP_RE.test(v.replace(IGNORED_IN_SCHEME, ''))) return '';
  try {
    const u = new URL(v);
    return (u.protocol === 'https:' || u.protocol === 'http:') && u.href.length <= HREF_MAX ? u.href : '';
  } catch { return ''; }
}

function cleanAttr(name, value, inSvg, idPrefix, tag) {
  const lower = name.toLowerCase();
  if (lower.startsWith('on')) return null;
  const val = decodeEntities(value);
  if (/[<\\]/.test(val) || BAD_SCHEME.test(val.replace(IGNORED_IN_SCHEME, ''))) return null;
  if (tag === 'a') { // a link keeps its href and nothing else but class/style; target and rel are forced by the caller
    if (lower === 'href') { const href = cleanHref(val); return href ? ['href', href] : null; }
    if (lower !== 'class' && lower !== 'style') return null;
  }
  if (lower === 'class') return [name, val.replace(/[^\w -]/g, '').trim()];
  if (lower === 'style') { const s = cleanStyle(value); return s ? ['style', s] : null; }
  if (lower === 'id') return ID_RE.test(val) ? ['id', idPrefix + val] : null;
  if (!inSvg || !SVG_ATTRS.has(lower)) return null;
  const canon = SVG_ATTRS.get(lower);
  if (/url\s*\(/i.test(val)) { // only `fill`/`stroke` may point at a gradient of this same html, e.g. url(#g1)
    const m = LOCAL_URL_RE.exec(val.trim());
    return URL_ATTRS.has(lower) && m ? [canon, `url(#${idPrefix}${m[1]})`] : null;
  }
  return [canon, val];
}

/**
 * html text -> safe html text. `idPrefix` is put in front of every id (and of the url(#id) references to them), so
 * a frame can never clash with ids of the page.
 */
export function sanitizeHtml(input, { idPrefix = 'h-' } = {}) {
  const src = String(input ?? '').slice(0, HTML_MAX);
  let out = '';
  const stack = []; // open elements we emitted: canonical tag names
  let i = 0;
  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt < 0) { out += escapeText(src.slice(i)); break; }
    out += escapeText(src.slice(i, lt));
    i = lt;
    if (src.startsWith('<!--', i)) { const end = src.indexOf('-->', i + 4); i = end < 0 ? src.length : end + 3; continue; }
    const close = CLOSE_RE.exec(src.slice(i, i + 64));
    if (close) {
      const name = close[1].toLowerCase();
      const at = stack.map((s) => s.toLowerCase()).lastIndexOf(name);
      if (at >= 0) while (stack.length > at) out += `</${stack.pop()}>`;
      i += close[0].length;
      continue;
    }
    const m = TAG_RE.exec(src.slice(i));
    if (!m) { out += '&lt;'; i += 1; continue; } // a stray `<` is text
    i += m[0].length;
    const lower = m[1].toLowerCase();
    if (DROP_WITH_CONTENT.has(lower)) {
      if (m[3] === '/') continue;
      const re = new RegExp(`</${lower.replace(/[^a-z0-9]/g, '')}\\s*>`, 'i');
      const rest = src.slice(i);
      const end = rest.search(re);
      i = end < 0 ? src.length : i + end + rest.slice(end).search(/>/) + 1;
      continue;
    }
    const inSvg = stack.some((s) => s === 'svg');
    const isSvgTag = SVG_TAGS.has(lower) && (lower === 'svg' || inSvg);
    const tag = isSvgTag ? SVG_TAGS.get(lower) : HTML_TAGS.has(lower) ? lower : null;
    if (!tag || stack.length >= DEPTH_MAX) continue; // unknown tag: dropped, its text stays
    if (tag === 'a' && (inSvg || stack.includes('a'))) continue; // links do not nest, and an svg <a> is never kept
    const attrs = [];
    for (const [, name, dq, sq, bare] of m[2].matchAll(ATTR_RE)) {
      const cleaned = cleanAttr(name, dq ?? sq ?? bare ?? '', isSvgTag, idPrefix, tag);
      if (cleaned && !attrs.some(([n]) => n === cleaned[0])) attrs.push(cleaned);
    }
    if (tag === 'a') {
      if (!attrs.some(([n]) => n === 'href')) continue; // no valid href: the tag is dropped, its text stays
      attrs.push(['target', '_blank'], ['rel', 'noopener noreferrer']);
    }
    const attrText = attrs.map(([n, v]) => ` ${n}="${escapeAttr(v)}"`).join('');
    if (VOID_TAGS.has(tag)) out += `<${tag}${attrText}>`;
    else if (isSvgTag && m[3] === '/') out += `<${tag}${attrText}/>`;
    else { out += `<${tag}${attrText}>`; stack.push(tag); }
  }
  while (stack.length) out += `</${stack.pop()}>`;
  return out;
}
