// text.js - text (styled line/paragraph) and md (markdown-lite: headings, bold, italic, code, links, lists, quotes, fences).
import { h, build, addCss, setChildren } from './core.js';
import { parseMarkdown, parseInline, isObj, TONES } from './pure.js';

addCss(`
.ui-text { margin: 0; overflow-wrap: anywhere; }
.ui-text[data-size="xl"] { font-size: var(--ui-fs-xl); font-weight: 700; line-height: 1.15; }
.ui-text[data-size="l"] { font-size: var(--ui-fs-l); font-weight: 600; }
.ui-text[data-size="s"] { font-size: var(--ui-fs-s); color: var(--ui-mut); }
.ui-text[data-bold] { font-weight: 700; }
.ui-text[data-mono] { font-family: var(--ui-mono); }
.ui-text[class*="ui-tone-"] { color: var(--tone); }
.ui-md > :first-child { margin-top: 0; } .ui-md > :last-child { margin-bottom: 0; }
.ui-md h1, .ui-md h2, .ui-md h3 { margin: .9em 0 .35em; line-height: 1.2; }
.ui-md h1 { font-size: var(--ui-fs-xl); } .ui-md h2 { font-size: var(--ui-fs-l); } .ui-md h3 { font-size: var(--ui-fs); color: var(--ui-mut); letter-spacing: .06em; text-transform: uppercase; }
.ui-md p, .ui-md ul, .ui-md ol, .ui-md blockquote, .ui-md pre { margin: .5em 0; }
.ui-md ul, .ui-md ol { padding-left: 1.4em; }
.ui-md code { font-family: var(--ui-mono); font-size: .92em; background: var(--ui-card-hi); border-radius: 4px; padding: .08em .35em; }
.ui-md pre { background: var(--ui-card-hi); border: 1px solid var(--ui-line); border-radius: var(--ui-r-s); padding: 10px 12px; overflow-x: auto; }
.ui-md pre code { background: none; padding: 0; }
.ui-md blockquote { border-left: 3px solid var(--ui-line-hi); padding-left: 12px; color: var(--ui-mut); }
.ui-md a { color: var(--ui-acc); }
`);

/** text('Hello') or text({text, size: 'xl'|'l'|'m'|'s', tone, bold, mono}): one styled paragraph. e.g. text({text: '3 failing', tone: 'danger', size: 'l'}) */
export function text(input = '') {
  const opts = isObj(input) ? input : { text: input };
  const el = h('p');
  return build(el, 'text', opts, (o) => {
    el.textContent = o.text ?? '';
    el.dataset.size = o.size ?? 'm';
    el.toggleAttribute('data-bold', Boolean(o.bold));
    el.toggleAttribute('data-mono', Boolean(o.mono));
    for (const t of TONES) el.classList.toggle(`ui-tone-${t}`, o.tone === t);
    el.style.textAlign = o.align ?? '';
  });
}

const inlineNodes = (src) => parseInline(src).map((n) => {
  if (typeof n === 'string') return n;
  if (n.t === 'code') return h('code', null, n.text);
  if (n.t === 'b') return h('strong', null, n.text);
  if (n.t === 'i') return h('em', null, n.text);
  return h('a', { href: n.href, target: '_blank', rel: 'noopener noreferrer' }, n.text);
});

/** md('# Title\n- **bold** item') or md({text}): markdown-lite rendered with DOM nodes (never innerHTML). e.g. md('Deploy `v2` is **live**') */
export function md(input = '') {
  const opts = isObj(input) ? input : { text: input };
  const el = h('div');
  return build(el, 'md', opts, (o) => {
    setChildren(el, parseMarkdown(o.text).map((b) => {
      if (b.t === 'h') return h(`h${b.level}`, null, inlineNodes(b.text));
      if (b.t === 'ul' || b.t === 'ol') return h(b.t, null, b.items.map((i) => h('li', null, inlineNodes(i))));
      if (b.t === 'quote') return h('blockquote', null, inlineNodes(b.text));
      if (b.t === 'code') return h('pre', null, h('code', null, b.text));
      return h('p', null, inlineNodes(b.text));
    }));
  });
}
