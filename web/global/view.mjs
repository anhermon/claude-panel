// The global view's data: every Claude Code session on this machine that was active in the last 48 hours, with what each is
// doing, what needs the person, which Jira tickets it works on and its links. READ-ONLY and lazy: nothing runs until the page asks
// (`state()` / `json()`), the answer is cached for CACHE_MS, overlapping asks share one computation, and every file is read again
// only when its size or mtime moved (transcript tails are incremental, see ./transcript.mjs).
//   discovery  fs.readdir + stat over <claude>/projects/*/<sessionId>.jsonl (never a shell glob: there are thousands of files);
//              subagents are <claude>/projects/<slug>/<sessionId>/subagents/agent-*.jsonl (+ .meta.json) and group under their parent
//   liveness   ./registry.mjs (registry + `ps`); a session that is not live is `ended`
//   ranking    waiting first, then busy, then the most recent; the display is cut to MAX_ROWS AFTER ranking, but the needs-you
//              list and the Jira groups are computed over all sessions of the window
// Everything shown from a transcript or board file is untrusted text: masked (./redact.mjs), cut, and never passed to a model.
import fs from 'node:fs/promises';
import path from 'node:path';
import { readBoard } from './board.mjs';
import { oneLine } from './redact.mjs';
import { SEED_PREFIXES, branchKeys, linkKey, jiraUrl, ticketKeys } from './links.mjs';
import { mergeLive, readRegistry, scanProcesses } from './registry.mjs';
import { SUBAGENT_TAIL_BYTES, TAIL_BYTES, lastPending, newTracker, pendingAsks, pollTail, todosOf } from './transcript.mjs';

export const WINDOW_MS = 48 * 60 * 60 * 1000;
export const CACHE_MS = 2000;
export const MAX_ROWS = 40;
// Twins of hooks/sessions-state.ts: a transcript written this recently is running; an unanswered tool call this quiet is "may be waiting".
export const RUNNING_WRITE_MS = 30 * 1000;
export const WAITING_HINT_MS = 20 * 1000;
/** A session the registry calls busy, with nothing pending and nothing written for this long, may be stalled. */
export const STALL_MS = 5 * 60 * 1000;
const PS_EVERY_MS = 4000;
const SUBAGENTS_MAX = 12;
const NEEDS_PER_SESSION = 8;
const NEEDS_MAX = 100;
const LINKS_MAX = 6;
const TICKETS_MAX = 8;
const CONCURRENCY = 8;
const TRANSCRIPT_NAME = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
const SUBAGENT_NAME = /^(agent-[A-Za-z0-9_-]+)\.jsonl$/;
const ID_CHARS = 8;
const TITLE_CHARS = 100;
const PROJECT_CHARS = 40;
const BRANCH_CHARS = 80;
const TASK_CHARS = 160;
const LABEL_CHARS = 60;
const META_TYPE_CHARS = 40;
const META_DESC_CHARS = 120;
const MS_PER_MIN = 60_000;
const MS_PER_HOUR = 3_600_000;
const BRANCH_NOISE = 'HEAD';
const RANK = { waiting: 0, busy: 1, idle: 2, ended: 2 };
const KIND_ORDER = { 'board-ask': 0, board: 1, ask: 2, waiting: 3, question: 4, error: 5, stall: 6 };

/** Runs fn over items, at most `limit` at a time; results keep the item order. */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (let i = next++; i < items.length; i = next++) out[i] = await fn(items[i], i);
  }));
  return out;
}

async function listDir(dir) {
  try { return await fs.readdir(dir, { withFileTypes: true }); } catch { return []; }
}

const statOf = async (file) => { try { return await fs.stat(file); } catch { return null; } };

/** `now`, `5m`, `3h`, `2d` (the page draws its own ages; this is for the sentences made here). */
export function ageText(ms) {
  const min = Math.floor(ms / MS_PER_MIN);
  if (min < 1) return 'now';
  if (min < 60) return `${min}m`;
  const hours = Math.floor(min / 60);
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

/** busy / may-be-waiting / idle / ended. `f`: { live (live session | undefined), pending (count), mainMs, lastWriteMs (subagents included) }. */
export function stateOf(f, now) {
  if (f.live === undefined) return 'ended';
  // Deviation from the twin: a subagent writing counts as activity (a foreground Agent call holds the parent's tool call open while it works).
  const lastMs = f.lastWriteMs ?? f.mainMs;
  const quietMs = lastMs === null ? null : now - lastMs;
  if (f.pending > 0 && quietMs !== null && quietMs >= WAITING_HINT_MS) return 'waiting';
  const ageMs = f.lastWriteMs === null ? null : Math.max(0, now - f.lastWriteMs);
  return (ageMs !== null && ageMs < RUNNING_WRITE_MS) || f.live.status === 'busy' ? 'busy' : 'idle';
}

/**
 * The heuristic needs-you items of one LIVE session, each labelled `may`: an AskUserQuestion with no result, the
 * may-be-waiting hint, a last reply that ends with a question, an API error, a stall. Pure.
 */
export function heuristicNeeds(f, state, now) {
  const { acc, live } = f;
  const out = [];
  const asks = pendingAsks(acc);
  for (const a of asks.slice(-2)) {
    out.push({ kind: 'ask', title: a.ask.question || a.ask.header || 'A question for you', why: `AskUserQuestion has no answer yet${a.ask.header === '' ? '' : ` (${a.ask.header})`}`, ts: a.ts });
  }
  const pending = lastPending(acc);
  if (state === 'waiting' && asks.length === 0 && pending !== null) {
    out.push({ kind: 'waiting', title: `Waiting on ${pending.label || pending.name}`, why: `A tool call has had no answer for ${ageText(now - (f.lastWriteMs ?? f.mainMs))}, probably a permission prompt`, ts: pending.ts });
  }
  if (state !== 'busy' && acc.pending.size === 0 && acc.endsQuestion && acc.said !== null) {
    out.push({ kind: 'question', title: acc.said, why: 'The last reply ends with a question', ts: acc.saidTs });
  }
  if (acc.turnError !== null) out.push({ kind: 'error', title: 'API error in this session', why: acc.turnError, ts: acc.turnErrorTs });
  if (live.status === 'busy' && acc.pending.size === 0 && f.mainMs !== null && now - f.mainMs >= STALL_MS) {
    out.push({ kind: 'stall', title: 'Registered as busy, but quiet', why: `Nothing written for ${ageText(now - f.mainMs)}`, ts: f.mainMs });
  }
  return out.map((i) => ({ ...i, may: true, link: '' }));
}

const progressOf = (items) => ({ done: items.filter((i) => i.state === 'done').length, total: items.length, items });

const projectOf = (cwd, slug) => (cwd !== null ? cwd.replace(/\/+$/, '').split('/').pop() || cwd : (slug ?? '').split('-').filter(Boolean).pop() ?? '');

export function createGlobalView({ claudeDir, stateDir, windowMs = WINDOW_MS, cacheMs = CACHE_MS, maxRows = MAX_ROWS, now = Date.now, scan = scanProcesses }) {
  const regCache = new Map();
  const boardCache = new Map();
  const trackers = new Map();
  const metaCache = new Map();
  const prefixes = new Set(SEED_PREFIXES);
  let procs = { at: -Infinity, table: null };
  let cached = null;
  let cachedAt = -Infinity;
  let inflight = null;

  const trackerFor = (file, accOptions) => {
    let tr = trackers.get(file);
    if (tr === undefined) { tr = newTracker(file, accOptions); trackers.set(file, tr); }
    return tr;
  };

  async function readMeta(file, st) {
    const hit = metaCache.get(file);
    if (hit !== undefined && hit.mtimeMs === st.mtimeMs) return hit.meta;
    let meta = {};
    try {
      const m = JSON.parse(await fs.readFile(file, 'utf8'));
      meta = { type: oneLine(String(m.agentType ?? ''), META_TYPE_CHARS), desc: oneLine(String(m.description ?? ''), META_DESC_CHARS), finished: m.finished === true };
    } catch { /* no meta: the agent shows without a description */ }
    metaCache.set(file, { mtimeMs: st.mtimeMs, meta });
    return meta;
  }

  /** The window's transcripts: sessionId -> { file, dir, slug, st }, the newest file wins a duplicate id. */
  async function discover(projects, t) {
    const found = new Map();
    const slugs = (await listDir(projects)).filter((e) => e.isDirectory());
    await mapLimit(slugs, 16, async (slug) => {
      const dir = path.join(projects, slug.name);
      for (const e of await listDir(dir)) {
        const m = e.isFile() ? TRANSCRIPT_NAME.exec(e.name) : null;
        if (m === null) continue;
        const st = await statOf(path.join(dir, e.name));
        if (st === null || t - st.mtimeMs > windowMs) continue;
        const id = m[1].toLowerCase();
        if ((found.get(id)?.st.mtimeMs ?? -1) < st.mtimeMs) found.set(id, { id, file: path.join(dir, e.name), dir, slug: slug.name, st });
      }
    });
    return found;
  }

  async function readSubagents(s, t) {
    const dir = path.join(s.dir, s.id, 'subagents');
    const files = [];
    for (const e of await listDir(dir)) {
      const m = e.isFile() ? SUBAGENT_NAME.exec(e.name) : null;
      const st = m === null ? null : await statOf(path.join(dir, e.name));
      if (st !== null && t - st.mtimeMs <= windowMs) files.push({ id: m[1], file: path.join(dir, e.name), st });
    }
    files.sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);
    const agents = [];
    for (const a of files.slice(0, SUBAGENTS_MAX)) {
      const tr = trackerFor(a.file, { sidechain: true });
      await pollTail(tr, a.st, SUBAGENT_TAIL_BYTES);
      const metaStat = await statOf(a.file.replace(/\.jsonl$/, '.meta.json'));
      const meta = metaStat === null ? {} : await readMeta(a.file.replace(/\.jsonl$/, '.meta.json'), metaStat);
      const pending = lastPending(tr.acc);
      const todos = todosOf(tr.acc);
      for (const p of tr.acc.prefixes) prefixes.add(p);
      agents.push({
        id: a.id,
        type: meta.type ?? '',
        desc: meta.desc ?? '',
        state: meta.finished === true ? 'done' : t - a.st.mtimeMs < RUNNING_WRITE_MS ? 'running' : 'idle',
        doing: pending !== null ? pending.label : (tr.acc.said ?? ''),
        lastMs: a.st.mtimeMs,
        progress: todos.length === 0 ? null : progressOf(todos),
        // not shown: what the parent session inherits (a branch, ticket mentions and links often live only in a subagent's rows)
        branch: tr.acc.gitBranch,
        prompts: tr.acc.prompts,
        brief: tr.acc.brief,
        links: tr.acc.links,
      });
    }
    return { agents, lastWriteMs: files.reduce((m, f) => Math.max(m, f.st.mtimeMs), 0) };
  }

  async function liveSessions() {
    const entries = await readRegistry(path.join(claudeDir, 'sessions'), regCache);
    const t = now();
    if (t - procs.at >= PS_EVERY_MS) procs = { at: t, table: (await scan()) ?? procs.table };
    return mergeLive(entries, procs.table);
  }

  async function compute() {
    const t = now();
    const live = await liveSessions();
    const found = await discover(path.join(claudeDir, 'projects'), t);
    for (const f of trackers.keys()) if (!f.includes(`${path.sep}subagents${path.sep}`) && ![...found.values()].some((s) => s.file === f)) trackers.delete(f);
    const facts = await mapLimit([...found.values()], CONCURRENCY, async (s) => {
      const tr = trackerFor(s.file);
      await pollTail(tr, s.st, TAIL_BYTES);
      for (const p of tr.acc.prefixes) prefixes.add(p);
      const sub = await readSubagents(s, t);
      const board = await readBoard(boardCache, stateDir, s.id, t, windowMs);
      return { s, acc: tr.acc, live: live.get(s.id), mainMs: s.st.mtimeMs, lastWriteMs: Math.max(s.st.mtimeMs, sub.lastWriteMs), agents: sub.agents, board, pending: tr.acc.pending.size };
    });

    const sessions = facts.map((f) => buildSession(f, t, prefixes));
    sessions.sort((a, b) => RANK[a.state] - RANK[b.state] || b.lastActive - a.lastActive);

    const needsYou = sessions.flatMap((s) => s.needs.map((n) => ({ ...n, sessionId: s.id, sessionTitle: s.title, sessionState: s.state })))
      .sort((a, b) => Number(a.may) - Number(b.may) || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || (b.ts ?? 0) - (a.ts ?? 0))
      .slice(0, NEEDS_MAX);
    const jira = jiraGroups(sessions);
    const count = (st) => sessions.filter((s) => s.state === st).length;
    return {
      generatedAt: t,
      windowHours: windowMs / MS_PER_HOUR,
      totals: { sessions: sessions.length, shown: Math.min(sessions.length, maxRows), waiting: count('waiting'), busy: count('busy'), idle: count('idle'), ended: count('ended'), needsYou: needsYou.length },
      needsYou,
      jira,
      sessions: sessions.slice(0, maxRows).map((s) => ({ ...s, needs: s.needs.map((n) => n.id) })),
    };
  }

  /** The aggregate, at most `cacheMs` old; overlapping callers share one computation. */
  function state() {
    const t = now();
    if (cached !== null && t - cachedAt < cacheMs) return Promise.resolve(cached);
    inflight ??= compute()
      .then((r) => { cached = r; cachedAt = now(); return r; })
      .catch(() => cached ?? { generatedAt: t, windowHours: windowMs / MS_PER_HOUR, totals: { sessions: 0, shown: 0, waiting: 0, busy: 0, idle: 0, ended: 0, needsYou: 0 }, needsYou: [], jira: [], sessions: [], error: 'failed' })
      .finally(() => { inflight = null; });
    return inflight;
  }

  return { state, json: async () => JSON.stringify(await state()) };
}

/** The lists of links (newest first each) -> one list, newest first by time, no repeats. */
const mergeLinks = (lists) => lists.flat().sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0)).filter((l, i, all) => all.findIndex((x) => linkKey(x.url) === linkKey(l.url)) === i);

/** A subagent for the page: the parts kept only to feed the parent's tickets and links are left out. */
const shownAgent = (a) => ({ id: a.id, type: a.type, desc: a.desc, state: a.state, doing: a.doing, lastMs: a.lastMs, progress: a.progress });

/** One session's record for the page (needs carry full items here; the caller keeps only their ids on the card). */
export function buildSession(f, t, prefixes) {
  const { acc, live, board, s } = f;
  const state = stateOf({ live, pending: f.pending, mainMs: f.mainMs, lastWriteMs: f.lastWriteMs }, t);
  const cwd = acc.cwd ?? live?.cwd ?? null;
  const branch = acc.gitBranch === null || acc.gitBranch === BRANCH_NOISE ? '' : acc.gitBranch;
  const title = oneLine(acc.title ?? live?.name ?? acc.slug ?? acc.lastPrompt ?? s.id.slice(0, ID_CHARS), TITLE_CHARS);
  const todos = todosOf(acc);
  const progress = todos.length > 0 ? { source: 'todos', ...progressOf(todos) } : f.board?.steps != null ? { source: 'board', ...progressOf(f.board.steps) } : null;
  const doingTodo = todos.find((i) => i.state === 'doing');
  const pending = lastPending(acc);
  const taskTitle = f.board?.task?.title ?? doingTodo?.t ?? acc.lastPrompt ?? '';

  const seen = [];
  const addKeys = (list) => { for (const k of list) if (!seen.some((x) => x.key === k.key)) seen.push(k); };
  addKeys(branchKeys(acc.gitBranch, prefixes));
  for (const p of acc.prompts.slice().reverse()) addKeys(ticketKeys(p, prefixes));
  const links = mergeLinks([acc.links, ...f.agents.map((a) => a.links)]);
  for (const l of links) if (l.kind === 'jira') addKeys(ticketKeys(l.label, prefixes));
  for (const a of f.agents) { // after the session's own keys: the subagents' branches and briefs
    addKeys(branchKeys(a.branch, prefixes));
    addKeys(ticketKeys(a.brief, prefixes));
    for (const p of a.prompts.slice().reverse()) addKeys(ticketKeys(p, prefixes));
  }
  const tickets = seen.slice(0, TICKETS_MAX).map((k) => ({ key: k.key, internal: k.internal, url: jiraUrl(k.key, k.internal) }));

  const needs = [
    ...(f.board?.needs ?? []).map((n) => ({ ...n, ts: s.st.mtimeMs })),
    ...(live === undefined ? [] : heuristicNeeds({ acc, live, mainMs: f.mainMs, lastWriteMs: f.lastWriteMs }, state, t)),
  ].slice(0, NEEDS_PER_SESSION).map((n, i) => ({ id: `${s.id}:${n.kind}:${i}`, ...n }));

  return {
    id: s.id,
    title,
    project: oneLine(projectOf(cwd, s.slug), PROJECT_CHARS),
    branch: oneLine(branch, BRANCH_CHARS),
    state,
    lastActive: f.lastWriteMs,
    prompt: acc.lastPrompt ?? '',
    task: { title: oneLine(taskTitle, TASK_CHARS), why: f.board?.task?.why ?? '', source: f.board?.task != null ? 'board' : doingTodo !== undefined ? 'todos' : 'prompt' },
    doing: pending !== null ? pending.label : (acc.said ?? ''),
    progress,
    agents: f.agents.map(shownAgent),
    needs,
    tickets,
    links: links.slice(0, LINKS_MAX).map(({ url, kind, label }) => ({ url, kind, label: oneLine(label, LABEL_CHARS) })),
  };
}

/**
 * Sessions -> one group per ticket, each session listed once; groups with a live (not ended) session first, then the newest.
 * INT-* keys are internal: no url.
 */
export function jiraGroups(sessions) {
  const groups = new Map();
  for (const s of sessions) {
    for (const k of s.tickets) {
      const g = groups.get(k.key) ?? { key: k.key, internal: k.internal, url: k.url, sessions: [], lastActive: 0, live: false };
      if (!g.sessions.some((x) => x.id === s.id)) g.sessions.push({ id: s.id, title: s.title, state: s.state, lastActive: s.lastActive });
      g.lastActive = Math.max(g.lastActive, s.lastActive);
      g.live ||= s.state !== 'ended';
      groups.set(k.key, g);
    }
  }
  return [...groups.values()].sort((a, b) => Number(b.live) - Number(a.live) || b.lastActive - a.lastActive)
    .map(({ live: _live, ...g }) => ({ ...g, sessions: g.sessions.sort((a, b) => b.lastActive - a.lastActive) }));
}
