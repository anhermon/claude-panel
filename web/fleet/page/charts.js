// The three small charts of the drill-down, each its own visual form: bars over time (tokens), a ranked list (tools) and one
// stacked bar (kind of work). DOM built with the kit's `h` (text nodes only). Colours are the kit's --ui-* tokens and the
// board's KIND_META colours, so the fleet and the board read the same.
import { h } from './kit/ui/core.js';
import { KIND_META } from './kind-meta.js';
import { count, pct } from './format.js';
import { topEntries } from './model.js';

const W = 320;
const HEIGHT = 96;
const PAD_TOP = 14;
const PAD_BOTTOM = 16;
const GAP = 1;
const MIN_BUCKETS = 2;
const TOOL_ROWS = 8;
const hhmm = (t) => new Date(t).toLocaleTimeString([], { hourCycle: 'h23', hour: '2-digit', minute: '2-digit' });
const empty = (text) => h('p.fl-empty', text);

/** Output vs new input tokens per time bucket as stacked bars; the x axis names the first and last bucket. */
export function tokensChart(buckets, bucketMs) {
  if (!Array.isArray(buckets) || buckets.length < MIN_BUCKETS) return empty('Not enough history in the part of the transcript read so far.');
  const from = buckets[0].t;
  const slots = Math.round((buckets[buckets.length - 1].t - from) / bucketMs) + 1;
  const byT = new Map(buckets.map((b) => [b.t, b]));
  const peak = Math.max(1, ...buckets.map((b) => b.out + b.in + b.cacheWrite));
  const bw = Math.max(2, (W - GAP * slots) / slots);
  const plot = HEIGHT - PAD_TOP - PAD_BOTTOM;
  const bars = [];
  for (let i = 0; i < slots; i++) {
    const b = byT.get(from + i * bucketMs);
    if (b === undefined) continue;
    const fresh = b.in + b.cacheWrite;
    const hOut = (b.out / peak) * plot;
    const hIn = (fresh / peak) * plot;
    const x = i * (bw + GAP);
    bars.push(h('rect', { x, y: HEIGHT - PAD_BOTTOM - hOut, width: bw, height: hOut, fill: 'var(--ui-c1)' }, h('title', `${hhmm(b.t)}: ${count(b.out)} output tokens, ${count(fresh)} new input tokens`)));
    bars.push(h('rect', { x, y: HEIGHT - PAD_BOTTOM - hOut - hIn, width: bw, height: hIn, fill: 'var(--ui-c2)' }));
  }
  const label = (x, anchor, text) => h('text', { x, y: HEIGHT - 3, 'text-anchor': anchor, class: 'fl-axis' }, text);
  return h('div.fl-chart',
    h('svg', { viewBox: `0 0 ${W} ${HEIGHT}`, role: 'img', 'aria-label': `Tokens per ${Math.round(bucketMs / 60000)} minutes, peak ${count(peak)}` },
      h('text', { x: 0, y: 9, class: 'fl-axis' }, `peak ${count(peak)} tokens per ${Math.round(bucketMs / 60000)} min`),
      h('line', { x1: 0, x2: W, y1: HEIGHT - PAD_BOTTOM, y2: HEIGHT - PAD_BOTTOM, stroke: 'var(--ui-line-hi)' }),
      bars, label(0, 'start', hhmm(from)), label(W, 'end', hhmm(from + (slots - 1) * bucketMs))),
    h('p.fl-legend', h('span.fl-key', { style: { '--k': 'var(--ui-c1)' } }, 'output tokens'), h('span.fl-key', { style: { '--k': 'var(--ui-c2)' } }, 'new input tokens')));
}

/** Ranked horizontal bars of tool names with their call counts. */
export function toolMix(byName) {
  const rows = topEntries(byName, TOOL_ROWS);
  if (rows.length === 0) return empty('No tool calls in the part of the transcript read so far.');
  const max = Math.max(...rows.map((r) => r.count));
  return h('ol.fl-rank', rows.map((r) => h('li', h('span.fl-rank-name', { title: r.name }, r.name), h('span.fl-rank-bar', h('i', { style: { width: `${pct(r.count, max)}%` } })), h('b', r.count))));
}

/** One stacked bar: the share of tool calls per kind of work, with a legend that names every share. */
export function kindBar(byKind) {
  const entries = Object.entries(byKind ?? {}).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  const total = entries.reduce((s, [, n]) => s + n, 0);
  if (total === 0) return empty('No classifiable tool calls yet.');
  const meta = (k) => KIND_META[k] ?? KIND_META.working;
  return h('div.fl-kinds',
    h('div.fl-stack', { role: 'img', 'aria-label': 'Share of tool calls by kind of work' }, entries.map(([k, n]) => h('i', { style: { width: `${pct(n, total)}%`, background: meta(k).color }, title: `${meta(k).label}: ${n} calls` }))),
    h('ul.fl-legend-list', entries.map(([k, n]) => h('li', h('span.fl-key', { style: { '--k': meta(k).color } }, meta(k).label), h('b', `${pct(n, total)}%`), h('small', `${n} calls`)))));
}
