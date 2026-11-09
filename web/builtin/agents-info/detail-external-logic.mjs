// The Metrics facts of a run of another harness (codex) that has a rollout (hooks/agent-detail-external.ts): live/detail.json's `external` ->
// clean data, and the rows the Metrics tab shows from it (the token split with its cache share, the context against the window, the rate
// limits, the cost). Pure, no DOM; tested by detail-external-logic.test.mjs. A figure the data does not hold stays null and says why.
import { cut, formatDuration, formatTokens } from './agents-info-logic.mjs';

export const EXTERNAL_CAPS = Object.freeze({ word: 40, reason: 200, eval: 200, what: 60 });
const PERCENT = 100;
const MIN_PER_HOUR = 60;
const HOURS_PER_DAY = 24;
const PLAN_WORDS = Object.freeze({ primary: '5-hour limit', secondary: 'weekly limit' });
const DAYS_WEEK = 7;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
const orNull = (s) => (s === '' ? null : s);

function normalizeTokens(raw) {
  if (!isObj(raw)) return null;
  const input = num(raw.input) ?? 0;
  const output = num(raw.output) ?? 0;
  if (input + output === 0) return null;
  return { input, fresh: num(raw.fresh) ?? input, cached: num(raw.cached) ?? 0, output, reasoning: num(raw.reasoning) ?? 0, total: num(raw.total) ?? output, cacheShare: num(raw.cacheShare) };
}

function normalizeWindow(raw) {
  return isObj(raw) && num(raw.usedPct) !== null ? { usedPct: Math.min(PERCENT, raw.usedPct), windowMinutes: num(raw.windowMinutes) } : null;
}

function normalizeProofFact(raw) {
  if (!isObj(raw) || !['pass', 'fail', 'none'].includes(raw.result)) return null;
  return { eval: cut(raw.eval, EXTERNAL_CAPS.eval), what: cut(raw.what, EXTERNAL_CAPS.what), result: raw.result };
}

/** live/detail.json's `external` -> clean data, or null when it is not one. Never throws. */
export function normalizeExternal(raw) {
  if (!isObj(raw) || typeof raw.harness !== 'string' || (raw.source !== 'rollout' && raw.source !== 'record')) return null;
  const rate = isObj(raw.rate) ? { plan: orNull(cut(raw.rate.plan, EXTERNAL_CAPS.word)), primary: normalizeWindow(raw.rate.primary), secondary: normalizeWindow(raw.rate.secondary), isReached: raw.rate.isReached === true } : null;
  return {
    harness: cut(raw.harness, EXTERNAL_CAPS.word),
    model: orNull(cut(raw.model, EXTERNAL_CAPS.word)),
    effort: orNull(cut(raw.effort, EXTERNAL_CAPS.word)),
    source: raw.source,
    isPartial: raw.isPartial === true,
    runMs: num(raw.runMs) ?? 0,
    taskMs: num(raw.taskMs),
    failed: num(raw.failed),
    tokens: normalizeTokens(raw.tokens),
    context: isObj(raw.context) && num(raw.context.peak) !== null ? { peak: raw.context.peak, window: num(raw.context.window), share: num(raw.context.share) } : null,
    rate: rate && (rate.primary || rate.secondary) ? rate : null,
    costReason: isObj(raw.cost) && raw.cost.isMeasured !== true ? cut(raw.cost.reason, EXTERNAL_CAPS.reason) || 'not recorded' : 'not recorded',
    reasoningHidden: num(raw.reasoningHidden) ?? 0,
    proof: normalizeProofFact(raw.proof),
  };
}

/** "27% of the 5-hour limit" for a rate window (its length in minutes names it: 300 -> 5-hour, 10080 -> weekly). */
export function windowWord(w, fallback) {
  if (w.windowMinutes === null) return fallback;
  const hours = w.windowMinutes / MIN_PER_HOUR;
  if (hours >= HOURS_PER_DAY * DAYS_WEEK) return 'weekly limit';
  if (hours >= HOURS_PER_DAY) return `${Math.round(hours / HOURS_PER_DAY)}-day limit`;
  return `${Math.max(1, Math.round(hours))}-hour limit`;
}

export const percentText = (share) => (share === null ? '' : `${Math.round(share * PERCENT)}%`);

/** The segments of the stacked token bar: fresh input, cached input, output (reasoning is part of the output), each with its share of the whole. */
export function tokenParts(t) {
  const whole = t.fresh + t.cached + t.output;
  if (whole <= 0) return [];
  const part = (key, label, n) => ({ key, label, n, text: formatTokens(n) || '0', share: n / whole });
  return [part('fresh', 'fresh input', t.fresh), part('cached', 'cached input', t.cached), part('out', 'output', t.output)].filter((p) => p.n > 0);
}

/** The labelled facts, `[label, value]`, only those the data holds, in the order a reader asks: model, task time, context, limits, cost. */
export function externalRows(e) {
  const rows = [];
  const model = [e.model, e.effort].filter(Boolean).join(':');
  if (model !== '') rows.push(['Model', model]);
  if (e.taskMs !== null) rows.push(['Task time', `${formatDuration(e.taskMs) || '0 s'} (as the harness counted it)`]);
  if (e.tokens !== null) {
    const t = e.tokens;
    const reasoning = t.reasoning > 0 ? `, ${formatTokens(t.reasoning)} of it reasoning` : '';
    rows.push(['Output', `${formatTokens(t.output) || '0'}${reasoning}`]);
    if (t.cacheShare !== null) rows.push(['Cache share', `${percentText(t.cacheShare)} of the input was re-read from cache`]);
  }
  if (e.context !== null) {
    const of = e.context.window === null ? '' : ` of a ${formatTokens(e.context.window)} window${e.context.share === null ? '' : ` (${percentText(e.context.share)})`}`;
    rows.push(['Peak context', `${formatTokens(e.context.peak)}${of}`]);
  }
  if (e.rate !== null) {
    for (const key of ['primary', 'secondary']) {
      const w = e.rate[key];
      if (w) rows.push([windowWord(w, PLAN_WORDS[key]).replace(/^./, (c) => c.toUpperCase()), `${Math.round(w.usedPct)}% used${e.rate.plan && key === 'primary' ? ` (${e.rate.plan} plan)` : ''}${e.rate.isReached ? ', reached' : ''}`]);
    }
  }
  rows.push(['Cost', `not measured: ${e.costReason}`]);
  if (e.reasoningHidden > 0) rows.push(['Thinking', `${e.reasoningHidden} reasoning step${e.reasoningHidden === 1 ? '' : 's'} kept only encrypted by the harness, so none is shown`]);
  if (e.isPartial) rows.push(['Coverage', 'only the end of a long rollout was read, so active time covers that part']);
  return rows;
}
