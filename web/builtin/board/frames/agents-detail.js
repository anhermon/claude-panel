// agents-detail: the part of an agent row (frames/lanes.js) that says what the agent is REALLY doing, from lane.insight
// (hooks/agent-insight.ts): a kind pill (glyph + label, in the kind's color), the headline sentence ("Writing UI · board.css"),
// the activity strip (one cell per time bucket, colored by what the agent mostly did; its length is the agent's duration
// relative to the longest one), the duration and the tokens it used (the headline figures), a thin mix bar (what share of its
// last minutes went to which kind), up to 3 file chips (basenames) and a feed of its last actions in plain words. Never a shell
// command. Rows without an insight (lanes the model posted by hand) look as before. The styles are agents-detail.css, loaded with this module.
import { capText } from '../board-logic.mjs';
import { callsLabel } from '../lane-format.mjs';
import { barShare, formatDuration, formatTokens, liveKind, stripKinds } from '../insight-logic.mjs';
import { kindMeta } from '../kind-meta.mjs';
import { h } from './dom.js';

const CSS_URL = new URL('./agents-detail.css', import.meta.url).href;
const CSS_WAIT_MS = 1500; // a stylesheet that never reports is not waited for
const FEED_JOIN = ' · ';
const FEED_MIN_PHRASES = 1;
const FILE_CHIP_CHARS = 28;

/** Loads agents-detail.css once. Awaited at the top level so the first fit measures styled rows. */
async function loadCss() {
  if (typeof document === 'undefined' || document.querySelector('link[data-agents-detail]')) return;
  const link = h('link', { rel: 'stylesheet', href: CSS_URL, 'data-agents-detail': '' });
  const loaded = new Promise((done) => { link.onload = done; link.onerror = done; });
  document.head.append(link);
  await Promise.race([loaded, new Promise((done) => setTimeout(done, CSS_WAIT_MS))]);
}
await loadCss();

/** The nodes an agent row adds to the ones lanes.js builds: the headline, the figures (in the meta line), the mix bar and the files + feed block. */
export function buildInsight() {
  return {
    head: h('p', { class: 'lane-head' }, h('i', { class: 'kg' }), h('span', { class: 'kt' })),
    tokens: h('span', { class: 'lane-tokens' }),
    mix: h('div', { class: 'lane-mix' }),
    block: h('div', { class: 'lane-ins' }, h('div', { class: 'lane-files' }), h('p', { class: 'lane-feed' })),
  };
}

const colorOf = (kind) => `--kc:${kindMeta(kind).color}`;

function paintStrip(fill, strip) {
  if (fill.dataset.strip === strip) return;
  fill.dataset.strip = strip;
  fill.replaceChildren(...stripKinds(strip).map((kind) => h('s', { 'data-k': kind, style: kind === 'none' ? null : colorOf(kind) })));
}

function paintMix(box, mix) {
  const key = mix.map((m) => `${m.kind}${m.pct}`).join(' ');
  if (box.dataset.key === key) return;
  box.dataset.key = key;
  box.replaceChildren(...mix.map((m) => h('s', { style: `${colorOf(m.kind)};flex:${m.pct} 1 0`, title: `${kindMeta(m.kind).label} ${m.pct}%` })));
}

function paintFiles(box, files) {
  const key = files.join('\n');
  if (box.dataset.key === key) return;
  box.dataset.key = key;
  box.replaceChildren(...files.map((name) => h('code', { class: 'file-chip', text: capText(name, FILE_CHIP_CHARS) })));
}

/**
 * Fill the insight of one row. `ctx`: { now, durationMs (this row's), maxMs (the longest agent's) }. A row without an insight
 * is marked data-insight="false" and shows nothing of it.
 */
export function fillInsight(row, lane, ctx) {
  const insight = lane.insight;
  row.dataset.insight = insight ? 'true' : 'false';
  if (!insight) { row.removeAttribute('title'); return; }
  row.title = callsLabel(lane.calls) ? `${callsLabel(lane.calls)} so far` : '';
  const { kind, headline } = liveKind(insight, lane.state, ctx.now);
  const meta = kindMeta(kind);
  row.dataset.kind = kind;
  row.style.setProperty('--kc', meta.color);
  const chip = row.querySelector('.chip');
  chip.textContent = `${meta.glyph} ${meta.label}`;
  chip.dataset.kind = kind;
  row.querySelector('.kg').textContent = meta.glyph;
  row.querySelector('.kt').textContent = headline;
  const fill = row.querySelector('.lane-bar > i');
  paintStrip(fill, insight.strip);
  fill.style.width = `${Math.round(barShare(ctx.durationMs, ctx.maxMs, insight.isMain) * 100)}%`;
  row.querySelector('.lane-tokens').textContent = formatTokens(insight.tokens);
  paintMix(row.querySelector('.lane-mix'), insight.mix);
  paintFiles(row.querySelector('.lane-files'), insight.files);
  const feed = row.querySelector('.lane-feed');
  feed.dataset.empty = insight.feed.length === 0 ? 'true' : 'false';
  fitFeed(feed, insight.feed);
}

/** Fit the feed line with whole phrases only (never one cut mid-word): drop the oldest first. */
function fitFeed(feed, phrases) {
  for (let n = phrases.length; n >= FEED_MIN_PHRASES; n--) {
    feed.textContent = phrases.slice(0, n).join(FEED_JOIN);
    if (feed.clientWidth === 0 || feed.scrollWidth <= feed.clientWidth) return;
  }
}

/** The duration a row shows: "3 min 20 s" (frozen at its last sign of life when the agent is done). */
export const durationLabel = (ms) => formatDuration(ms);
