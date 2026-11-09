// table.js - sortable table with keyed rows: updates edit cells in place, flash what changed and slide rows that re-sort.
import { h, build, addCss, flash, flip, setChildren } from './core.js';
import { normalizeColumns, sortRows, nextSort, formatNumber, isNum, toArray, TONES } from './pure.js';
import { badge } from './badge.js';

const EMPTY_CELL = '–';
const ARROW = Object.freeze({ asc: '▲', desc: '▼' });

addCss(`
.ui-table-wrap { overflow-x: auto; border: 1px solid var(--ui-line); border-radius: var(--ui-r-s); background: var(--ui-card); }
.ui-tbl { width: 100%; border-collapse: collapse; font-size: var(--ui-fs); }
.ui-tbl th, .ui-tbl td { padding: 8px 12px; text-align: left; border-bottom: 1px solid var(--ui-line); vertical-align: middle; }
.ui-tbl tbody tr:last-child td { border-bottom: 0; }
.ui-tbl th { font-size: var(--ui-fs-s); font-weight: 600; letter-spacing: .08em; text-transform: uppercase; color: var(--ui-mut); white-space: nowrap; background: var(--ui-card); }
.ui-tbl [data-align="right"] { text-align: right; font-variant-numeric: tabular-nums; }
.ui-tbl [data-align="center"] { text-align: center; }
.ui-tbl td[data-type="num"] { white-space: nowrap; }
.ui-tbl th button { all: unset; cursor: pointer; display: inline-flex; gap: 6px; align-items: center; color: inherit; }
.ui-tbl th button:focus-visible { outline: 2px solid var(--ui-acc); outline-offset: 2px; border-radius: 4px; }
.ui-tbl th[aria-sort] { color: var(--ui-fg); }
.ui-table-arrow { font-size: 13px; opacity: .85; width: 13px; }
.ui-tbl tbody tr:hover td { background: color-mix(in srgb, var(--ui-acc) 7%, transparent); }
.ui-tbl .ui-table-empty td { text-align: center; color: var(--ui-mut); padding: 18px; }
`);

/**
 * table({columns: [{key, label, type: 'num'|'text'|'badge', format, tones, align}], rows, rowKey, sort: {key, dir}, sortable})
 * Click a header to sort. update({rows}) edits cells in place (changed cells flash, re-sorted rows slide).
 * e.g. table({columns: ['name', 'qty'], rows: [{name: 'a', qty: 2}], rowKey: 'name'})
 */
export function table(opts = {}) {
  const headRow = h('tr');
  const body = h('tbody');
  const el = h('div', null, h('table.ui-tbl', null, h('thead', null, headRow), body));
  el.classList.add('ui-table-wrap');
  const cache = new Map(); // row key -> { tr, cells: Map(col key -> td), last: Map(col key -> text) }
  const heads = new Map();
  let sort = null;
  let api = null;

  const cellContent = (col, row) => {
    const v = row[col.key];
    if (typeof col.format === 'function') return col.format(v, row);
    if (col.type === 'badge') return v === undefined || v === null ? EMPTY_CELL : badge({ text: String(v), tone: TONES.includes(col.tones?.[v]) ? col.tones[v] : 'neutral' });
    if (isNum(v)) return formatNumber(v, { decimals: col.decimals, compact: col.compact, prefix: col.prefix, suffix: col.suffix });
    return v === undefined || v === null || v === '' ? EMPTY_CELL : String(v);
  };

  function render(o, prev) {
    const rows = toArray(o.rows).filter((r) => r && typeof r === 'object');
    const cols = normalizeColumns(o.columns, rows);
    if (!prev || o.sort !== prev.sort) sort = o.sort ?? sort ?? null;
    const sortable = o.sortable !== false;
    const rowKey = o.rowKey ?? cols[0]?.key;
    // header: reuse buttons by column key
    const wanted = cols.map((col) => {
      let th = heads.get(col.key);
      if (!th) {
        const arrow = h('span.ui-table-arrow', { 'aria-hidden': 'true' });
        const label = h('span');
        const btn = h('button', { type: 'button', onclick: () => { sort = nextSort(sort, col.key); render(api.opts(), api.opts()); } }, label, arrow);
        th = { th: h('th', { scope: 'col' }, btn), btn, label, arrow };
        heads.set(col.key, th);
      }
      th.label.textContent = col.label;
      th.th.dataset.align = col.align;
      const active = sort && sort.key === col.key;
      th.arrow.textContent = active ? ARROW[sort.dir] : '';
      if (active) th.th.setAttribute('aria-sort', sort.dir === 'asc' ? 'ascending' : 'descending'); else th.th.removeAttribute('aria-sort');
      th.btn.disabled = !sortable || col.sortable === false;
      th.btn.style.cursor = th.btn.disabled ? 'default' : 'pointer';
      return th.th;
    });
    for (const key of [...heads.keys()]) if (!cols.some((c) => c.key === key)) heads.delete(key);
    if (headRow.childNodes.length !== wanted.length || wanted.some((th, i) => headRow.childNodes[i] !== th)) setChildren(headRow, wanted);

    const sorted = sort ? sortRows(rows, sort.key, sort.dir) : rows;
    const live = new Set();
    const trs = sorted.map((row, i) => {
      const key = String(row[rowKey] ?? i);
      live.add(key);
      let entry = cache.get(key);
      if (!entry) { entry = { tr: h('tr', { dataset: { key } }), cells: new Map(), last: new Map() }; cache.set(key, entry); }
      cols.forEach((col, ci) => {
        let td = entry.cells.get(col.key);
        if (!td) { td = h('td'); entry.cells.set(col.key, td); }
        td.dataset.align = col.align;
        td.dataset.type = col.type;
        const raw = JSON.stringify(row[col.key] ?? null);
        if (entry.last.get(col.key) !== raw) {
          const content = cellContent(col, row);
          if (content instanceof Node) setChildren(td, content); else td.textContent = content;
          if (entry.last.has(col.key)) flash(td);
          entry.last.set(col.key, raw);
        }
        if (entry.tr.childNodes[ci] !== td) entry.tr.insertBefore(td, entry.tr.childNodes[ci] ?? null);
      });
      while (entry.tr.childNodes.length > cols.length) entry.tr.lastChild.remove();
      return entry.tr;
    });
    for (const [key, entry] of cache) if (!live.has(key)) { entry.tr.remove(); cache.delete(key); }
    const empty = h('tr.ui-table-empty', null, h('td', { colspan: Math.max(1, cols.length) }, o.empty ?? 'No rows'));
    const target = trs.length ? trs : [empty];
    if (target.some((tr, i) => body.childNodes[i] !== tr) || body.childNodes.length !== target.length) {
      if (prev && trs.length) flip(el, () => setChildren(body, target)); else setChildren(body, target);
    }
  }
  api = build(el, 'table', opts, render);
  return api;
}
