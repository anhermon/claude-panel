// The `$` half of the sessions frame: the registry (`~/.claude/sessions/<pid>.json`), `ps`, the transcript folders and the tail of
// each transcript, judged by ./sessions-state.ts. Cheap by construction: registry files are re-read
// only when their mtime moved, `ps` and the transcript listing at most every PS_EVERY_MS / DISCOVER_EVERY_MS, and a transcript tail
// only when its size or mtime changed, and only for the sessions that can reach the frame. Reads nothing but `<pid>.json` in the
// sessions folder (never the `*.key` tokens). Nothing here throws out of `readSessions`.
import type { EngineInterface } from 'claude-code'

import { DISCOVER_EVERY_MS, PS_EVERY_MS, REGISTRY_NAME, SUBAGENT_NAME, TRANSCRIPT_NAME, candidates, liveSessions, parseEntry, parsePs, readTail, sessionRows } from './sessions-state'
import type { Proc, SessionEntry, SessionFacts, SessionRow, TailRead } from './sessions-state'

type Dollar = EngineInterface

export const SESSIONS_IO = {
  /** The end of a transcript that is read. */
  TAIL_BYTES: 128 * 1024,
  TAIL_TIMEOUT_MS: 5000,
  PS_TIMEOUT_MS: 8000,
  PS_MAX_BUFFER: 64 * 1024 * 1024,
  PS_ARGS: ['-axo', 'pid=,ppid=,lstart=,command='],
  SUBAGENTS_DIR: 'subagents',
} as const

const FALLBACK_HOME = ''

type Indexed = { file: string; slug: string }
type CachedTail = { sig: string; tail: TailRead }
/** What the reader remembers between polls (one per board). */
export type SessionsCache = {
  entries: Map<string, { mtimeMs: number; entry: SessionEntry | undefined }>
  procs: Map<number, Proc> | undefined
  procsAt: number
  index: Map<string, Indexed>
  indexAt: number
  tails: Map<string, CachedTail>
}
export const newSessionsCache = (): SessionsCache => ({ entries: new Map(), procs: undefined, procsAt: -Infinity, index: new Map(), indexAt: -Infinity, tails: new Map() })

/** Claude Code's folder: `$CLAUDE_CONFIG_DIR`, else `~/.claude`. `$.env.get` takes literal names (the engine lists what a module reads). */
export async function claudeDir($: Dollar): Promise<string> {
  const config = await $.env.get('CLAUDE_CONFIG_DIR')
  const home = (await $.env.get('HOME')) ?? FALLBACK_HOME
  return config !== undefined && config !== '' ? config : `${home}/.claude`
}

async function listNames($: Dollar, dir: string): Promise<{ name: string; kind: string; mtimeMs: number }[]> {
  try {
    return (await $.fs.list(dir)).map(e => ({ name: e.name, kind: e.kind, mtimeMs: e.mtimeMs }))
  } catch {
    return []
  }
}

async function readRegistry($: Dollar, cache: SessionsCache, dir: string): Promise<SessionEntry[]> {
  const files = (await listNames($, dir)).filter(e => e.kind === 'file' && REGISTRY_NAME.test(e.name)) // never a `*.key`
  const seen = new Set(files.map(f => f.name))
  for (const name of cache.entries.keys()) if (!seen.has(name)) cache.entries.delete(name)
  for (const f of files) {
    if (cache.entries.get(f.name)?.mtimeMs === f.mtimeMs) continue
    let entry: SessionEntry | undefined
    try {
      const text = await $.fs.read(`${dir}/${f.name}`)
      entry = typeof text === 'string' ? parseEntry(text) : undefined
    } catch {
      entry = undefined
    }
    cache.entries.set(f.name, { mtimeMs: f.mtimeMs, entry })
  }
  return [...cache.entries.values()].map(e => e.entry).filter((e): e is SessionEntry => e !== undefined)
}

async function refreshProcesses($: Dollar, cache: SessionsCache, now: number): Promise<void> {
  if (cache.procs !== undefined && now - cache.procsAt < PS_EVERY_MS) return
  cache.procsAt = now
  try {
    const out = await $.process.run(['ps', ...SESSIONS_IO.PS_ARGS], { timeoutMs: SESSIONS_IO.PS_TIMEOUT_MS })
    if (out.exitCode === 0) cache.procs = parsePs(out.stdout) // ps failed: the last table stays rather than call everything dead
  } catch {
    // keep the last table
  }
}

/** sessionId -> its newest transcript. */
async function refreshIndex($: Dollar, cache: SessionsCache, projects: string, now: number): Promise<void> {
  if (now - cache.indexAt < DISCOVER_EVERY_MS) return
  cache.indexAt = now
  const index = new Map<string, Indexed & { mtimeMs: number }>()
  for (const slug of await listNames($, projects)) {
    if (slug.kind !== 'dir') continue
    for (const f of await listNames($, `${projects}/${slug.name}`)) {
      const m = TRANSCRIPT_NAME.exec(f.name)
      const id = m?.[1]?.toLowerCase()
      if (id === undefined || (index.get(id)?.mtimeMs ?? -1) >= f.mtimeMs) continue
      index.set(id, { file: `${projects}/${slug.name}/${f.name}`, slug: slug.name, mtimeMs: f.mtimeMs })
    }
  }
  cache.index = index
}

const sigOf = (s: { size: number; mtimeMs: number }): string => `${s.size}:${s.mtimeMs}`

async function tailOf($: Dollar, cache: SessionsCache, id: string, file: string, sig: string): Promise<TailRead> {
  const cached = cache.tails.get(id)
  if (cached !== undefined && cached.sig === sig) return cached.tail
  let tail = cached?.tail ?? readTail('')
  try {
    const out = await $.process.run(['tail', '-c', String(SESSIONS_IO.TAIL_BYTES), file], { timeoutMs: SESSIONS_IO.TAIL_TIMEOUT_MS })
    if (out.exitCode === 0) {
      const read = readTail(out.stdout)
      // a tail that holds no prompt (a long run of tool output) keeps the last one seen
      tail = { ...read, prompt: read.prompt ?? cached?.tail.prompt ?? null, title: read.title ?? cached?.tail.title ?? null }
    }
  } catch {
    // the last read stays
  }
  cache.tails.set(id, { sig, tail })
  return tail
}

/** The newest write of the session's subagent transcripts (they count for their parent), or 0. */
async function subagentMs($: Dollar, file: string): Promise<number> {
  const dir = `${file.replace(/\.jsonl$/, '')}/${SESSIONS_IO.SUBAGENTS_DIR}`
  return (await listNames($, dir)).filter(e => SUBAGENT_NAME.test(e.name)).reduce((m, e) => Math.max(m, e.mtimeMs), 0)
}

/** The rows of the other live sessions now (empty: none, `ps` has never answered, or `isOn` is false: the setting is off and nothing is read). */
export async function readSessions($: Dollar, cache: SessionsCache, selfId: string, now: number, isOn = true): Promise<SessionRow[]> {
  if (!isOn) return []
  const root = await claudeDir($)
  const entries = await readRegistry($, cache, `${root}/sessions`)
  await refreshProcesses($, cache, now)
  if (cache.procs === undefined) return []
  const live = liveSessions(entries, cache.procs)
  await refreshIndex($, cache, `${root}/projects`, now)
  const stats = new Map<string, { sig: string; mtimeMs: number }>()
  for (const [id, hit] of cache.index) {
    if (!live.has(id)) continue
    try {
      const s = await $.fs.stat(hit.file)
      stats.set(id, { sig: sigOf(s), mtimeMs: s.mtimeMs })
    } catch {
      // the transcript is gone: the session shows without one
    }
  }
  for (const id of cache.tails.keys()) if (!live.has(id)) cache.tails.delete(id)
  const facts: SessionFacts[] = []
  for (const l of candidates(live, new Map([...stats].map(([id, s]) => [id, s.mtimeMs])), selfId, now)) {
    const hit = cache.index.get(l.sessionId)
    const stat = stats.get(l.sessionId)
    if (hit === undefined || stat === undefined) {
      facts.push({ live: l, slug: hit?.slug ?? null, tail: readTail(''), mainMs: null, lastWriteMs: null })
      continue
    }
    const tail = await tailOf($, cache, l.sessionId, hit.file, stat.sig)
    facts.push({ live: l, slug: hit.slug, tail, mainMs: stat.mtimeMs, lastWriteMs: Math.max(stat.mtimeMs, await subagentMs($, hit.file)) })
  }
  return sessionRows(facts, selfId, now)
}
