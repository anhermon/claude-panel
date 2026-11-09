// filetree.js - `filetree`: where a change landed in the code structure. A real directory tree with a heat gutter, a tiny
// added/removed bar per row and folder totals, so hot spots stand out without reading numbers.
import { addCss } from '../ui/core.js';
import { AssetError, check, each, defineAsset, h, heat, fmt, clamp } from './core.js';

const MAX_FILES = 120;
const PATH_MAX = 160;
const NOTE_MAX = 80;
const UNIT_MAX = 12;
const STATUSES = ['new', 'changed', 'deleted', 'untouched'];
const COLLAPSE_ABOVE = 40; // rows; more than this and folders below the top level start collapsed
const COLLAPSE_FROM_DEPTH = 1;
const ROW_HEAT_SCALE = 0.3; // churn share -> row tint (the gutter uses the full heat ramp)
const BAR_W = 84;
const BAR_W_NARROW = 30;
const INDENT = 16;
const INDENT_NARROW = 11;
const MIN_BAR_SHARE = 0.04; // a changed row always shows a visible bar
const SORT_LOCALE = 'en';

addCss(`
.pa-ft { display: block; overflow-x: hidden; }
.pa-ft-fill { height: 100%; overflow: auto; }
.pa-ft-sum { display: flex; gap: 12px; flex-wrap: wrap; align-items: baseline; padding: 0 2px 8px; color: var(--ui-mut); font-size: max(12px, .92em); }
.pa-ft-sum b { color: var(--ui-fg); font-weight: 650; }
.pa-ft-add { color: var(--ui-ok); } .pa-ft-del { color: var(--ui-danger); }
.pa-ft-row { display: grid; grid-template-columns: 5px minmax(0, 1fr) var(--ft-bar) minmax(7ch, auto); align-items: center; column-gap: 10px; min-height: 2em; border-radius: 5px; padding-right: 8px; }
.pa-ft-row:hover { outline: 1px solid var(--ui-line-hi); }
.pa-ft-heat { align-self: stretch; border-radius: 3px; margin: 2px 0; }
.pa-ft-name { display: flex; align-items: center; min-width: 0; gap: 6px; }
.pa-ft-g { flex: none; align-self: stretch; border-left: 1px solid var(--ui-line); }
.pa-ft-lbl { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pa-ft-dir .pa-ft-lbl { font-weight: 650; }
.pa-ft-gone .pa-ft-lbl { text-decoration: line-through; color: var(--ui-mut); }
.pa-ft-idle .pa-ft-lbl { color: var(--ui-dim); }
.pa-ft-note { color: var(--ui-mut); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 0 1 auto; min-width: 0; font-size: max(12px, .92em); }
.pa-ft-tog { all: unset; display: inline-flex; align-items: center; gap: 6px; min-width: 0; cursor: pointer; border-radius: 4px; }
.pa-ft-tog:focus-visible { outline: 2px solid var(--ui-acc); outline-offset: 1px; }
.pa-ft-chev { flex: none; width: 0; height: 0; border-left: 6px solid var(--ui-mut); border-top: 4px solid transparent; border-bottom: 4px solid transparent; transition: transform .15s; }
.pa-ft-open > .pa-ft-chev { transform: rotate(90deg); }
.pa-ft-dot { flex: none; width: 6px; height: 6px; margin: 0 1px; border-radius: 50%; background: var(--ui-line-hi); }
.pa-ft-badge { flex: none; font-size: 12px; font-weight: 700; letter-spacing: .02em; text-transform: uppercase; padding: 0 6px; border-radius: 99px; line-height: 1.6; }
.pa-ft-new { color: var(--ui-ok); background: color-mix(in srgb, var(--ui-ok) 16%, var(--ui-card)); }
.pa-ft-rm { color: var(--ui-danger); background: color-mix(in srgb, var(--ui-danger) 16%, var(--ui-card)); }
.pa-ft-bar { display: flex; height: 8px; }
.pa-ft-bar i { display: block; height: 100%; }
.pa-ft-bar i:first-child { background: var(--ui-ok); border-radius: 4px 0 0 4px; } .pa-ft-bar i:last-child { background: var(--ui-danger); border-radius: 0 4px 4px 0; }
.pa-ft-bar i:only-child { border-radius: 4px; }
.pa-ft-num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.pa-ft-num span + span { margin-left: .5em; }
.pa-ft-narrow .pa-ft-note { display: none; }
.pa-ft-narrow .pa-ft-row { column-gap: 6px; padding-right: 4px; }
.pa-ft-narrow .pa-ft-name { gap: 4px; }
`);

function validate(d) {
  check.object(d, 'data', ['unit', 'files']);
  const seen = new Set();
  const files = each(d.files, 'data.files', { max: MAX_FILES }, (f, p) => {
    check.object(f, p, ['path', 'added', 'removed', 'status', 'note']);
    const path = check.string(f.path, `${p}.path`, { max: PATH_MAX }).replace(/^\.?\/+/, '').replace(/\/+$/, '');
    if (!path) throw new AssetError(`${p}.path must name a file, e.g. "src/app.ts"`);
    if (seen.has(path)) throw new AssetError(`${p}.path "${path}" is listed twice: merge the counts into one entry`);
    seen.add(path);
    const status = check.oneOf(f.status, `${p}.status`, STATUSES, { optional: true });
    const added = check.number(f.added, `${p}.added`, { min: 0, optional: true });
    const removed = check.number(f.removed, `${p}.removed`, { min: 0, optional: true });
    return { path, status, added, removed, note: check.string(f.note, `${p}.note`, { max: NOTE_MAX, optional: true }) };
  });
  return { unit: check.string(d.unit, 'data.unit', { max: UNIT_MAX, optional: true }) ?? '', files };
}

// ---- tree --------------------------------------------------------------------------------------------------------------------------
/** Directory tree with folder totals: {name, path, dir, kids[], added, removed, count}. */
export function buildTree(files) {
  const root = { name: '', path: '', dir: true, kids: [], added: 0, removed: 0, count: 0 };
  for (const f of files) {
    const parts = f.path.split('/');
    let cur = root;
    parts.forEach((name, i) => {
      const last = i === parts.length - 1;
      const path = parts.slice(0, i + 1).join('/');
      let nx = cur.kids.find((k) => k.name === name && k.dir === !last);
      if (!nx) { nx = last ? { name, path, dir: false, file: f, added: f.added ?? 0, removed: f.removed ?? 0, count: 1 } : { name, path, dir: true, kids: [], added: 0, removed: 0, count: 0 }; cur.kids.push(nx); }
      if (!last) { nx.added += f.added ?? 0; nx.removed += f.removed ?? 0; nx.count++; }
      cur = nx;
    });
  }
  const order = (n) => { if (!n.dir) return; n.kids.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name, SORT_LOCALE) : a.dir ? -1 : 1)); n.kids.forEach(order); };
  order(root);
  for (const k of root.kids) { root.added += k.added; root.removed += k.removed; root.count += k.count; }
  return root;
}

const rowsOf = (node, open, depth = 0, out = []) => {
  for (const k of node.kids) { out.push({ n: k, depth }); if (k.dir && open.has(k.path)) rowsOf(k, open, depth + 1, out); }
  return out;
};
const folders = (node, out = []) => { for (const k of node.kids) if (k.dir) { out.push(k); folders(k, out); } return out; };
const maxChurn = (node) => Math.max(1, ...node.kids.map((k) => Math.max(k.added + k.removed, k.dir ? maxChurn(k) : 0)));

// ---- drawing -----------------------------------------------------------------------------------------------------------------------
const openState = new WeakMap(); // data -> Set of open folder paths, so a resize does not undo the user's clicks

function rowEl(n, depth, top, narrow, toggle, open) {
  const churn = n.added + n.removed;
  const share = churn / top;
  const f = n.file;
  const cls = ['pa-ft-row', n.dir ? 'pa-ft-dir' : '', f?.status === 'deleted' ? 'pa-ft-gone' : '', f?.status === 'untouched' ? 'pa-ft-idle' : ''].filter(Boolean).join(' ');
  const name = h('span.pa-ft-name', Array.from({ length: depth }, () => h('span.pa-ft-g', { style: { width: `${narrow ? INDENT_NARROW : INDENT}px` } })));
  if (n.dir) {
    const btn = h('button.pa-ft-tog' + (open ? '.pa-ft-open' : ''), { type: 'button', 'aria-expanded': String(open), onclick: () => toggle(n.path) }, h('span.pa-ft-chev'), h('span.pa-ft-lbl', `${n.name}/`));
    btn.dataset.path = n.path;
    name.append(btn);
    name.append(h('span.pa-ft-note', `${n.count} file${n.count === 1 ? '' : 's'}`));
  } else {
    name.append(h('span.pa-ft-dot'), h('span.pa-ft-lbl', n.name));
    if (f.status === 'new') name.append(h('span.pa-ft-badge.pa-ft-new', 'new'));
    if (f.status === 'deleted') name.append(h('span.pa-ft-badge.pa-ft-rm', 'deleted'));
    if (f.note) name.append(h('span.pa-ft-note', f.note));
  }
  const w = narrow ? BAR_W_NARROW : BAR_W;
  const bar = h('span.pa-ft-bar', { style: { width: `${churn ? Math.round(w * clamp(share, MIN_BAR_SHARE, 1)) : 0}px` } });
  if (churn) {
    if (n.added) bar.append(h('i', { style: { flex: String(n.added) } }));
    if (n.removed) bar.append(h('i', { style: { flex: String(n.removed) } }));
  }
  const num = h('span.pa-ft-num', churn ? [n.added ? h('span.pa-ft-add', `+${fmt(n.added)}`) : null, n.removed ? h('span.pa-ft-del', `-${fmt(n.removed)}`) : null] : h('span.pa-m', { style: { color: 'var(--ui-dim)' } }, '–'));
  const row = h('div', { class: cls, role: 'treeitem', 'aria-level': String(depth + 1), style: { background: churn ? heat(share * ROW_HEAT_SCALE) : '', '--ft-bar': `${w}px` } },
    h('span.pa-ft-heat', { style: { background: churn ? heat(share) : 'transparent' } }), name, bar, num);
  if (n.dir) row.setAttribute('aria-expanded', String(open));
  row.title = `${n.path}${f?.note ? ` - ${f.note}` : ''}: +${n.added} -${n.removed}`;
  return row;
}

function drawFiletree({ data, root, fs, narrow, fill }) {
  const tree = buildTree(data.files);
  const top = maxChurn(tree);
  if (!openState.has(data)) {
    const all = folders(tree);
    const rows = data.files.length + all.length;
    openState.set(data, new Set(all.filter((f) => rows <= COLLAPSE_ABOVE || f.path.split('/').length <= COLLAPSE_FROM_DEPTH).map((f) => f.path)));
  }
  const open = openState.get(data);
  const list = h('div', { role: 'tree' });
  const wrap = h('div.pa-ft' + (fill ? '.pa-ft-fill' : '') + (narrow ? '.pa-ft-narrow' : ''), { style: { fontSize: `${fs}px` } },
    h('div.pa-ft-sum', h('b', `${data.files.length} file${data.files.length === 1 ? '' : 's'}`), h('span.pa-ft-add', `+${fmt(tree.added)}`), h('span.pa-ft-del', `-${fmt(tree.removed)}`), data.unit ? h('span', data.unit) : null), list);
  const paint = (focusPath) => {
    list.replaceChildren(...rowsOf(tree, open).map(({ n, depth }) => rowEl(n, depth, top, narrow, toggle, n.dir && open.has(n.path))));
    if (focusPath) [...list.querySelectorAll('button')].find((b) => b.dataset.path === focusPath)?.focus();
  };
  function toggle(path) { if (open.has(path)) open.delete(path); else open.add(path); paint(path); }
  paint();
  root.replaceChildren(wrap);
}

export const filetree = defineAsset({
  kind: 'filetree',
  shape: 'where a change landed in the code structure (which folders and files carry the churn, what is new or deleted)',
  summary: 'A collapsible directory tree: heat gutter and row tint by churn, a tiny added/removed bar, +N -N counts, folder totals, badges for new/deleted files.',
  keys: ['unit', 'files'],
  html: true,
  sample: {
    unit: 'lines',
    files: [
      { path: 'web/kit/assets/hierarchy.js', added: 262, removed: 0, status: 'new', note: 'treemap, sunburst, icicle' },
      { path: 'web/kit/assets/filetree.js', added: 150, removed: 0, status: 'new' },
      { path: 'web/kit/assets/venn.js', added: 241, removed: 2, status: 'new' },
      { path: 'web/kit/assets/index.js', added: 4, removed: 4 },
      { path: 'web/kit/assets/core.js' },
      { path: 'web/kit/d3/d3.mjs', status: 'untouched' },
      { path: 'web/assets.test.mjs', added: 18, removed: 3 },
      { path: 'hooks/board-frames.ts', added: 42, removed: 11, note: 'viz frame cap' },
      { path: 'hooks/legacy-widgets.ts', added: 0, removed: 96, status: 'deleted' },
      { path: 'scripts/render-assets-catalog.mjs', added: 7, removed: 1 },
      { path: 'README.md', added: 2, removed: 0 },
    ],
  },
  validate,
  draw: drawFiletree,
});
