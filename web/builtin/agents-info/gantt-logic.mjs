// Pure logic of the agent gantt (no DOM, no clock of its own): the shared time window, where each agent's bar sits in it, the
// work-kind segments inside a bar, the axis ticks, the minimum bar width and the tooltip words. The window is computed from the
// SUBAGENTS, so a session that ran for a day never shrinks them to a tick: the main row is clipped to the window and says so.
// Tested by gantt-logic.test.mjs.
import { formatDuration } from './agents-info-logic.mjs';
import { figureState } from './avatar-model.mjs';
import { identLine } from './ident-logic.mjs';

const MS_MIN = 60_000;
const MS_HOUR = 3_600_000;
export const MODES = Object.freeze([
  { id: 'fit', label: 'Fit agents' },
  { id: 'hour', label: 'Last hour' },
  { id: 'session', label: 'Whole session' },
]);
export const DEFAULT_MODE = 'fit';
/** "Fit agents" never reaches back further than this: an older agent is clipped at the left edge with a chevron. */
export const MAX_FIT_WINDOW_MS = 6 * MS_HOUR;
/** The window while there is no subagent, and the span of "Last hour". */
export const EMPTY_WINDOW_MS = 30 * MS_MIN;
export const HOUR_WINDOW_MS = MS_HOUR;
/** The window is never shorter than this (an agent that just started would otherwise fill the track). */
export const MIN_WINDOW_MS = 5 * MS_MIN;
/** Breathing room before the earliest subagent start, as a share of the window. */
export const PAD_SHARE = 0.04;
/** A bar is never thinner than this many px (a very short agent stays visible), plus a dot at its start. */
export const MIN_BAR_PX = 12;
/** A bar narrower than this has no room for its duration inside or beside its end mark: the duration is written outside it. */
export const LABEL_FIT_PX = 64;
/** Axis labels are at least this far apart. */
export const MIN_TICK_PX = 72;
/** Half the width of a tick label: nearer than this to an edge, the label is anchored to that edge instead of centred. */
const LABEL_HALF_PX = 30;
/** Used while the track has no width yet (hidden, not laid out). */
export const FALLBACK_TRACK_PX = 320;
/** Windows longer than this are labelled with clock times, shorter ones with "-N min". */
export const CLOCK_ABOVE_MS = MS_HOUR;
/** Tick spacings in minutes: 1 min .. 12 h. */
export const TICK_STEPS_MIN = Object.freeze([1, 2, 5, 10, 15, 30, 60, 120, 180, 360, 720]);
export const NOW_LABEL = 'now';
const TOP_KINDS = 5;
const PERCENT = 100;
const SEP = ' · ';

const clockOnly = (t) => `${String(new Date(t).getHours()).padStart(2, '0')}:${String(new Date(t).getMinutes()).padStart(2, '0')}`;
const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();

/** "12:31", or "Mon 12:31" when it was not today. */
export const clockOf = (t, now = t) => (sameDay(t, now) ? clockOnly(t) : `${new Date(t).toLocaleDateString('en-US', { weekday: 'short' })} ${clockOnly(t)}`);

const subagents = (agents) => agents.filter((a) => !a.isMain);

/**
 * The shared window `{ start, end, span, mode, live }`; the start follows the mode (see the module comment). The end is now, except in
 * "Fit agents" when every subagent has finished: then it is the last end (plus a little room), so a team that is done is not squeezed
 * to the left of a track that runs on to now. `live` says the right edge is now (the axis calls it "now").
 */
export function windowOf(agents, now, mode = DEFAULT_MODE) {
  let start;
  let end = now;
  if (mode === 'hour') start = now - HOUR_WINDOW_MS;
  else if (mode === 'session') start = Math.min(now, ...agents.map((a) => a.startedAt));
  else {
    const subs = subagents(agents);
    if (subs.length === 0) start = now - EMPTY_WINDOW_MS;
    else {
      const first = Math.min(...subs.map((a) => a.startedAt));
      const last = Math.max(...subs.map((a) => a.endedAt ?? Infinity));
      if (last !== Infinity) end = Math.min(now, last + Math.max(MIN_WINDOW_MS, last - first) * PAD_SHARE);
      const span = Math.max(MIN_WINDOW_MS, end - first);
      start = Math.max(end - MAX_FIT_WINDOW_MS, end - span - span * PAD_SHARE);
    }
  }
  start = Math.min(start, end - MIN_WINDOW_MS);
  return { start, end, span: end - start, mode, live: end === now };
}

/**
 * Where an agent's bar sits in the window: `l` and `w` as shares of the track (0..1), `clipped` when it began before the window,
 * `outside` when it ended before it, `running` while it has no end. A finished agent ends at endedAt, a running one at the right edge.
 */
export function barOf(agent, win, now) {
  const from = agent.startedAt;
  const to = agent.endedAt ?? now;
  const a = Math.max(from, win.start);
  const b = Math.min(Math.max(to, a), win.end);
  return { l: (a - win.start) / win.span, w: (b - a) / win.span, clipped: from < win.start, outside: to < win.start, running: agent.endedAt === null };
}

/** The bar in px with the minimum width applied and kept inside the track: `{ left, width }`. */
export function placeBar(bar, trackPx) {
  const width = Math.min(trackPx, Math.max(MIN_BAR_PX, bar.w * trackPx));
  return { left: Math.min(bar.l * trackPx, trackPx - width), width };
}

/** Where the duration of a bar too narrow to hold it is written: null (the bar is wide enough), else 'right' of it or, with no room there, 'left'. `reserve`: px the end mark takes on the right. */
export function labelSideOf({ left, width }, trackPx, reserve = 0) {
  if (width >= LABEL_FIT_PX) return null;
  return left + width + reserve + LABEL_FIT_PX <= trackPx ? 'right' : 'left';
}

/**
 * The kind-of-work stretches inside the agent's bar, as shares of the bar (`l`, `w`) with their colour. A running agent's last stretch
 * runs to now. No stretches (a lane no loop backs): one stretch in the agent's own kind colour over the whole bar.
 */
export function segmentsIn(agent, win, now, kinds = {}) {
  const from = Math.max(agent.startedAt, win.start);
  const to = Math.min(agent.endedAt ?? now, win.end);
  const length = to - from;
  const colorOf = (k) => kinds[k]?.color ?? agent.kindColor;
  if (!(length > 0)) return [];
  const segs = agent.segs ?? [];
  if (segs.length === 0) return [{ k: agent.kind ?? 'working', l: 0, w: 1, color: agent.kindColor }];
  const out = [];
  segs.forEach((s, i) => {
    const end = agent.endedAt === null && i === segs.length - 1 ? Math.max(s.b, to) : s.b;
    const a = Math.max(s.a, from);
    const b = Math.min(end, to);
    if (b > a) out.push({ k: s.k, l: (a - from) / length, w: (b - a) / length, color: colorOf(s.k) });
  });
  return out;
}

/** Axis ticks `[{ frac, label, anchor }]`: clock times over an hour of window, "-N min" below it; the last one is "now". */
export function ticksOf(win, trackPx = FALLBACK_TRACK_PX) {
  const px = trackPx > 0 ? trackPx : FALLBACK_TRACK_PX;
  const room = Math.max(1, Math.floor(px / MIN_TICK_PX));
  const stepMin = TICK_STEPS_MIN.find((m) => win.span / (m * MS_MIN) <= room) ?? TICK_STEPS_MIN[TICK_STEPS_MIN.length - 1];
  const step = stepMin * MS_MIN;
  const anchorOf = (frac) => (frac * px < LABEL_HALF_PX ? 'start' : (1 - frac) * px < LABEL_HALF_PX ? 'end' : 'mid');
  const ticks = [];
  if (win.span > CLOCK_ABOVE_MS || win.live === false) {
    const offset = -new Date(win.start).getTimezoneOffset() * MS_MIN; // align to local clock multiples
    for (let t = Math.ceil((win.start + offset) / step) * step - offset; t < win.end; t += step) {
      const frac = (t - win.start) / win.span;
      if (frac <= 1 - MIN_TICK_PX / px) ticks.push({ frac, label: clockOnly(t), anchor: anchorOf(frac) });
    }
  } else {
    for (let k = Math.floor(win.span / step); k >= 1; k--) {
      const frac = 1 - (k * step) / win.span;
      if (frac >= 0 && frac <= 1 - MIN_TICK_PX / px) ticks.push({ frac, label: `-${k * stepMin} min`, anchor: anchorOf(frac) });
    }
  }
  ticks.push({ frac: 1, label: win.live === false ? clockOnly(win.end) : NOW_LABEL, anchor: 'end' });
  return ticks;
}

/** "started 24 h 37 min ago": the label of the chevron on a bar that begins before the window. */
export const chevronLabel = (agent, now) => `started ${formatDuration(now - agent.startedAt)} ago`;

/** How a bar ends: a check (done), a cross (failed), else nothing (still going, waiting or blocked). */
export function endMarkOf(agent) {
  if (agent.notStarted) return null;
  if (figureState(agent) === 'failed') return 'cross';
  return agent.state === 'done' ? 'check' : null;
}

/** Time per kind over the agent's whole run, largest first: `[{ k, pct }]`, at most TOP_KINDS. */
export function mixOf(agent, now) {
  const segs = agent.segs ?? [];
  const time = new Map();
  segs.forEach((s, i) => {
    const end = agent.endedAt === null && i === segs.length - 1 ? Math.max(s.b, now) : s.b;
    time.set(s.k, (time.get(s.k) ?? 0) + Math.max(0, end - s.a));
  });
  const total = [...time.values()].reduce((x, y) => x + y, 0);
  if (total <= 0) return [];
  return [...time].map(([k, ms]) => ({ k, pct: Math.round((ms / total) * PERCENT) })).filter((m) => m.pct > 0).sort((x, y) => y.pct - x.pct).slice(0, TOP_KINDS);
}

const NOT_STARTED_TIP = 'not started';
/** "started 12:31 · ended 12:48 · 17 min · Tests 40%, Logic 35%" (a running agent says "running" instead of the end). Never an id. */
export function tooltipOf(agent, now, kinds = {}) {
  if (agent.notStarted) return [identLine(agent), NOT_STARTED_TIP, agent.note, `tried ${clockOf(agent.startedAt, now)}`].filter(Boolean).join(SEP);
  const end = agent.endedAt === null ? 'running' : `ended ${clockOf(agent.endedAt, now)}`;
  const mix = mixOf(agent, now).map((m) => `${kinds[m.k]?.label ?? m.k} ${m.pct}%`).join(', ');
  return [identLine(agent), `started ${clockOf(agent.startedAt, now)}`, end, formatDuration((agent.endedAt ?? now) - agent.startedAt), mix].filter(Boolean).join(SEP);
}

/** The row's own words for its time span: "12:31 \u2192" while it runs, "12:31 \u2192 12:48" once it ended. */
export const spanOf = (agent, now) => (agent.notStarted ? `tried ${clockOf(agent.startedAt, now)}` : `${clockOf(agent.startedAt, now)} \u2192${agent.endedAt === null ? '' : ` ${clockOf(agent.endedAt, now)}`}`);
