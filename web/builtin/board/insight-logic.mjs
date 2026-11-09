// Pure logic of the agent rows' insight (frames/agents-detail.js): normalising what the mod sent (hooks/agent-insight.ts), and
// the wording and arithmetic of the row: duration, tokens, the strip's cells, how long a bar is. No DOM, no clock of its own.
// Tested by insight-logic.test.mjs.

import { isKind, KIND_META, KIND_IDS, kindOfLetter, STRIP_NONE, WORK_KIND_IDS } from './kind-meta.mjs';

/** Kinds in which an agent is making calls: with no call for THINK_AFTER_MS (and none in flight) the page shows `thinking` instead. */
const ACTIVE_KINDS = new Set(WORK_KIND_IDS);
export const THINK_AFTER_MS = 20_000; // keep in step with INSIGHT_CAPS.THINK_AFTER_MS in hooks/agent-insight.ts
export const INSIGHT_CAPS = Object.freeze({ strip: 48, files: 3, file: 28, feed: 3, phrase: 40, headline: 60, mix: 12 });
/** A bar never gets shorter than this share of the longest one: the strip must stay readable. */
export const MIN_BAR_SHARE = 0.3;
const PCT_MAX = 100;

const MS_SEC = 1000;
const SEC_MIN = 60;
const MIN_HOUR = 60;
const TOKENS_K = 1000;
const TOKENS_M = 1_000_000;
const TOKENS_ONE_DECIMAL_BELOW = 10_000;
const STRIP_LETTERS = new Set([...KIND_IDS.map((k) => KIND_META[k].letter), STRIP_NONE]);

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const cut = (v, max) => {
  const s = typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '';
  return s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
};
const strings = (v, count, max) => (Array.isArray(v) ? v.slice(0, count).map((s) => cut(s, max)).filter((s) => s !== '') : []);

const validStrip = (v) => typeof v === 'string' && v.length <= INSIGHT_CAPS.strip && [...v].every((c) => STRIP_LETTERS.has(c));

/** The mix: [{ kind, pct }], only known kinds with a share from 1 to 100, largest first as sent. */
function normalizeMix(v) {
  if (!Array.isArray(v)) return [];
  return v.slice(0, INSIGHT_CAPS.mix)
    .filter((m) => isObj(m) && isKind(m.kind) && typeof m.pct === 'number' && Number.isFinite(m.pct) && m.pct >= 1 && m.pct <= PCT_MAX)
    .map((m) => ({ kind: m.kind, pct: Math.round(m.pct) }));
}

/** Whatever the data file holds under `insight` -> a clean insight, or undefined (the row then looks as it always did). Never throws. */
export function normalizeInsight(raw) {
  if (!isObj(raw) || !isKind(raw.kind)) return undefined;
  return {
    kind: raw.kind,
    headline: cut(raw.headline, INSIGHT_CAPS.headline) || KIND_META[raw.kind].headline,
    strip: validStrip(raw.strip) ? raw.strip : '',
    mix: normalizeMix(raw.mix),
    files: strings(raw.files, INSIGHT_CAPS.files, INSIGHT_CAPS.file),
    feed: strings(raw.feed, INSIGHT_CAPS.feed, INSIGHT_CAPS.phrase),
    tokens: typeof raw.tokens === 'number' && Number.isFinite(raw.tokens) && raw.tokens > 0 ? Math.round(raw.tokens) : null,
    lastCallAt: typeof raw.lastCallAt === 'number' && Number.isFinite(raw.lastCallAt) ? raw.lastCallAt : 0,
    isBusy: raw.isBusy === true,
    isMain: raw.isMain === true,
  };
}

/** 42_000 -> "42 s", 200_000 -> "3 min 20 s", 180_000 -> "3 min", 7_500_000 -> "2 h 05 min"; no usable duration -> ''. */
export function formatDuration(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '';
  const total = Math.floor(ms / MS_SEC);
  if (total < SEC_MIN) return `${total} s`;
  const minutes = Math.floor(total / SEC_MIN);
  if (minutes < MIN_HOUR) {
    const seconds = total % SEC_MIN;
    return seconds === 0 ? `${minutes} min` : `${minutes} min ${seconds} s`;
  }
  return `${Math.floor(minutes / MIN_HOUR)} h ${String(minutes % MIN_HOUR).padStart(2, '0')} min`;
}

/** 42_400 -> "42k tokens", 4_250 -> "4.3k tokens", 850 -> "850 tokens", 1_200_000 -> "1.2M tokens"; unknown (null) -> ''. */
export function formatTokens(n) {
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return '';
  if (n < TOKENS_K) return `${Math.round(n)} tokens`;
  if (n < TOKENS_ONE_DECIMAL_BELOW) return `${(Math.round(n / (TOKENS_K / 10)) / 10).toString()}k tokens`;
  if (Math.round(n / TOKENS_K) < TOKENS_K) return `${Math.round(n / TOKENS_K)}k tokens`;
  return `${(Math.round(n / (TOKENS_M / 10)) / 10).toString()}M tokens`;
}

/** The kind and headline to show now: a stale kind of work (no call for THINK_AFTER_MS, none in flight, agent not finished) is `thinking`. */
export function liveKind(insight, laneState, now) {
  const stale = ACTIVE_KINDS.has(insight.kind) && laneState !== 'done' && !insight.isBusy && insight.lastCallAt > 0 && now - insight.lastCallAt > THINK_AFTER_MS;
  return stale ? { kind: 'thinking', headline: KIND_META.thinking.headline } : { kind: insight.kind, headline: insight.headline };
}

/** The strip's letters as kinds, one per bucket ('none' for an empty or unknown one; '' -> no cells). */
export const stripKinds = (strip) => [...strip].map((c) => kindOfLetter(c));

/** How long a row's bar is, 0..1: its duration relative to the longest agent's (the main loop is the whole session: always full), never below MIN_BAR_SHARE. */
export function barShare(ms, maxMs, isMain) {
  if (isMain || !(maxMs > 0) || typeof ms !== 'number') return 1;
  return Math.min(1, Math.max(MIN_BAR_SHARE, ms / maxMs));
}
