// statusboard.js - `statusboard`: many items grouped by state (agents by status, tickets by stage, files by review result). Columns with a
// count chip and compact cards; the columns wrap into rows on narrow widths; a column over its limit is flagged.
import { addCss } from '../ui/core.js';
import { check, defineAsset, each, h, toneColor } from './core.js';

const MAX_COLUMNS = 6;
const MAX_ITEMS = 12;
const MAX_TAGS = 4;
const COLUMN_MIN_PX = 200;

function validateStatusboard(d) {
  check.object(d, 'data', ['columns']);
  const seen = new Set();
  const columns = each(d.columns, 'data.columns', { max: MAX_COLUMNS }, (c, p) => {
    check.object(c, p, ['id', 'title', 'tone', 'limit', 'items']);
    return {
      id: check.id(c.id, `${p}.id`, seen), title: check.string(c.title, `${p}.title`, { max: 28 }), tone: check.tone(c.tone, `${p}.tone`),
      limit: check.number(c.limit, `${p}.limit`, { min: 1, optional: true }),
      items: c.items === undefined ? [] : each(c.items, `${p}.items`, { min: 0, max: MAX_ITEMS }, (it, q) => {
        check.object(it, q, ['title', 'sub', 'tags']);
        return { title: check.string(it.title, `${q}.title`, { max: 70 }), sub: check.string(it.sub, `${q}.sub`, { max: 90, optional: true }), tags: it.tags === undefined ? undefined : each(it.tags, `${q}.tags`, { min: 0, max: MAX_TAGS }, (t, r) => check.string(t, r, { max: 20 })) };
      }),
    };
  });
  return { columns };
}

addCss(`
.pa-sb { display: grid; grid-template-columns: repeat(auto-fit, minmax(${COLUMN_MIN_PX}px, 1fr)); gap: 12px; align-items: start; min-width: 0; }
.pa-sb-fill { height: 100%; overflow: auto; align-content: start; }
.pa-sb-col { --tone: var(--ui-mut); border: 1px solid var(--ui-line); border-top: 4px solid var(--tone); border-radius: var(--ui-r); background: color-mix(in srgb, var(--tone) 6%, var(--ui-card)); padding: 10px; display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.pa-sb-col[data-over] { border-color: var(--ui-danger); border-style: dashed; border-top-style: solid; }
.pa-sb-head { display: flex; align-items: center; gap: 8px; }
.pa-sb-title { font-weight: 700; flex: 1; min-width: 0; overflow-wrap: anywhere; }
.pa-sb-chip { font-variant-numeric: tabular-nums; font-weight: 700; font-size: var(--ui-fs-s); min-width: 26px; text-align: center; padding: 1px 9px; border-radius: 99px; color: var(--ui-on-acc); background: var(--tone); }
.pa-sb-chip[data-over] { background: var(--ui-danger); color: var(--ui-on-acc); }
.pa-sb-flag { font-size: var(--ui-fs-s); font-weight: 650; color: var(--ui-danger); }
.pa-sb-card { background: var(--ui-card); border: 1px solid var(--ui-line-hi); border-left: 3px solid var(--tone); border-radius: var(--ui-r-s); padding: 7px 10px; display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.pa-sb-ctitle { font-weight: 600; overflow-wrap: anywhere; }
.pa-sb-sub { font-size: var(--ui-fs-s); color: var(--ui-mut); overflow-wrap: anywhere; }
.pa-sb-tags { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 2px; }
.pa-sb-tag { font-size: var(--ui-fs-s); padding: 0 8px; border-radius: 99px; border: 1px solid var(--ui-line-hi); color: var(--ui-mut); background: var(--ui-card-hi); }
.pa-sb-empty { font-size: var(--ui-fs-s); color: var(--ui-dim); padding: 4px 2px; }
`);

function column(c) {
  const over = c.limit !== undefined && c.items.length > c.limit;
  const el = h('section.pa-sb-col', { 'aria-label': `${c.title}: ${c.items.length} items` });
  el.style.setProperty('--tone', toneColor(c.tone, 'var(--ui-mut)'));
  if (over) el.dataset.over = '';
  const count = h('span.pa-sb-chip', null, c.limit === undefined ? String(c.items.length) : `${c.items.length}/${c.limit}`);
  if (over) count.dataset.over = '';
  el.append(h('div.pa-sb-head', null, h('span.pa-sb-title', null, c.title), over ? h('span.pa-sb-flag', null, `over by ${c.items.length - c.limit}`) : null, count));
  for (const it of c.items) {
    el.append(h('div.pa-sb-card', null, h('div.pa-sb-ctitle', null, it.title), it.sub ? h('div.pa-sb-sub', null, it.sub) : null,
      it.tags?.length ? h('div.pa-sb-tags', null, it.tags.map((t) => h('span.pa-sb-tag', null, t))) : null));
  }
  if (!c.items.length) el.append(h('div.pa-sb-empty', null, 'Nothing here'));
  return el;
}

export const statusboard = defineAsset({
  kind: 'statusboard',
  shape: 'many items sorted into states (agents by status, tasks by stage, files by review result); where is everything right now',
  summary: 'Tinted columns with a count chip (n/limit) and compact cards with tags; a column over its limit gets a red dashed border and a flag. Wraps to rows when narrow.',
  keys: ['columns'],
  html: true,
  sample: {
    columns: [
      { id: 'queued', title: 'Queued', items: [{ title: 'Migrate settings schema', sub: 'blocked on review', tags: ['db'] }, { title: 'Update changelog', tags: ['docs'] }] },
      { id: 'running', title: 'Running', tone: 'info', limit: 2, items: [{ title: 'Panel assets W4', sub: 'sonnet / medium', tags: ['ui', 'svg'] }, { title: 'Panel assets W3', sub: 'sonnet / medium', tags: ['ui'] }, { title: 'Eval suite', sub: 'haiku / low', tags: ['test'] }] },
      { id: 'review', title: 'In review', tone: 'warn', items: [{ title: 'Board frame limits', sub: '2 comments open', tags: ['api'] }] },
      { id: 'done', title: 'Done', tone: 'ok', items: [{ title: 'Asset contract + core', tags: ['core'] }, { title: 'Catalog render script', tags: ['test'] }, { title: 'Sankey + flow', tags: ['ui', 'svg'] }] },
    ],
  },
  validate: validateStatusboard,
  draw(ctx) {
    const board = h('div.pa-sb', null, ctx.data.columns.map(column));
    board.classList.toggle('pa-sb-fill', ctx.fill);
    ctx.root.append(board);
  },
});
