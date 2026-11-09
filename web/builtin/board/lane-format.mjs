// Pure helpers of the agent rows (frames/lanes.js): what a row says and how it is worded. No DOM, no clock of its own.

const MS_MIN = 60_000;
const MIN_HOUR = 60;
const HOUR_DAY = 24;

/** 90_000 -> "1 min", 7_500_000 -> "2 h 05 min"; under a minute "<1 min"; null when there is no usable duration. */
export function formatElapsed(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return null;
  const minutes = Math.floor(ms / MS_MIN);
  if (minutes < 1) return '<1 min';
  if (minutes < MIN_HOUR) return `${minutes} min`;
  const hours = Math.floor(minutes / MIN_HOUR);
  if (hours < HOUR_DAY) return `${hours} h ${String(minutes % MIN_HOUR).padStart(2, '0')} min`;
  return `${Math.floor(hours / HOUR_DAY)} d ${hours % HOUR_DAY} h`;
}

/** A running row counts up from its start; a finished (or idle) one shows how long it took. null without a start time. */
export function elapsedMs(lane, now) {
  if (!(lane.startedAt > 0)) return null;
  const end = lane.state === 'done' ? lane.updatedAt : now;
  return end > 0 ? Math.max(0, end - lane.startedAt) : null;
}

/** "12 calls" / "1 call"; '' when the row has no count. */
export const callsLabel = (calls) => (Number.isInteger(calls) && calls >= 0 ? `${calls} ${calls === 1 ? 'call' : 'calls'}` : '');

/** The row's headline: what the agent is after (goal), else its own label. */
export const laneTitle = (lane) => lane.goal || lane.label;

/** The row's progress: the posted pct, else the share of its checklist that is done, else null (unknown). */
export function lanePct(lane) {
  if (lane.pct !== null && lane.pct !== undefined) return lane.pct;
  const dod = Array.isArray(lane.dod) ? lane.dod : [];
  if (dod.length === 0) return null;
  return Math.round((dod.filter((d) => d.state === 'done').length / dod.length) * 100);
}
