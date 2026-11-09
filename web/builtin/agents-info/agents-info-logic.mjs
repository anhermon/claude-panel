// Pure logic of the Agents scene (no DOM, no clock of its own): what the mod wrote (hooks/agents-info-data.ts) -> clean data,
// the mood of the big avatar, the wording of durations and tokens, the order of the rows, the legend, which events are new.
// Tested by agents-info-logic.test.mjs.
import { normalizeProof } from './proof-logic.mjs';

export const STATES = Object.freeze(['working', 'testing', 'waiting', 'blocked', 'done']);
export const OVERALLS = Object.freeze(['working', 'waiting', 'blocked', 'done']);
export const EVENT_KINDS = Object.freeze(['spawn', 'handoff', 'state', 'work', 'progress']);
/** Kinds in which an agent makes calls (hooks/work-kinds.ts WORK_KINDS): any of them on a running agent means "busy". */
export const WORK_KINDS = Object.freeze(['ui', 'logic', 'tests', 'visual', 'docs', 'research', 'reading', 'delegating', 'working']);
export const CAPS = Object.freeze({ agents: 12, events: 20, id: 64, name: 80, short: 14, text: 60, note: 120, files: 3, file: 28, kind: 12, role: 12, ticket: 28, harness: 16, model: 28, effort: 8, segs: 48, kinds: 16, type: 40 });
/** Kinds that say nothing about WHAT the work is (the state pill already says it): no kind chip, not in the legend. */
export const GENERIC_KINDS = Object.freeze(['working', 'thinking', 'waiting', 'done']);
export const hasKind = (a) => a.kind !== null && !GENERIC_KINDS.includes(a.kind);
export const FALLBACK_KIND = Object.freeze({ kind: 'working', label: 'Working', color: '#64748b', glyph: '•' });
export const PCT_MAX = 100;
/** The pane is "side by side" from this width / height, and only when it is at least this wide. */
export const SIDE_MIN_RATIO = 1.25;
export const SIDE_MIN_WIDTH = 640;

const MS_SEC = 1000;
const SEC_MIN = 60;
const MIN_HOUR = 60;
const TOKENS_K = 1000;
const TOKENS_M = 1_000_000;
const TOKENS_ONE_DECIMAL_BELOW = 10_000;
const COLOR = /^#[0-9a-fA-F]{6}$/;
const RANK = Object.freeze({ blocked: 0, working: 1, testing: 1, waiting: 2, done: 3 });
/** An attempt that never started sorts last, below the finished ones. */
const RANK_NOT_STARTED = 4;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
export const cut = (v, max) => {
  const s = typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '';
  return s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
};

/** The router ticket an agent works on, `{ id, stage, text, title, harness }` (text: "verified 4/4"), or null. */
export function normalizeTicket(raw) {
  if (!isObj(raw) || typeof raw.id !== 'string' || raw.id === '') return null;
  const text = cut(raw.text, CAPS.ticket) || cut(raw.stage, CAPS.ticket);
  return { id: cut(raw.id, CAPS.ticket), stage: cut(raw.stage, CAPS.kind), text, title: cut(raw.title, CAPS.text), harness: cut(raw.harness, CAPS.harness) || null };
}

/** The stretches of work of an agent (`[{ k, a, b }]` in ms, oldest first): only well-formed ones, capped. */
function normalizeSegs(raw) {
  if (!Array.isArray(raw)) return [];
  const ok = raw.filter((s) => isObj(s) && typeof s.k === 'string' && num(s.a) !== null && num(s.b) !== null && s.b >= s.a);
  return ok.slice(-CAPS.segs).map((s) => ({ k: cut(s.k, CAPS.kind), a: s.a, b: s.b }));
}

/** How the page draws each kind a stretch uses: `{ [kind]: { label, color, glyph } }`; a bad colour is dropped. */
function normalizeKinds(raw) {
  const out = {};
  if (!isObj(raw)) return out;
  for (const [k, v] of Object.entries(raw).slice(0, CAPS.kinds)) {
    if (isObj(v) && typeof v.color === 'string' && COLOR.test(v.color)) out[cut(k, CAPS.kind)] = { label: cut(v.label, CAPS.kind) || k, color: v.color, glyph: cut(v.glyph, 2) };
  }
  return out;
}

function normalizeAgent(raw) {
  if (!isObj(raw) || typeof raw.id !== 'string' || raw.id === '' || !STATES.includes(raw.state)) return null;
  const pct = num(raw.pct);
  const kind = typeof raw.kind === 'string' && raw.kind !== '' ? cut(raw.kind, CAPS.kind) : null;
  return {
    id: cut(raw.id, CAPS.id),
    isMain: raw.isMain === true,
    name: cut(raw.name, CAPS.name) || cut(raw.id, CAPS.id),
    short: cut(raw.short, CAPS.short) || cut(raw.name, CAPS.short) || cut(raw.id, CAPS.short),
    notStarted: raw.notStarted === true,
    note: cut(raw.note, CAPS.note),
    state: raw.state,
    pct: pct === null ? null : Math.min(PCT_MAX, Math.max(0, Math.round(pct))),
    startedAt: num(raw.startedAt) ?? 0,
    endedAt: num(raw.endedAt),
    tokens: num(raw.tokens) !== null && raw.tokens > 0 ? Math.round(raw.tokens) : null,
    kind,
    kindLabel: cut(raw.kindLabel, CAPS.kind) || FALLBACK_KIND.label,
    kindColor: typeof raw.kindColor === 'string' && COLOR.test(raw.kindColor) ? raw.kindColor : FALLBACK_KIND.color,
    kindGlyph: cut(raw.kindGlyph, 2) || FALLBACK_KIND.glyph,
    headline: cut(raw.headline, CAPS.text),
    files: Array.isArray(raw.files) ? raw.files.slice(0, CAPS.files).map((f) => cut(f, CAPS.file)).filter((f) => f !== '') : [],
    segs: normalizeSegs(raw.segs),
    calls: num(raw.calls) !== null && raw.calls >= 0 ? Math.round(raw.calls) : null,
    role: cut(raw.role, CAPS.role) || null,
    ticket: normalizeTicket(raw.ticket),
    proof: normalizeProof(raw.proof),
    agentType: cut(raw.agentType, CAPS.type) || null,
    harness: cut(raw.harness, CAPS.harness) || null,
    model: cut(raw.model, CAPS.model) || null,
    effort: cut(raw.effort, CAPS.effort) || null,
  };
}

function normalizeEvent(raw) {
  if (!isObj(raw) || num(raw.id) === null || typeof raw.agent !== 'string' || !EVENT_KINDS.includes(raw.kind)) return null;
  return { id: raw.id, t: num(raw.t) ?? 0, agent: cut(raw.agent, CAPS.id), from: cut(raw.from, CAPS.text), to: cut(raw.to, CAPS.text), kind: raw.kind, text: cut(raw.text, CAPS.text) };
}

/** Whatever the data file holds -> clean data; a missing or odd file is "no agents, working". Never throws. */
export function normalizeData(raw) {
  const d = isObj(raw) ? raw : {};
  const agents = (Array.isArray(d.agents) ? d.agents : []).slice(0, CAPS.agents).map(normalizeAgent).filter((a) => a !== null);
  const events = (Array.isArray(d.events) ? d.events : []).slice(-CAPS.events).map(normalizeEvent).filter((e) => e !== null);
  return {
    overall: OVERALLS.includes(d.overall) ? d.overall : 'working',
    mainKind: typeof d.mainKind === 'string' ? d.mainKind : null,
    agents,
    kinds: normalizeKinds(d.kinds),
    events,
    updatedAt: num(d.updatedAt) ?? 0,
  };
}

export const isRunning = (a) => a.state === 'working' || a.state === 'testing';
const isBusyKind = (kind) => typeof kind === 'string' && WORK_KINDS.includes(kind);

const runningCount = (data) => data.agents.filter((a) => !a.isMain && isRunning(a)).length;
/** The session has nothing to ask the person (overall "waiting") but its agents are still running: it waits for them, not for the person. */
export const isWaitingOnAgents = (data) => data.overall === 'waiting' && runningCount(data) > 0;
/** The line under the head when the session waits for its agents: "Waiting for 4 agents" ('' when it does not). */
export const waitingLabelOf = (data) => (isWaitingOnAgents(data) ? `Waiting for ${runningCount(data)} agent${runningCount(data) === 1 ? '' : 's'}` : '');

/**
 * The mood of the big avatar: blocked / waiting (for the person) / done as the mod says; "working" only while something makes
 * calls (a running agent or the session itself in a kind of work), else "thinking" (the team is alive but nothing is busy).
 */
export function moodOf(data) {
  if (isWaitingOnAgents(data)) return 'thinking';
  if (data.overall !== 'working') return data.overall;
  return data.agents.some((a) => isRunning(a) && isBusyKind(a.kind)) || isBusyKind(data.mainKind) ? 'working' : 'thinking';
}

const rankOf = (a) => (a.notStarted ? RANK_NOT_STARTED : RANK[a.state]);
/** The main session ("Me") first, then blocked, running, waiting, done, not started; a tie keeps the start order. */
export const sortAgents = (agents) => [...agents].sort((a, b) => Number(b.isMain) - Number(a.isMain) || rankOf(a) - rankOf(b) || a.startedAt - b.startedAt);

/** The agents that get a satellite: everyone but the main session, which IS the big head. */
export const satellitesOf = (agents) => agents.filter((a) => !a.isMain);

/** The mood of the head while one agent is open in the detail view: that agent's state (a running one with no kind of work still looks busy). */
export const moodOfAgent = (a) => (a.state === 'working' || a.state === 'testing' ? 'working' : a.state);

/** Relative size of each agent's run, 0..1 against the largest: by tokens when any agent has them, else by time. For the thin bar under a row. */
export function shareOf(agents, now) {
  const byTokens = agents.some((a) => a.tokens !== null);
  const value = (a) => (byTokens ? a.tokens ?? 0 : elapsedMs(a, now));
  const max = Math.max(0, ...agents.map(value));
  return new Map(agents.map((a) => [a.id, max <= 0 ? 0 : value(a) / max]));
}

/** The kinds present, most agents first, for the one-line legend (finished agents count as their last kind; no kind: none). */
export function legendOf(agents) {
  const seen = new Map();
  for (const a of agents) {
    if (!hasKind(a)) continue;
    const e = seen.get(a.kind) ?? { kind: a.kind, label: a.kindLabel, color: a.kindColor, glyph: a.kindGlyph, n: 0 };
    e.n += 1;
    seen.set(a.kind, e);
  }
  return [...seen.values()].sort((x, y) => y.n - x.n);
}

export const elapsedMs = (a, now) => Math.max(0, (a.endedAt ?? now) - a.startedAt);

/** 42_000 -> "42 s", 200_000 -> "3 min 20 s", 180_000 -> "3 min", 7_500_000 -> "2 h 05 min"; unusable -> ''. */
export function formatDuration(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '';
  const total = Math.floor(ms / MS_SEC);
  if (total < SEC_MIN) return `${total} s`;
  const minutes = Math.floor(total / SEC_MIN);
  if (minutes < MIN_HOUR) return total % SEC_MIN === 0 ? `${minutes} min` : `${minutes} min ${total % SEC_MIN} s`;
  return `${Math.floor(minutes / MIN_HOUR)} h ${String(minutes % MIN_HOUR).padStart(2, '0')} min`;
}

/** 850 -> "850", 4_250 -> "4.3k", 42_400 -> "42k", 1_200_000 -> "1.2M"; unknown -> ''. */
export function formatTokens(n) {
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return '';
  if (n < TOKENS_K) return String(Math.round(n));
  if (n < TOKENS_ONE_DECIMAL_BELOW) return `${(Math.round(n / (TOKENS_K / 10)) / 10).toString()}k`;
  if (Math.round(n / TOKENS_K) < TOKENS_K) return `${Math.round(n / TOKENS_K)}k`;
  return `${(Math.round(n / (TOKENS_M / 10)) / 10).toString()}M`;
}

/** The highest event id (0 for none). */
export const maxEventId = (events) => events.reduce((m, e) => Math.max(m, e.id), 0);
/** The events past `seenId`, oldest first. The first read of a page marks everything seen (`seenId` = maxEventId), so a reload replays nothing. */
export const newEvents = (events, seenId) => events.filter((e) => e.id > seenId).sort((a, b) => a.id - b.id);

/** 'side' (avatar left, list right) on a wide pane, else 'stack' (avatar above the list). */
export const layoutFor = (w, h) => (w >= SIDE_MIN_WIDTH && w / Math.max(1, h) >= SIDE_MIN_RATIO ? 'side' : 'stack');

/** The words of the overall line: "3 working · 1 blocked · 2 done" (zero counts left out; none at all: ''). */
export function summaryOf(agents) {
  const n = (f) => satellitesOf(agents).filter(f).length;
  const parts = [[n(isRunning), 'working'], [n((a) => a.state === 'blocked'), 'blocked'], [n((a) => a.state === 'waiting' && !a.notStarted), 'waiting'], [n((a) => a.state === 'done'), 'done'], [n((a) => a.notStarted), 'not started']];
  return parts.filter(([c]) => c > 0).map(([c, w]) => `${c} ${w}`).join(' · ');
}
