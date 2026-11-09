// sanitize.js - a small allow-list HTML sanitiser for <p-md>. It never edits the input: it TOKENISES it and re-emits
// only allow-listed tags with allow-listed attributes, every value decoded then re-escaped. Anything it does not understand
// is escaped text or dropped, so the output is safe by construction (no reliance on the browser parsing the input the same way).
// Dropped with their content: script, style, iframe, object, embed, svg, math, template, form controls, head-ish tags.

const ALLOWED_TAGS = new Set([
  'p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'em', 'strong', 'b', 'i', 'u', 's',
  'del', 'ins', 'sub', 'sup', 'small', 'mark', 'kbd', 'a', 'img', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'span', 'div',
  'details', 'summary', 'figure', 'figcaption', 'input',
]);
const VOID_TAGS = new Set(['br', 'hr', 'img', 'input']);
const DROP_WITH_CONTENT = new Set([
  'script', 'style', 'iframe', 'object', 'embed', 'applet', 'svg', 'math', 'template', 'noscript', 'textarea', 'select', 'option',
  'title', 'head', 'frameset', 'frame', 'form', 'button', 'audio', 'video', 'canvas',
]);
const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", colon: ':', tab: '\t', newline: '\n', nbsp: ' ', lpar: '(', rpar: ')' };
const SAFE_DATA_IMAGE = /^data:image\/(png|gif|jpe?g|webp);base64,[a-z0-9+/=]+$/i;
const DIGITS = /^\d{1,4}$/;
// control chars, spaces, DEL/C1, zero-width and line-separator chars, BOM: all stripped by browsers inside a URL scheme
const IGNORED_IN_SCHEME = /[\u0000-\u0020\u007f-\u009f\u200b-\u200f\u2028\u2029\ufeff]/g;

function decodeEntities(text) {
  return text.replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z][a-z0-9]*));?/gi, (whole, dec, hex, name) => {
    if (name) return Object.hasOwn(NAMED_ENTITIES, name.toLowerCase()) ? NAMED_ENTITIES[name.toLowerCase()] : whole;
    const code = dec ? Number.parseInt(dec, 10) : Number.parseInt(hex, 16);
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '�';
  });
}

const escapeAttr = (v) => v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// Text between tags: keep entities the author wrote (the browser decodes them to TEXT, never markup), escape everything else.
const escapeText = (v) => v.replace(/&(?![a-z0-9#]+;)/gi, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Returns the URL if its scheme is allowed, else null. The browser ignores control chars/whitespace inside a scheme, so do we. */
export function safeUrl(value, { image = false } = {}) {
  const compact = value.replace(IGNORED_IN_SCHEME, '');
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(compact)?.[1].toLowerCase();
  if (!scheme) return value.trim();
  if (scheme === 'http' || scheme === 'https') return value.trim();
  if (!image && (scheme === 'mailto' || scheme === 'tel')) return value.trim();
  if (image && scheme === 'data' && SAFE_DATA_IMAGE.test(compact)) return compact;
  return null;
}

/** One attribute -> its sanitised value, or null to drop it. */
function cleanAttribute(tag, name, value) {
  const oneOf = (...options) => (options.includes(value.toLowerCase()) ? value.toLowerCase() : null);
  switch (name) {
    case 'class': return value.replace(/[^\w -]/g, '').trim() || null;
    case 'title': case 'alt': case 'lang': return value;
    case 'dir': return oneOf('ltr', 'rtl', 'auto');
    case 'href': return tag === 'a' ? safeUrl(value) : null;
    case 'src': return tag === 'img' ? safeUrl(value, { image: true }) : null;
    case 'width': case 'height': return tag === 'img' && DIGITS.test(value) ? value : null;
    case 'colspan': case 'rowspan': return (tag === 'td' || tag === 'th') && DIGITS.test(value) ? value : null;
    case 'start': return tag === 'ol' && DIGITS.test(value) ? value : null;
    case 'align': return tag === 'td' || tag === 'th' ? oneOf('left', 'right', 'center') : null;
    case 'loading': return tag === 'img' ? oneOf('lazy', 'eager') : null;
    default: return null;
  }
}

function openTag(tag, attributes) {
  const attrs = new Map();
  for (const [name, value] of attributes) if (!attrs.has(name)) attrs.set(name, value); // first one wins, like browsers
  if (tag === 'input') { // only the disabled task-list checkbox GFM produces
    return attrs.get('type')?.toLowerCase() === 'checkbox' ? `<input type="checkbox" disabled${attrs.has('checked') ? ' checked' : ''}>` : '';
  }
  let out = `<${tag}`;
  for (const [name, value] of attrs) {
    const clean = cleanAttribute(tag, name, value);
    if (clean !== null) out += ` ${name}="${escapeAttr(clean)}"`;
  }
  // links cannot navigate a sandboxed scene away from its page; open as new-window requests (the sandbox blocks popups)
  if (tag === 'a' && out.includes(' href=')) out += ' target="_blank" rel="noopener noreferrer"';
  return `${out}>`;
}

/** Parses attributes from index i (just after the tag name) to the closing '>'. Returns {attrs, end} or null when malformed. */
function parseTag(s, i) {
  const attrs = [];
  for (;;) {
    while (i < s.length && /[\s/]/.test(s[i])) i++;
    if (i >= s.length || s[i] === '<') return null;
    if (s[i] === '>') return { attrs, end: i + 1 };
    let j = i;
    while (j < s.length && !/[\s"'<>/=]/.test(s[j])) j++;
    if (j === i) { i++; continue; } // stray quote or '='
    const name = s.slice(i, j).toLowerCase();
    i = j;
    while (i < s.length && /\s/.test(s[i])) i++;
    let value = '';
    if (s[i] === '=') {
      i++;
      while (i < s.length && /\s/.test(s[i])) i++;
      if (s[i] === '"' || s[i] === "'") {
        const close = s.indexOf(s[i], i + 1);
        if (close === -1) return null;
        value = s.slice(i + 1, close);
        i = close + 1;
      } else {
        let k = i;
        while (k < s.length && !/[\s>]/.test(s[k])) k++;
        value = s.slice(i, k);
        i = k;
      }
    }
    attrs.push([name, decodeEntities(value)]);
  }
}

function skipElement(s, i, tag) {
  const close = new RegExp(`</${tag}[\\s/>]`, 'ig');
  close.lastIndex = i;
  const m = close.exec(s);
  if (!m) return s.length;
  const gt = s.indexOf('>', m.index);
  return gt === -1 ? s.length : gt + 1;
}

export function sanitizeHtml(html) {
  const s = String(html ?? '');
  let out = '';
  let i = 0;
  while (i < s.length) {
    const lt = s.indexOf('<', i);
    if (lt === -1) { out += escapeText(s.slice(i)); break; }
    out += escapeText(s.slice(i, lt));
    i = lt;
    if (s.startsWith('<!--', i)) { const end = s.indexOf('-->', i + 4); i = end === -1 ? s.length : end + 3; continue; }
    if (s[i + 1] === '!' || s[i + 1] === '?') { const end = s.indexOf('>', i); i = end === -1 ? s.length : end + 1; continue; }
    const m = /^<(\/?)([a-zA-Z][a-zA-Z0-9-]*)/.exec(s.slice(i, i + 40));
    const parsed = m ? parseTag(s, i + m[0].length) : null;
    if (!m || !parsed) { out += '&lt;'; i++; continue; } // not a tag we can read: it is text
    const tag = m[2].toLowerCase();
    i = parsed.end;
    if (m[1]) { if (ALLOWED_TAGS.has(tag) && !VOID_TAGS.has(tag)) out += `</${tag}>`; continue; }
    if (DROP_WITH_CONTENT.has(tag)) { i = skipElement(s, i, tag); continue; }
    if (ALLOWED_TAGS.has(tag)) out += openTag(tag, parsed.attrs);
  }
  return out;
}
