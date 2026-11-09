#!/usr/bin/env node
// The fleet feed: every `pollMs` it works out which Claude Code sessions are alive (registry + ps), which transcripts were
// written within the window, reads only what was appended, and writes <stateDir>/state.json atomically (tmp + rename).
//   node feed.mjs            run alone (writes state.json, logs one line per change to stderr)
//   import { createFeed }    used in-process by server.mjs, which serves `feed.state` and the drill-down
// state.json is the contract (schema STATE_SCHEMA): { schema, generatedAt, window, counters, sessions[] }. A global publisher
// plugin may later write the same file; the server only ever reads the shape below. Texts in it are already secret-masked.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DIR_MODE, FILE_MODE, GROUPS, STATE_SCHEMA, fleetConfig } from './config.mjs';
import { mergeLive, readRegistry, scanProcesses, isSessionId } from './registry.mjs';
import { bucketList, newTracker, pendingTool, pollFile } from './transcript.mjs';

const TRANSCRIPT = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
const AGENT_FILE = /^agent-[A-Za-z0-9_-]+\.jsonl$/;
const SUBAGENTS_DIR = 'subagents';
const HOME_PATH = /^(?:\/Users|\/home)\/[^/]+/;

/** Atomic JSON write: a reader sees the old file or the new one, never half. */
export function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: DIR_MODE });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text, { mode: FILE_MODE });
  fs.renameSync(tmp, file);
}

export const groupOf = ({ live, status, ageMs }, cfg) => {
  if (ageMs !== null && ageMs < cfg.runningWriteMs) return GROUPS.RUNNING;
  if (live && status === 'busy') return GROUPS.RUNNING;
  return live ? GROUPS.IDLE : GROUPS.EARLIER;
};

const tilde = (p) => (typeof p === 'string' ? p.replace(HOME_PATH, '~') : null);

/** Project name: the last folder of the working directory, else the transcript folder's last word. */
const projectOf = (cwd, slug) => (cwd !== null ? path.basename(cwd) || cwd : (slug ?? '').split('-').filter(Boolean).pop() ?? null);

/** Scans the projects folder: sessionId -> { file, slug, mtimeMs, size, subs: [{mtimeMs}] }. Missing folders give an empty index. */
export function discover(cfg, counters) {
  const index = new Map();
  let slugs = [];
  try { slugs = fs.readdirSync(cfg.projectsDir); } catch { counters.projectsMissing += 1; return index; }
  for (const slug of slugs) {
    const dir = path.join(cfg.projectsDir, slug);
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const name of names) {
      const m = TRANSCRIPT.exec(name);
      if (m === null) continue;
      const file = path.join(dir, name);
      let st;
      try { st = fs.statSync(file); } catch { continue; }
      counters.filesStat += 1;
      const id = m[1].toLowerCase();
      const prev = index.get(id);
      if (prev === undefined || st.mtimeMs > prev.mtimeMs) index.set(id, { file, slug, mtimeMs: st.mtimeMs, size: st.size, subs: [] });
    }
  }
  return index;
}

/** Subagent transcripts of one session (attributed to the parent): their mtimes. */
function subagentStats(entry) {
  const dir = path.join(path.dirname(entry.file), path.basename(entry.file, '.jsonl'), SUBAGENTS_DIR);
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const subs = [];
  for (const name of names) {
    if (!AGENT_FILE.test(name)) continue;
    try { subs.push({ mtimeMs: fs.statSync(path.join(dir, name)).mtimeMs }); } catch { /* vanished */ }
  }
  return subs;
}

export function createFeed(options = {}) {
  const cfg = options.cfg ?? fleetConfig();
  const nowFn = options.now ?? Date.now;
  const psFn = options.scan ?? scanProcesses;
  const counters = { ticks: 0, rowsParsed: 0, rowsUnparsed: 0, rowsSkipped: 0, rowsDropped: 0, filesRead: 0, filesSkipped: 0, bytesRead: 0, filesStat: 0, projectsMissing: 0, registryMissing: 0, registryInvalid: 0, psFailures: 0, errors: 0 };
  const trackers = new Map();
  const shared = { index: new Map(), subs: new Map(), procs: null, procsAt: 0, discoveredAt: 0, lastJson: '', lastWriteAt: 0 };
  const feed = { cfg, counters, state: emptyState(cfg, nowFn()), trackers, tick, start, stop, fileOf: (id) => shared.index.get(id)?.file ?? null, onState: options.onState ?? null };

  function emptyState(c, now) {
    return { schema: STATE_SCHEMA, generatedAt: now, window: { ms: c.windowMs, since: now - c.windowMs }, counters: {}, sessions: [] };
  }

  function sessionOf(id, tr, live, entry, now) {
    const a = tr.acc;
    const regCwd = live?.cwd ?? null;
    const cwd = a.cwd ?? regCwd;
    const mainMs = entry?.mtimeMs ?? (tr.mtimeMs > 0 ? tr.mtimeMs : null);
    const subs = shared.subs.get(id) ?? [];
    const subLast = subs.reduce((m, s) => Math.max(m, s.mtimeMs), 0);
    const lastWriteAt = Math.max(mainMs ?? 0, subLast) || null;
    const ageMs = lastWriteAt === null ? null : Math.max(0, now - lastWriteAt);
    const isLive = live !== undefined;
    const pending = pendingTool(a);
    const status = isLive ? (live.status ?? 'live') : 'ended';
    const quietMs = mainMs === null ? null : now - mainMs;
    const waiting = isLive && pending !== null && quietMs !== null && quietMs >= cfg.waitingHintMs;
    const u = a.usage;
    const fileBytes = entry?.size ?? Math.max(0, tr.size);
    return {
      id,
      live: isLive,
      pid: live?.pid ?? null,
      source: live?.source ?? (isLive ? null : 'transcript'),
      unverified: live?.unverified === true,
      entrypoint: live?.entrypoint ?? a.entrypoint ?? null,
      version: live?.version ?? a.version ?? null,
      name: live?.name ?? a.slug ?? null,
      registryStatus: live?.status ?? null,
      registryUpdatedAt: live?.updatedAt ?? null,
      procStart: live?.procStart ?? null,
      status,
      group: groupOf({ live: isLive, status: live?.status ?? null, ageMs }, cfg),
      cwd: tilde(cwd),
      project: projectOf(cwd, entry?.slug ?? null),
      branch: a.gitBranch,
      title: a.title,
      model: a.model,
      lastPrompt: a.lastPrompt,
      lastPromptAt: a.lastPromptTs,
      lastSay: a.lastSay,
      tokens: { out: u.out, in: u.in + u.cacheWrite, cacheRead: u.cacheRead },
      tools: { total: a.tools.total, byName: a.tools.byName, byKind: a.tools.byKind },
      errors: a.errors,
      lastError: a.lastError,
      lastErrorAt: a.lastErrorTs,
      currentTool: isLive && pending !== null ? { name: pending.name, label: pending.label, since: pending.ts } : null,
      mayBeWaiting: waiting,
      turns: { count: a.turns.count, lastMs: a.turns.lastMs, avgMs: a.turns.count > 0 ? Math.round(a.turns.totalMs / a.turns.count) : null, maxMs: a.turns.count > 0 ? a.turns.maxMs : null },
      subagents: { total: subs.length, active: subs.filter((s) => now - s.mtimeMs < cfg.subagentActiveMs).length },
      lastWriteAt,
      firstRowAt: a.firstTs,
      transcript: { bytes: fileBytes, readBytes: tr.bytesRead, isPartial: fileBytes > tr.bytesRead, rows: a.rows, unparsedRows: a.unparsed, error: tr.error },
    };
  }

  async function refreshProcesses(now) {
    if (shared.procs !== null && now - shared.procsAt < cfg.psEveryMs) return;
    const procs = await psFn();
    shared.procsAt = now;
    if (procs === null) counters.psFailures += 1;
    shared.procs = procs ?? shared.procs; // ps failed: keep the last table rather than call everything dead
    shared.psOk = procs !== null;
  }

  function refreshIndex(now, wanted) {
    if (now - shared.discoveredAt < cfg.discoverEveryMs) return;
    shared.discoveredAt = now;
    shared.index = discover(cfg, counters);
    shared.subs = new Map();
    for (const id of wanted()) {
      const e = shared.index.get(id);
      if (e !== undefined) shared.subs.set(id, subagentStats(e));
    }
  }

  async function tick() {
    const t0 = nowFn();
    counters.ticks += 1;
    try {
      const entries = readRegistry(cfg.sessionsDir, counters);
      await refreshProcesses(t0);
      const { live, staleIds } = mergeLive(entries, shared.procs, cfg.procStartToleranceMs);
      const since = t0 - cfg.windowMs;
      const recentIds = () => [...shared.index].filter(([, e]) => e.mtimeMs >= since).map(([id]) => id);
      refreshIndex(t0, () => new Set([...recentIds(), ...live.keys()]));
      const wanted = new Set([...live.keys(), ...recentIds()]);
      const ranked = [...wanted].map((id) => ({ id, at: Math.max(shared.index.get(id)?.mtimeMs ?? 0, live.has(id) ? Number.MAX_SAFE_INTEGER : 0) })).sort((a, b) => b.at - a.at).slice(0, cfg.maxTracked);
      const sessions = [];
      const keep = new Set();
      for (const { id } of ranked) {
        const entry = shared.index.get(id);
        if (entry === undefined && !live.has(id)) continue;
        keep.add(id);
        let tr = trackers.get(id);
        if (tr === undefined && entry !== undefined) { tr = newTracker(entry.file); trackers.set(id, tr); }
        if (tr !== undefined && entry !== undefined) {
          if (tr.file !== entry.file) { tr.file = entry.file; }
          try { pollFile(tr, cfg, counters); const st = fs.statSync(entry.file); entry.mtimeMs = st.mtimeMs; entry.size = st.size; } catch { counters.errors += 1; }
        }
        sessions.push(sessionOf(id, tr ?? newTracker(''), live.get(id), entry, t0));
      }
      for (const id of [...trackers.keys()]) if (!keep.has(id)) trackers.delete(id);
      sessions.sort((a, b) => (b.lastWriteAt ?? 0) - (a.lastWriteAt ?? 0));
      const byGroup = (g) => sessions.filter((s) => s.group === g).length;
      const state = {
        schema: STATE_SCHEMA,
        generatedAt: t0,
        window: { ms: cfg.windowMs, since },
        counters: {
          sessions: sessions.length, running: byGroup(GROUPS.RUNNING), idle: byGroup(GROUPS.IDLE), earlier: byGroup(GROUPS.EARLIER),
          registryEntries: entries.length, registryStale: staleIds.size, processesSeen: shared.procs?.size ?? 0, psOk: shared.psOk !== false,
          transcriptsIndexed: shared.index.size, registryMissing: counters.registryMissing, projectsMissing: counters.projectsMissing, rowsParsed: counters.rowsParsed, rowsUnparsed: counters.rowsUnparsed, rowsSkipped: counters.rowsSkipped,
          unknownRowTypes: sessions.length === 0 ? 0 : [...trackers.values()].reduce((n, t) => n + Object.values(t.acc.unknownTypes).reduce((x, y) => x + y, 0), 0),
          bytesRead: counters.bytesRead, errors: counters.errors, tickMs: nowFn() - t0, pollMs: cfg.pollMs,
        },
        sessions,
      };
      publish(state);
    } catch (err) {
      counters.errors += 1;
      process.stderr.write(`fleet feed: tick failed: ${err?.message ?? err}\n`);
    }
  }

  function publish(state) {
    const { generatedAt, counters: c, window, ...stable } = state;
    const { tickMs, ...cstable } = c;
    const json = JSON.stringify({ ...stable, counters: cstable });
    const isChanged = json !== shared.lastJson;
    const isDue = state.generatedAt - shared.lastWriteAt >= cfg.heartbeatMs;
    feed.state = state;
    if (isChanged || isDue) {
      shared.lastJson = json;
      shared.lastWriteAt = state.generatedAt;
      if (options.write !== false) {
        try { writeAtomic(cfg.stateFile, `${JSON.stringify(state)}\n`); } catch (err) { counters.errors += 1; process.stderr.write(`fleet feed: cannot write ${cfg.stateFile}: ${err.message}\n`); }
      }
      feed.onState?.(state, isChanged);
    }
  }

  let timer = null;
  function start() {
    const loop = async () => { await tick(); timer = setTimeout(loop, cfg.pollMs); };
    void loop();
  }
  function stop() { if (timer !== null) clearTimeout(timer); timer = null; }
  return feed;
}

export { bucketList, isSessionId };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const feed = createFeed({ onState: (s, changed) => { if (changed) process.stderr.write(`fleet feed: ${s.sessions.length} sessions (${s.counters.running} running, ${s.counters.idle} idle)\n`); } });
  feed.start();
}
