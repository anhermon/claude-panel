// lanes: one row per agent, from data.lanes. Each row says WHAT the agent is doing and how far along it is: its goal (else
// its label, up to 2 lines), the step it is on (up to 2 lines), a progress bar with pct, a state pill, how long it has been
// running and, small and muted, how many tool calls it made. Rows with an insight (the mod's own agent rows) say what the
// agent is doing as well (frames/agents-detail.js): kind pill, headline sentence, activity strip, duration and tokens, mix, files, recent actions. Never a shell command. Working agents first (sortLanes), at
// most CAPS.lanes rows. The font is fitted to the frame (frames/fit.js); same lanes, new numbers: updated in place.
import { CAPS, capText } from '../board-logic.mjs';
import { callsLabel, elapsedMs, formatElapsed, laneTitle, lanePct } from '../lane-format.mjs';
import { h } from './dom.js';
import { buildInsight, fillInsight } from './agents-detail.js';
import { fitStack } from './fit.js';
import { formatDuration } from '../insight-logic.mjs';

const ACTIVE = new Set(['working', 'testing']);
const TICK_MS = 1000; // the "3 min 20 s" counters (and a kind going stale into "thinking") move on their own; the rest only on data
const FIT_SHARE = 0.09; // the biggest font is 9% of the frame width (it only gets there when the text still fits) ...
const FIT_MAX_TIMES = 3; // ... and 3x the text floor
const SPREAD_MAX_EM = 0.8;
const GROW_UP_TO_ROWS = 2; // one or two agents: the cards grow to fill the frame instead of floating in it
const TIGHT_MAX_TIMES = 1.3; // tighter wording never grows its font much: short rows with big type would only truncate
const COMPACT_MAX_TIMES = 1.15;
const FIT_LEVELS = [{ name: 'roomy' }, { name: 'tight', maxTimes: TIGHT_MAX_TIMES }, { name: 'compact', maxTimes: COMPACT_MAX_TIMES }]; // see board.css: 2-line wording, 1-line wording, one line each with a thin bar
const fits = new WeakMap(); // .lanes root -> { stop, refit }
const list = (f) => (Array.isArray(f.lanes) ? f.lanes.slice(0, CAPS.lanes) : []);

const setText = (el, text) => { if (el.textContent !== text) el.textContent = text; };

/** The longest duration among the agents (the main loop is the whole session and left out): the scale of the bars. */
function maxAgentMs(root, now) {
  let max = 0;
  for (const row of root.querySelectorAll('.lane')) if (!row.laneData.insight?.isMain) max = Math.max(max, elapsedMs(row.laneData, now) ?? 0);
  return max;
}

function paintTimes(row, now, maxMs = 0) {
  const ms = elapsedMs(row.laneData, now);
  setText(row.querySelector('.lane-time'), (row.laneData.insight ? formatDuration(ms ?? NaN) : formatElapsed(ms)) ?? '');
  fillInsight(row, row.laneData, { now, durationMs: ms ?? 0, maxMs });
}

function fill(row, lane) {
  row.laneData = lane;
  const pct = lanePct(lane);
  const bar = row.querySelector('.lane-bar');
  bar.dataset.state = lane.state;
  bar.dataset.indeterminate = pct === null ? 'true' : 'false';
  bar.dataset.active = ACTIVE.has(lane.state) ? 'true' : 'false';
  bar.firstChild.style.width = pct === null ? '' : `${pct}%`;
  row.dataset.state = lane.state;
  row.querySelector('.lane-title').textContent = capText(laneTitle(lane), CAPS.laneLabel);
  row.querySelector('.lane-step').textContent = lane.step || lane.note;
  row.querySelector('.lane-pct').textContent = pct === null ? '' : `${pct}%`;
  row.querySelector('.lane-calls').textContent = callsLabel(lane.calls);
  const chip = row.querySelector('.chip');
  chip.textContent = lane.state;
  chip.dataset.tone = lane.state;
  if (!lane.insight) { delete chip.dataset.kind; row.style.removeProperty('--kc'); }
}

function paintAll(root, now) {
  const maxMs = maxAgentMs(root, now);
  for (const row of root.querySelectorAll('.lane')) paintTimes(row, now, maxMs);
}

export function render(el, f, ctx) {
  const rows = list(f).map((lane) => {
    const insight = buildInsight();
    const row = h('div', { class: 'lane', 'data-id': lane.id },
      h('b', { class: 'lane-title' }),
      h('span', { class: 'chip' }),
      insight.head,
      h('p', { class: 'lane-step' }),
      h('div', { class: 'lane-meta' },
        h('div', { class: 'lane-bar' }, h('i')),
        h('span', { class: 'lane-pct' }), h('span', { class: 'lane-time' }), insight.tokens, h('span', { class: 'lane-calls' })),
      insight.mix,
      insight.block);
    fill(row, lane);
    return row;
  });
  const list$ = h('div', { class: 'lanes-list' }, rows);
  const root = h('div', { class: 'lanes', 'data-n': String(rows.length) }, list$);
  el.append(root);
  paintAll(root, Date.now());
  const stack = fitStack({ box: root, content: list$, share: FIT_SHARE, maxTimes: FIT_MAX_TIMES, maxSpreadEm: SPREAD_MAX_EM, levels: FIT_LEVELS, growUpTo: GROW_UP_TO_ROWS, clamped: '.lane-title, .lane-step, .lane-head', rows: () => root.querySelectorAll('.lane').length });
  fits.set(root, stack);
  const tick = setInterval(() => paintAll(root, Date.now()), TICK_MS);
  ctx.onDispose(() => { clearInterval(tick); stack.stop(); });
}

export function update(el, f) {
  const lanes = list(f);
  const rows = [...el.querySelectorAll('.lane')];
  if (rows.length !== lanes.length || rows.some((r, i) => r.dataset.id !== lanes[i].id)) return false;
  lanes.forEach((lane, i) => fill(rows[i], lane));
  paintAll(el.querySelector('.lanes'), Date.now());
  fits.get(el.querySelector('.lanes'))?.refit();
  return true;
}
