import { plainTitle } from '../../kit/panel/plain-title.mjs';
// Pure logic of the Progress and Struggles tabs: what the mod wrote (hooks/agent-progress.ts AgentProgress, hooks/agent-struggles.ts
// StruggleReport inside live/detail.json) -> clean data, and what the drawing needs (phase segments, checklist count, outcome words,
// the grouped struggle rows). No DOM, no clock of its own. A field the data lacks stays empty: nothing is invented here.
import { cut } from './agents-info-logic.mjs';

export const PCAPS = Object.freeze({ phases: 14, plan: 8, decisions: 5, issues: 12, folders: 8, names: 4, checks: 6, images: 6, quote: 260, title: 130, short: 90, item: 150, struggles: 12, calm: 6 });
export const PLAN_STATES = Object.freeze(['todo', 'doing', 'done', 'failed']);
export const PLAN_SOURCES = Object.freeze(['lane', 'brief', 'none']);
export const STRUGGLE_KINDS = Object.freeze(['failing-loop', 'edit-test-cycle', 'slow-call', 'idle-gap', 'wrong-turn']);
export const KIND_WORD = Object.freeze({ 'failing-loop': 'Failing loop', 'edit-test-cycle': 'Edit-test cycle', 'slow-call': 'Slow call', 'idle-gap': 'Idle gap', 'wrong-turn': 'Wrong turn' });
export const PHASE_KINDS = Object.freeze(['read', 'edit', 'tests', 'run', 'delegate', 'ask', 'other']);
export const ISSUE_KINDS = Object.freeze(['failure', 'question', 'deviation', 'wait']);
export const NOT_SHOWN = 'not shown yet';
/** A phase segment never gets less than this share of the bar; the others give up the difference. */
export const MIN_SEGMENT_PCT = 3;
/** A segment at least this wide carries its label; a narrower one is named in the list below the bar. */
export const LABEL_SEGMENT_PCT = 18;
const PERCENT = 100;
const MS_SEC = 1000;
const SEC_MIN = 60;
const MIN_HOUR = 60;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const count = (v) => (num(v) !== null && v >= 0 ? Math.round(v) : 0);
const list = (v, max) => (Array.isArray(v) ? v.slice(0, max) : []);
const pick = (v, allowed, fallback) => (allowed.includes(v) ? v : fallback);
const text = (v, max) => cut(v, max);

function normalizePhase(raw) {
  if (!isObj(raw) || num(raw.a) === null || num(raw.b) === null || raw.b < raw.a) return null;
  return { label: text(plainTitle(raw.label, false), PCAPS.short) || 'work', kind: pick(raw.kind, PHASE_KINDS, 'other'), a: raw.a, b: raw.b, ms: raw.b - raw.a, n: count(raw.n), failed: raw.failed === true, isCurrent: raw.isCurrent === true };
}

const normalizePlanItem = (raw) => (isObj(raw) && typeof raw.text === 'string' && raw.text !== '' ? { text: text(raw.text, PCAPS.item), state: pick(raw.state, PLAN_STATES, 'todo'), evidence: text(raw.evidence, PCAPS.short) } : null);

function normalizeFolder(raw) {
  if (!isObj(raw) || typeof raw.dir !== 'string') return null;
  return { dir: text(raw.dir, PCAPS.short), created: count(raw.created), edited: count(raw.edited), names: list(raw.names, PCAPS.names).filter((x) => isObj(x) && typeof x.name === 'string').map((x) => ({ name: text(x.name, PCAPS.short), n: count(x.n) || 1 })) };
}

function normalizeCheck(raw) {
  if (!isObj(raw) || typeof raw.label !== 'string') return null;
  return { label: text(plainTitle(raw.label, false), PCAPS.short), cmd: text(raw.cmd, PCAPS.title), outcome: pick(raw.outcome, ['pass', 'fail', 'running'], 'running'), result: text(raw.result, PCAPS.short), t: num(raw.t), runs: count(raw.runs) || 1 };
}

const normalizeDecision = (raw) => (isObj(raw) && typeof raw.quote === 'string' && raw.quote !== '' && num(raw.t) !== null ? { t: raw.t, quote: text(raw.quote, PCAPS.quote) } : null);
const normalizeIssue = (raw) => (isObj(raw) && typeof raw.title === 'string' && raw.title !== ''
  ? { kind: pick(raw.kind, ISSUE_KINDS, 'failure'), title: text(plainTitle(raw.title, false), PCAPS.title), evidence: text(raw.evidence, PCAPS.quote), t: num(raw.t), outcome: raw.outcome === 'resolved' ? 'resolved' : 'open' }
  : null);

/** Whatever `progress` holds -> clean progress; missing or malformed -> the empty one (nothing shown, nothing invented). Never throws. */
export function normalizeProgress(raw) {
  const r = isObj(raw) ? raw : {};
  const now = isObj(r.now) ? r.now : {};
  const call = isObj(now.call) && typeof now.call.text === 'string' ? { text: text(now.call.text, PCAPS.title), runningMs: count(now.call.runningMs) } : null;
  const plan = isObj(r.plan) ? r.plan : {};
  const done = isObj(r.done) ? r.done : {};
  const issues = isObj(r.issues) ? r.issues : {};
  const issueList = list(issues.list, PCAPS.issues).map(normalizeIssue).filter((i) => i !== null);
  return {
    isEmpty: !isObj(raw),
    now: { say: text(now.say, PCAPS.quote), sayT: num(now.sayT), call, pace: text(now.pace, PCAPS.title), laneStep: text(plainTitle(now.laneStep, false), PCAPS.short), laneNote: text(plainTitle(now.laneNote, false), PCAPS.title) },
    plan: { source: pick(plan.source, PLAN_SOURCES, 'none'), label: text(plainTitle(plan.label, false), PCAPS.title), items: list(plan.items, PCAPS.plan).map(normalizePlanItem).filter((i) => i !== null) },
    phases: list(r.phases, PCAPS.phases).map(normalizePhase).filter((p) => p !== null),
    phaseNote: text(r.phaseNote, PCAPS.title),
    done: {
      files: count(done.files),
      folders: list(done.folders, PCAPS.folders).map(normalizeFolder).filter((f) => f !== null),
      checks: list(done.checks, PCAPS.checks).map(normalizeCheck).filter((c) => c !== null),
      images: list(done.images, PCAPS.images).filter((s) => typeof s === 'string').map((s) => text(s, PCAPS.short)),
      imageCount: count(done.imageCount),
    },
    decisions: list(r.decisions, PCAPS.decisions).map(normalizeDecision).filter((d) => d !== null),
    issues: { openCount: count(issues.openCount) || issueList.filter((i) => i.outcome === 'open').length, summary: text(issues.summary, PCAPS.title), list: issueList },
  };
}

function normalizeStruggleItem(raw) {
  if (!isObj(raw) || !STRUGGLE_KINDS.includes(raw.kind) || typeof raw.title !== 'string' || num(raw.t) === null) return null;
  return {
    kind: raw.kind, title: text(plainTitle(raw.title, false), PCAPS.title), evidence: text(raw.evidence, PCAPS.quote), t: raw.t, lastT: num(raw.lastT) ?? raw.t, n: count(raw.n) || 1,
    outcome: raw.outcome === 'resolved' ? 'resolved' : 'open', hint: text(raw.hint, PCAPS.title), recent: raw.recent === true,
  };
}

/** Whatever `struggles` holds -> clean report (an old array or nothing -> an empty report that says nothing went wrong). Never throws. */
export function normalizeStruggles(raw) {
  const r = isObj(raw) ? raw : {};
  const items = list(r.items, PCAPS.struggles).map(normalizeStruggleItem).filter((i) => i !== null);
  return {
    headline: text(plainTitle(r.headline, false), PCAPS.title),
    badge: count(r.badge),
    open: count(r.open),
    resolved: count(r.resolved),
    items,
    calm: list(r.calm, PCAPS.calm).filter((c) => isObj(c) && typeof c.title === 'string').map((c) => ({ title: text(plainTitle(c.title, false), PCAPS.title), n: count(c.n) })),
  };
}

/** "2:10", "0:42", "1:02:10": a stretch of time as the clock of a stopwatch. */
export function mmss(ms) {
  const total = Math.max(0, Math.round(ms / MS_SEC));
  const s = String(total % SEC_MIN).padStart(2, '0');
  const m = Math.floor(total / SEC_MIN);
  return m < MIN_HOUR ? `${m}:${s}` : `${Math.floor(m / MIN_HOUR)}:${String(m % MIN_HOUR).padStart(2, '0')}:${s}`;
}

/**
 * The phase bar: one segment per phase, its width the share of the real time (at least MIN_SEGMENT_PCT; the longest give up the
 * difference so the widths add up to 100). `showLabel` is false for a segment too narrow to carry its name.
 */
export function phaseSegments(phases) {
  const total = phases.reduce((s, p) => s + Math.max(p.ms, 1), 0);
  if (phases.length === 0 || total <= 0) return [];
  const raw = phases.map((p) => Math.max(MIN_SEGMENT_PCT, (Math.max(p.ms, 1) / total) * PERCENT));
  const scale = PERCENT / raw.reduce((s, x) => s + x, 0);
  const widths = raw.map((x) => x * scale);
  return phases.map((p, i) => ({
    ...p, pct: Math.round(widths[i] * 100) / 100, time: mmss(p.ms), showLabel: widths[i] >= LABEL_SEGMENT_PCT,
    title: `${p.label} ${mmss(p.ms)}${p.n > 0 ? ` (${p.n} call${p.n === 1 ? '' : 's'})` : ''}${p.failed ? ', something failed' : ''}${p.isCurrent ? ', now' : ''}`,
  }));
}

/** Done / total of the checklist and the sentence for it: "3 of 8 shown done" (a posted list: "3 of 8 done"). */
export function planCount(plan) {
  const total = plan.items.length;
  const done = plan.items.filter((i) => i.state === 'done').length;
  return { done, total, text: total === 0 ? '' : `${done} of ${total} ${plan.source === 'brief' ? 'shown done' : 'done'}` };
}

/** The mark and the words for one checklist state; an item with no evidence yet says "not shown yet". */
export const PLAN_MARK = Object.freeze({ done: { mark: '✓', word: 'done' }, doing: { mark: '●', word: 'in progress' }, failed: { mark: '✕', word: 'failed' }, todo: { mark: '○', word: NOT_SHOWN } });
export const planMark = (item, source) => (item.state === 'todo' && source === 'lane' ? { mark: '○', word: 'to do' } : PLAN_MARK[item.state]);

/** A folder line: "hooks: 2 created, 3 edited"; names after it. */
export function folderLine(f) {
  const parts = [f.created > 0 ? `${f.created} created` : '', f.edited > 0 ? `${f.edited} edited` : ''].filter(Boolean);
  return `${f.dir}: ${parts.join(', ')}`;
}

/** Count of what is open on the Progress tab: drives the red dot of the tab. */
export const hasOpenIssue = (progress) => progress.issues.openCount > 0;

export const OUTCOME_WORD = Object.freeze({ open: 'still open', resolved: 'resolved' });

/** The Struggles tab as groups: open problems first, then resolved ones, then (muted) what is not a problem. Empty groups are left out. */
export function struggleGroups(report) {
  const open = report.items.filter((i) => i.outcome === 'open');
  const resolved = report.items.filter((i) => i.outcome === 'resolved');
  return [
    { id: 'open', title: 'Still open', items: open },
    { id: 'resolved', title: 'Resolved', items: resolved },
  ].filter((g) => g.items.length > 0);
}

/** The count text of a struggle: "x4" for 4 occurrences, '' for one. */
export const countText = (n) => (n > 1 ? `x${n}` : '');

/** When a struggle happened: one time, or from the first to the last. */
export const whenRange = (item, clock) => (item.lastT - item.t >= MS_SEC ? `${clock(item.t)}–${clock(item.lastT)}` : clock(item.t));
