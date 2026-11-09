// Pure logic of the agent detail view (the drill-down of one agent): what the mod wrote to live/detail.json
// (hooks/agent-detail.ts) -> clean data, and the numbers the drawing needs (clock text, durations, the stacked bar of kinds, the
// token curve). No DOM, no clock of its own. Tested by detail-logic.test.mjs.
import { cut, formatDuration, formatTokens } from './agents-info-logic.mjs';
import { normalizeProgress, normalizeStruggles } from './detail-progress-logic.mjs';
import { normalizeExternal } from './detail-external-logic.mjs';
import { normalizeRun } from './detail-run-logic.mjs';

/** Names of the events the page sends the host (hooks/agents-info-scene.ts AGENT_EVENT / AGENT_CLOSE_EVENT). */
export const EVENT_AGENT = 'agent';
export const EVENT_CLOSE = 'agent-close';
export const DETAIL_URL = 'live/detail.json';
/** The tabs in order; the first is the one that opens (what the agent is doing and what is wrong comes before the raw transcript). */
export const TABS = Object.freeze(['progress', 'transcript', 'metrics', 'struggles']);
export const DEFAULT_TAB = TABS[0];
export const TAB_LABEL = Object.freeze({ progress: 'Progress', transcript: 'Transcript', metrics: 'Metrics', struggles: 'Struggles' });
export const TIMING = Object.freeze({
  /** The page repeats its request this often while a detail is open (the host forgets a request after 45 s). */
  heartbeatMs: 15_000,
  pollMs: 1000,
  /** A detail older than this is shown with a note. */
  staleMs: 25_000,
  /** No answer for this long after opening: say so instead of "loading". */
  noAnswerMs: 8000,
});
export const CAPS = Object.freeze({ entries: 400, text: 700, label: 90, error: 160, kinds: 9, tools: 8, files: 8, series: 48, maxPages: 8 });
const MAX_TEXT = CAPS.text;
const ENTRY_KINDS = Object.freeze(['say', 'user', 'think', 'tool']);
const COLOR = /^#[0-9a-fA-F]{6}$/;
const PERCENT = 100;
const MS_SEC = 1000;
const FAST_CALL_DECIMALS_BELOW_MS = 10_000;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const count = (v) => (num(v) !== null && v >= 0 ? Math.round(v) : 0);
const list = (v, max) => (Array.isArray(v) ? v.slice(0, max) : []);

function normalizeEntry(raw) {
  if (!isObj(raw) || !ENTRY_KINDS.includes(raw.kind) || num(raw.t) === null) return null;
  if (raw.kind === 'tool') {
    const error = typeof raw.error === 'string' ? cut(raw.error, CAPS.error) : null;
    const note = cut(raw.note, CAPS.error);
    return { t: raw.t, kind: 'tool', tool: cut(raw.tool, CAPS.label) || 'tool', label: cut(raw.label, CAPS.label), ms: num(raw.ms) !== null && raw.ms >= 0 ? raw.ms : null, error: error === '' && raw.error !== '' ? null : error, ...(note === '' ? {} : { note }) };
  }
  const text = cut(raw.text, MAX_TEXT);
  return text === '' ? null : { t: raw.t, kind: raw.kind, text };
}

const normalizeKind = (raw) => (isObj(raw) && typeof raw.kind === 'string' && num(raw.ms) !== null && raw.ms > 0
  ? { kind: cut(raw.kind, 12), label: cut(raw.label, 12) || cut(raw.kind, 12), color: typeof raw.color === 'string' && COLOR.test(raw.color) ? raw.color : '#64748b', ms: raw.ms }
  : null);

/** Whatever live/detail.json holds -> clean detail, or null when it is not one. Never throws. */
export function normalizeDetail(raw) {
  if (!isObj(raw) || typeof raw.id !== 'string' || raw.id === '' || !isObj(raw.transcript) || !isObj(raw.metrics)) return null;
  const t = raw.transcript;
  const m = raw.metrics;
  const tokens = isObj(m.tokens) ? m.tokens : {};
  return {
    id: cut(raw.id, 64),
    name: cut(raw.name, 40) || cut(raw.id, 40),
    isMain: raw.isMain === true,
    state: cut(raw.state, 12),
    startedAt: num(raw.startedAt) ?? 0,
    endedAt: num(raw.endedAt),
    updatedAt: num(raw.updatedAt) ?? 0,
    brief: cut(raw.brief, MAX_TEXT),
    run: normalizeRun(raw.run),
    external: normalizeExternal(raw.external),
    transcript: {
      isAvailable: t.isAvailable === true,
      reason: cut(t.reason, CAPS.error),
      isFromPulse: t.isFromPulse === true,
      entries: list(t.entries, CAPS.entries).map(normalizeEntry).filter((e) => e !== null),
      hasMore: t.hasMore === true,
      pages: Math.min(CAPS.maxPages, Math.max(1, count(t.pages) || 1)),
      isWhole: t.isWhole === true,
      fromT: num(t.fromT),
      toT: num(t.toT),
    },
    metrics: {
      elapsedMs: num(m.elapsedMs) ?? 0,
      activeMs: num(m.activeMs) ?? 0,
      idleMs: num(m.idleMs) ?? 0,
      calls: count(m.calls),
      errors: num(m.errors) === null ? null : count(m.errors),
      retries: num(m.retries) === null ? null : count(m.retries),
      tokens: {
        total: num(tokens.total) !== null && tokens.total > 0 ? Math.round(tokens.total) : null,
        series: list(tokens.series, CAPS.series).filter((p) => isObj(p) && num(p.t) !== null && num(p.tokens) !== null).map((p) => ({ t: p.t, tokens: p.tokens })),
        steps: count(tokens.steps),
        coveredFromT: num(tokens.coveredFromT),
      },
      kinds: list(m.kinds, CAPS.kinds).map(normalizeKind).filter((k) => k !== null),
      tools: list(m.tools, CAPS.tools).filter((x) => isObj(x) && typeof x.tool === 'string').map((x) => ({ tool: cut(x.tool, CAPS.label), n: count(x.n) })),
      files: list(m.files, CAPS.files).filter((x) => isObj(x) && typeof x.name === 'string').map((x) => ({ name: cut(x.name, CAPS.label), reads: count(x.reads), edits: count(x.edits) })),
    },
    struggles: normalizeStruggles(raw.struggles),
    progress: normalizeProgress(raw.progress),
  };
}

/** The host's request for an agent: `emit('agent', requestOf(id, pages))`. */
export const requestOf = (id, pages) => ({ id, pages: Math.min(CAPS.maxPages, Math.max(1, Math.floor(pages))) });

/**
 * What the detail pane should say about its data: 'ok' (the detail of the open agent), 'loading' (just opened, no answer yet), 'none' (no
 * answer for noAnswerMs: the host is not answering), 'stale' (an answer, but not refreshed for staleMs).
 */
export function fillState(detail, openId, now, openedAt) {
  if (detail !== null && detail.id === openId) return now - detail.updatedAt > TIMING.staleMs ? 'stale' : 'ok';
  return now - openedAt > TIMING.noAnswerMs ? 'none' : 'loading';
}

const pad = (n) => String(n).padStart(2, '0');
/** "14:02:07" in the viewer's time zone; unusable -> ''. */
export function clockOf(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return '';
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
/** "14:02" (no seconds). */
export const clockShort = (ms) => clockOf(ms).slice(0, 5);

/** A tool call's time: "<1 s", "1.4 s", "42 s", "3 min 20 s"; null -> ''. */
export function callTime(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '';
  if (ms < MS_SEC) return '<1 s';
  if (ms < FAST_CALL_DECIMALS_BELOW_MS) return `${(Math.round(ms / (MS_SEC / 10)) / 10).toString()} s`;
  return formatDuration(ms);
}

/** The stacked bar of kinds: each with its share of the TOTAL of the kinds' time, largest first; shares add up to 100 (the last absorbs rounding). */
export function kindBars(kinds) {
  const total = kinds.reduce((s, k) => s + k.ms, 0);
  if (total <= 0) return [];
  const sorted = [...kinds].sort((a, b) => b.ms - a.ms);
  let used = 0;
  return sorted.map((k, i) => {
    const pct = i === sorted.length - 1 ? Math.max(0, PERCENT - used) : Math.round((k.ms / total) * PERCENT);
    used += pct;
    return { ...k, pct };
  });
}

/** Whole-percent split of the run into working and idle/waiting; both 0 when the run has no length. */
export function activitySplit(m) {
  if (m.elapsedMs <= 0) return { activePct: 0, idlePct: 0 };
  const activePct = Math.min(PERCENT, Math.round((m.activeMs / m.elapsedMs) * PERCENT));
  return { activePct, idlePct: PERCENT - activePct };
}

/** The token curve as SVG path data inside a w x h box with a padding; null below two points. `max` is the last (highest) value. */
export function seriesPath(series, w, h, pad2) {
  if (series.length < 2) return null;
  const t0 = series[0].t;
  const span = Math.max(1, series[series.length - 1].t - t0);
  const max = Math.max(1, series[series.length - 1].tokens);
  const pts = series.map((p) => [pad2 + ((p.t - t0) / span) * (w - 2 * pad2), h - pad2 - (p.tokens / max) * (h - 2 * pad2)]);
  const fmt = (n) => Math.round(n * 10) / 10;
  const line = pts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${fmt(x)} ${fmt(y)}`).join(' ');
  const area = `${line} L${fmt(pts[pts.length - 1][0])} ${h - pad2} L${fmt(pts[0][0])} ${h - pad2} Z`;
  return { line, area, max, from: series[0].t, to: series[series.length - 1].t };
}

/** "3.1k tokens" etc.; unknown -> "not measured". */
export const tokensText = (n) => (n === null || n === undefined ? 'not measured' : `${formatTokens(n) || '0'} tokens`);

/** How much of the file the transcript caption can claim. */
export function coverageText(t) {
  if (!t.isAvailable || t.entries.length === 0) return '';
  const span = `${clockShort(t.fromT)}–${clockShort(t.toT)}`;
  return t.isWhole && !t.hasMore ? `The whole transcript, ${span}.` : `The latest part, ${span}; earlier entries can be loaded.`;
}

// ---- derived data for the Metrics tab (pure; the DOM files only draw it)

const TICKET_PREFIX = /^\s*T\d+\b[\s·:\-–—]*/i;
const MODEL_SUFFIX = /\s*\([^()]*\/[^()]*\)\s*$/;
/** A task name without its ticket id ("T63 · Fix x (sonnet/low)" -> "Fix x"); the id belongs in a tooltip only. */
const stripTicket = (text) => String(text ?? '').replace(MODEL_SUFFIX, '').replace(TICKET_PREFIX, '').trim();
export function plainTitle(text) {
  const s = stripTicket(text);
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const toolEntries = (d) => d.transcript.entries.filter((e) => e.kind === 'tool');

/** The span of the run: from the start (or the start of the part read) to the end / last sign of life. */
export function runSpan(d) {
  const tools = d.transcript.entries;
  const last = tools.length > 0 ? tools[tools.length - 1].t : 0;
  const to = d.endedAt ?? Math.max(d.updatedAt, last);
  const first = tools.length > 0 ? tools[0].t : to;
  const from = d.transcript.isWhole && d.startedAt > 0 ? d.startedAt : Math.min(first, to);
  return { from, to: Math.max(to, from + 1) };
}

/** Tool calls as positions across the run (0..1) and a failed flag: the numbers behind the calls-per-bucket sparkline. */
export function timelineTicks(d) {
  const { from, to } = runSpan(d);
  return toolEntries(d).map((e) => ({ pos: Math.min(1, Math.max(0, (e.t - from) / (to - from))), failed: Boolean(e.error) }));
}

/** Calls per bucket over the run (for the sparkline); [] with fewer than two calls. */
export function callBuckets(d, buckets = 16) {
  const ticks = timelineTicks(d);
  if (ticks.length < 2) return [];
  const out = new Array(buckets).fill(0);
  for (const t of ticks) out[Math.min(buckets - 1, Math.floor(t.pos * buckets))]++;
  return out;
}

/** The longest stretch with no entry (also since the last entry while running), or null with no entries. */
export function longestGap(d) {
  const ts = d.transcript.entries.map((e) => e.t);
  if (ts.length === 0) return null;
  const { from, to } = runSpan(d);
  const points = [from, ...ts, to];
  let best = { ms: 0, at: from };
  for (let i = 1; i < points.length; i++) if (points[i] - points[i - 1] > best.ms) best = { ms: points[i] - points[i - 1], at: points[i - 1] };
  return best;
}

const STEP_CAP = 60;
/** What the agent did last, in a few words; '' with nothing read. */
/** Bold / code marks of the agent's own markdown ("**1. Result: done.**") do not belong in a one-line step. */
const MARKDOWN_MARKS = /\*\*|__|`/g;
export function currentStep(d) {
  const e = d.transcript.entries[d.transcript.entries.length - 1];
  if (!e) return '';
  return cut(e.kind === 'tool' ? `${e.tool} ${stripTicket(e.label)}`.trim() : String(e.text ?? '').replace(MARKDOWN_MARKS, ''), STEP_CAP);
}

const FAIL_WARN = 0.1;
const FAIL_BAD = 0.25;
/** 'ok' | 'warn' | 'bad' for failed/total; 'none' with no calls or an unmeasured count. */
export function failureTone(errors, calls) {
  if (errors === null || calls <= 0) return 'none';
  if (errors === 0) return 'ok';
  return errors / calls >= FAIL_BAD ? 'bad' : errors / calls >= FAIL_WARN ? 'warn' : 'warn';
}

/** Why there are no tokens, in a few words. */
export function tokenReason(d) {
  if (!d.transcript.isAvailable) return 'no token data: agent has no transcript';
  return d.metrics.tokens.steps === 0 ? 'no token data: no model requests read' : 'too few requests to total';
}
