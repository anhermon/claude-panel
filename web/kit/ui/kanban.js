// kanban.js - columns of cards. A card that changes column slides to its new place (FLIP), nothing is re-created.
import { h, build, addCss, flip, flash } from './core.js';
import { normalizeKanban, TONES, toArray } from './pure.js';
import { badge } from './badge.js';

const COLUMN_MIN_PX = 232;

addCss(`
.ui-kanban { display: grid; grid-auto-flow: column; grid-auto-columns: minmax(${COLUMN_MIN_PX}px, 1fr); gap: 12px; overflow-x: auto; padding-bottom: 6px; scroll-snap-type: x proximity; align-items: start; }
.ui-kcol { background: var(--ui-card); border: 1px solid var(--ui-line); border-radius: var(--ui-r); padding: 10px; display: flex; flex-direction: column; gap: 10px; scroll-snap-align: start; min-width: 0; --tone: var(--ui-mut); }
.ui-kcol-head { display: flex; align-items: center; gap: 8px; font-size: var(--ui-fs-s); font-weight: 600; letter-spacing: .1em; text-transform: uppercase; color: var(--tone); }
.ui-kcol-count { margin-left: auto; font-variant-numeric: tabular-nums; color: var(--ui-mut); letter-spacing: 0; }
.ui-kcol-count[data-over] { color: var(--ui-danger); font-weight: 700; }
.ui-kcol-body { display: flex; flex-direction: column; gap: 8px; min-height: 28px; }
.ui-kcard { background: var(--ui-card-hi); border: 1px solid var(--ui-line-hi); border-left: 3px solid var(--tone, var(--ui-line-hi)); border-radius: var(--ui-r-s); padding: 9px 11px; display: flex; flex-direction: column; gap: 5px; min-width: 0; }
.ui-kcard-title { font-weight: 600; overflow-wrap: anywhere; }
.ui-kcard-sub { font-size: var(--ui-fs-s); color: var(--ui-mut); overflow-wrap: anywhere; }
.ui-kcard-tags { display: flex; gap: 6px; flex-wrap: wrap; }
.ui-kcard-meta { font-size: var(--ui-fs-s); color: var(--ui-mut); }
.ui-kcol-empty { font-size: var(--ui-fs-s); color: var(--ui-dim); text-align: center; padding: 6px; }
`);

/**
 * kanban({columns: [{id, title, tone, limit, cards: [{id, title, sub, tags: ['x' | {text, tone}], meta, tone}]}]})
 * or flat cards: kanban({columns: ['todo', 'doing'], cards: [{id, column: 'todo', title}]}). Cards need a stable id to slide between columns.
 * e.g. kanban({columns: [{id: 'todo', title: 'To do', cards: [{id: 'a', title: 'Write docs'}]}, {id: 'done', title: 'Done'}]})
 */
export function kanban(opts = {}) {
  const el = h('div');
  const cols = new Map(); // id -> { col, title, count, body, empty }
  const cards = new Map(); // id -> { card, title, sub, tags, meta, sig }
  function ensureCol(c) {
    let e = cols.get(c.id);
    if (!e) {
      const title = h('span');
      const count = h('span.ui-kcol-count');
      const body = h('div.ui-kcol-body');
      const empty = h('div.ui-kcol-empty', null, 'Empty');
      e = { col: h('section.ui-kcol', { dataset: { id: c.id } }, h('div.ui-kcol-head', null, title, count), body), title, count, body, empty };
      cols.set(c.id, e);
    }
    return e;
  }
  function ensureCard(c) {
    let e = cards.get(c.id);
    if (!e) {
      const title = h('div.ui-kcard-title');
      const sub = h('div.ui-kcard-sub');
      const tags = h('div.ui-kcard-tags');
      const meta = h('div.ui-kcard-meta');
      e = { card: h('article.ui-kcard', { dataset: { key: c.id } }, title, sub, tags, meta), title, sub, tags, meta, sig: '' };
      cards.set(c.id, e);
    }
    const sig = JSON.stringify([c.title, c.sub, c.tags, c.meta, c.tone]);
    if (sig !== e.sig) {
      if (e.sig) flash(e.card);
      e.sig = sig;
      e.title.textContent = c.title ?? '';
      e.sub.textContent = c.sub ?? ''; e.sub.hidden = !c.sub;
      e.meta.textContent = c.meta ?? ''; e.meta.hidden = !c.meta;
      e.tags.replaceChildren(...toArray(c.tags).map((t) => badge(typeof t === 'string' ? { text: t } : t)));
      e.tags.hidden = !toArray(c.tags).length;
      if (TONES.includes(c.tone)) e.card.style.setProperty('--tone', `var(--ui-${c.tone === 'info' ? 'acc' : c.tone === 'neutral' ? 'mut' : c.tone})`); else e.card.style.removeProperty('--tone');
    }
    return e;
  }
  function render(o, prev) {
    const model = normalizeKanban(o);
    const mutate = () => {
      const liveCols = new Set(model.map((c) => c.id));
      for (const [id, e] of cols) if (!liveCols.has(id)) { e.col.remove(); cols.delete(id); }
      const liveCards = new Set(model.flatMap((c) => c.cards.map((x) => x.id)));
      for (const [id, e] of cards) if (!liveCards.has(id)) { e.card.remove(); cards.delete(id); }
      model.forEach((c, ci) => {
        const e = ensureCol(c);
        e.title.textContent = c.title;
        e.count.textContent = c.limit ? `${c.cards.length}/${c.limit}` : String(c.cards.length);
        e.count.toggleAttribute('data-over', Boolean(c.limit) && c.cards.length > c.limit);
        if (TONES.includes(c.tone)) e.col.style.setProperty('--tone', `var(--ui-${c.tone === 'info' ? 'acc' : c.tone === 'neutral' ? 'mut' : c.tone})`); else e.col.style.removeProperty('--tone');
        const nodes = c.cards.map((x) => ensureCard(x).card);
        const want = nodes.length ? nodes : [e.empty];
        want.forEach((n, i) => { if (e.body.childNodes[i] !== n) e.body.insertBefore(n, e.body.childNodes[i] ?? null); });
        while (e.body.childNodes.length > want.length) e.body.lastChild.remove();
        if (el.childNodes[ci] !== e.col) el.insertBefore(e.col, el.childNodes[ci] ?? null);
      });
    };
    if (prev) flip(el, mutate); else mutate();
  }
  return build(el, 'kanban', opts, render);
}
