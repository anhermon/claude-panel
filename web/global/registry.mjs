// Which Claude Code sessions are alive: ~/.claude/sessions/<pid>.json (the registry) cross-checked against `ps`, plus the
// claude processes that have no registry file (`claude --resume <sid>`). A registry entry counts as alive only when its pid
// exists AND the process start time matches `procStart` (a recycled pid must not resurrect a dead session).
// NEVER reads the *.key peer tokens in that folder: only names matching <digits>.json are opened. Pure parsing helpers are
// exported for tests; `readRegistry` / `scanProcesses` are the only I/O. Twin of hooks/sessions-state.ts (liveSessions).
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';

const REGISTRY_NAME = /^(\d+)\.json$/;
const PS_ARGS = ['-axo', 'pid=,ppid=,lstart=,command='];
const PS_TIMEOUT_MS = 8000;
const PS_MAX_BUFFER = 64 * 1024 * 1024;
const PS_LINE = /^\s*(\d+)\s+(\d+)\s+([A-Z][a-z]{2} [A-Z][a-z]{2}\s+\d{1,2} \d{2}:\d{2}:\d{2} \d{4})\s+(.*)$/;
// A path segment that is exactly `claude`, then the arguments. Wrapper programs (`disclaimer ... -- <claude>`) are skipped by name.
const CLAUDE_CMD = /(?:^|\/)claude(?:\s+(.*))?$/;
const WRAPPERS = ['disclaimer'];
const SUBCOMMANDS = ['plugin', 'mcp', 'config', 'doctor', 'update', 'install', 'migrate-installer', 'setup-token', 'auth', 'agents', 'eval', 'test'];
const SESSION_ID_ARG = /(?:^|\s)--(?:resume|session-id|continue-session|r)[ =]([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const PROC_START_TOLERANCE_MS = 2000;
const UNKNOWN = null;

export const isSessionId = (v) => typeof v === 'string' && SESSION_ID.test(v);
const str = (v, max = 200) => (typeof v === 'string' ? v.slice(0, max) : UNKNOWN);
const int = (v) => (Number.isFinite(v) ? v : UNKNOWN);

/** `Thu Nov  5 07:34:30 2026` read as local time and as UTC: the two epoch candidates (procStart is UTC, `ps` local). */
export function epochCandidates(text) {
  if (typeof text !== 'string') return [];
  return [Date.parse(text), Date.parse(`${text} UTC`)].filter(Number.isFinite);
}

/** One registry file's object -> a clean record, or null when it is not a session entry. Unknown fields are dropped. */
export function normalizeEntry(obj) {
  if (obj === null || typeof obj !== 'object' || !Number.isInteger(obj.pid) || !isSessionId(obj.sessionId)) return null;
  return {
    pid: obj.pid,
    sessionId: obj.sessionId.toLowerCase(),
    cwd: str(obj.cwd, 400),
    name: str(obj.name, 80),
    status: obj.status === 'busy' || obj.status === 'idle' ? obj.status : UNKNOWN,
    startedAt: int(obj.startedAt),
    updatedAt: int(obj.statusUpdatedAt ?? obj.updatedAt),
    procStart: str(obj.procStart, 40),
  };
}

/**
 * Every <pid>.json of the sessions folder. A missing folder or an unreadable / invalid file is skipped, never fatal.
 * `cache` (a Map the caller keeps) makes a file be read again only when its mtime or size moved.
 */
export async function readRegistry(dir, cache = new Map()) {
  let names = [];
  try { names = await fs.readdir(dir); } catch { return []; }
  const wanted = names.filter((n) => REGISTRY_NAME.test(n)); // *.key files are never opened
  for (const name of cache.keys()) if (!wanted.includes(name)) cache.delete(name);
  const out = [];
  for (const name of wanted) {
    const file = path.join(dir, name);
    try {
      const st = await fs.stat(file);
      const sig = `${st.mtimeMs}:${st.size}`;
      let hit = cache.get(name);
      if (hit === undefined || hit.sig !== sig) {
        hit = { sig, entry: normalizeEntry(JSON.parse(await fs.readFile(file, 'utf8'))) };
        cache.set(name, hit);
      }
      if (hit.entry !== null) out.push(hit.entry);
    } catch { /* unreadable or invalid: skipped */ }
  }
  return out;
}

/** `ps` output -> Map pid -> { pid, ppid, lstart, sessionId|null, isClaude } . Arguments are parsed for a session id, never kept. */
export function parsePs(text) {
  const procs = new Map();
  for (const line of String(text).split('\n')) {
    const m = PS_LINE.exec(line);
    if (m === null) continue;
    const [, pid, ppid, lstart, command] = m;
    const first = command.split(/\s+/, 1)[0] ?? '';
    const isWrapper = WRAPPERS.includes(path.basename(first));
    const c = isWrapper ? null : CLAUDE_CMD.exec(command);
    const args = c?.[1] ?? '';
    const isClaude = c !== null && !SUBCOMMANDS.includes(args.split(/\s+/, 1)[0] ?? '');
    procs.set(Number(pid), { pid: Number(pid), ppid: Number(ppid), lstart, sessionId: isClaude ? (SESSION_ID_ARG.exec(args)?.[1]?.toLowerCase() ?? null) : null, isClaude });
  }
  return procs;
}

/** Runs ps (no shell) and parses it; null when ps fails. */
export function scanProcesses(exec = execFile) {
  return new Promise((resolve) => {
    exec('ps', PS_ARGS, { timeout: PS_TIMEOUT_MS, maxBuffer: PS_MAX_BUFFER }, (err, stdout) => resolve(err ? null : parsePs(stdout)));
  });
}

/** Is this registry entry's process still the one that registered? */
export function isAlive(entry, procs, toleranceMs = PROC_START_TOLERANCE_MS) {
  const proc = procs.get(entry.pid);
  if (proc === undefined) return false;
  if (entry.procStart === null) return proc.isClaude;
  const started = epochCandidates(proc.lstart);
  return epochCandidates(entry.procStart).some((want) => started.some((got) => Math.abs(got - want) <= toleranceMs));
}

/**
 * Registry entries + process table -> live sessions by id: { sessionId, pid, ..., source: 'registry'|'ps' }.
 * `procs` null (ps failed) trusts nothing: every entry is reported with `unverified: true`.
 */
export function mergeLive(entries, procs, toleranceMs = PROC_START_TOLERANCE_MS) {
  const live = new Map();
  for (const e of entries) {
    if (procs !== null && !isAlive(e, procs, toleranceMs)) continue;
    const prev = live.get(e.sessionId);
    if (prev === undefined || (e.startedAt ?? 0) >= (prev.startedAt ?? 0)) live.set(e.sessionId, { ...e, source: 'registry', unverified: procs === null });
  }
  // A process runs one session at a time: when the registry says which one it runs now (after /clear or a resume in place),
  // the id still on its command line is the session it started as, not a second live one.
  const claimedPids = new Set([...live.values()].map((l) => l.pid));
  for (const p of procs?.values() ?? []) {
    if (p.sessionId === null || live.has(p.sessionId) || claimedPids.has(p.pid)) continue;
    live.set(p.sessionId, { pid: p.pid, sessionId: p.sessionId, cwd: null, name: null, status: UNKNOWN, startedAt: null, updatedAt: null, procStart: null, source: 'ps', unverified: false });
  }
  return live;
}
