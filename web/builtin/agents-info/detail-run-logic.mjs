import { plainTitle } from '../../kit/panel/plain-title.mjs';
// The detail of a run of another harness that has no transcript (hooks/agent-detail-run.ts): live/detail.json's `run` -> clean data, and the
// rows of its fact list. Pure, no DOM; tested by detail-run-logic.test.mjs. What the record does not hold is listed in `absent`, in the harness's terms.
import { cut, formatTokens } from './agents-info-logic.mjs';

export const RUN_CAPS = Object.freeze({ word: 40, title: 120, line: 240, text: 4000, absent: 8, harness: 16, model: 28, effort: 8 });
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
const keepText = (v, max) => (typeof v === 'string' ? v.replace(/\r/g, '').trim().slice(0, max) : '');
const orNull = (s) => (s === '' ? null : s);
const PROMPT_SOURCES = Object.freeze(['file', 'head']);

/** live/detail.json's `run` -> clean data, or null when it is not one. Never throws. */
export function normalizeRun(raw) {
  if (!isObj(raw) || typeof raw.status !== 'string') return null;
  const prompt = isObj(raw.prompt) && keepText(raw.prompt.text, RUN_CAPS.text) !== '' ? { text: keepText(plainTitle(raw.prompt.text, false), RUN_CAPS.text), source: PROMPT_SOURCES.includes(raw.prompt.source) ? raw.prompt.source : 'head' } : null;
  return {
    harness: cut(raw.harness, RUN_CAPS.harness),
    status: cut(raw.status, RUN_CAPS.word) || 'Unknown',
    recordStatus: orNull(cut(raw.recordStatus, RUN_CAPS.word)),
    isNotStarted: raw.isNotStarted === true,
    startedAt: num(raw.startedAt),
    endedAt: num(raw.endedAt),
    model: orNull(cut(raw.model, RUN_CAPS.model)),
    effort: orNull(cut(raw.effort, RUN_CAPS.effort)),
    title: cut(plainTitle(raw.title, false), RUN_CAPS.title),
    verdict: orNull(cut(raw.verdict, RUN_CAPS.line)),
    tokens: num(raw.tokens),
    reason: orNull(cut(raw.reason, RUN_CAPS.line)),
    prompt,
    result: orNull(keepText(raw.result, RUN_CAPS.text)),
    absent: (Array.isArray(raw.absent) ? raw.absent : []).filter((s) => typeof s === 'string' && s !== '').slice(0, RUN_CAPS.absent).map((s) => cut(s, RUN_CAPS.line)),
  };
}

/** "Codex", "Agy": the harness's own name, capitalised ('' when none). */
export const harnessWord = (h) => (h === '' ? '' : h[0].toUpperCase() + h.slice(1));

/** The rows of the fact list, `[label, value]`, only those the record holds; `clock(ms)` writes a time. Status first, then when, which model, what it was told, how it ended. */
export function factsOf(run, clock) {
  const rows = [['Status', run.recordStatus && run.recordStatus.toLowerCase() !== run.status.toLowerCase() ? `${run.status} (${run.recordStatus})` : run.status]];
  if (run.startedAt !== null) rows.push([run.isNotStarted ? 'Tried at' : 'Started', clock(run.startedAt)]);
  if (run.endedAt !== null && !run.isNotStarted) rows.push(['Ended', clock(run.endedAt)]);
  const model = [run.model, run.effort].filter(Boolean).join(':');
  if (model !== '') rows.push(['Model', model]);
  if (run.title !== '') rows.push(['Description', run.title]);
  if (run.verdict !== null) rows.push(['Verdict', run.verdict]);
  if (run.tokens !== null) rows.push(['Tokens', formatTokens(run.tokens) || '0']);
  if (run.reason !== null) rows.push([run.isNotStarted ? 'Why it did not start' : 'Reason', run.reason]);
  return rows;
}
