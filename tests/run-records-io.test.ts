import { EXAMPLE_THREAD, EXAMPLE_OTHER_THREAD, EXAMPLE_RUN, EXAMPLE_SECOND_RUN } from './fixtures/codex/ids'
// The `$` reader of the run records over a pretend disk: the record folder first, the ledger fallback, the rollout found by thread id or
// (marked guessed) by delegation-kit's own heuristic, bounded reads, env roots, and no re-read while nothing changed.
import { expect, test } from 'claude-code/testing'
import type { EngineInterface } from 'claude-code'

import { readRunRecords, resolveRoots, RUN_IO } from '../hooks/run-records-io'
import type { RunRecordsRead } from '../hooks/run-records-io'
import { DELEGATIONS, EVENTS, ROLLOUT_FINISHED } from './fixtures/codex/fixtures'

const SESSION = '00000000-0000-4000-8000-000000000001'
const THREAD = EXAMPLE_THREAD
const FIRST = EXAMPLE_RUN
const SECOND = EXAMPLE_SECOND_RUN
const HOME = '/home/u'
const CWD = '/work/acme-notes'
const CACHE = `${HOME}/.cache/delegation-kit`
const CODEX = `${HOME}/.codex`
const DAY = `${CODEX}/sessions/2026/01/01`
const ROLLOUT = `${DAY}/rollout-2026-01-01T12-05-35-${THREAD}.jsonl`
const ROLLOUT_MTIME = Date.parse('2026-01-01T10:06:44.000Z')
const NOW = Date.parse('2026-01-01T10:30:00.000Z')

type Disk = Map<string, { text: string; mtimeMs: number; size?: number }>
type Env = Record<string, string>

/** A pretend `$` over a map of path -> file (a folder exists when a path starts with it); counts reads and program runs. */
function pretend(disk: Disk, env: Env = { HOME }) {
  const reads: string[] = []
  const runs: string[][] = []
  const hasDir = (p: string): boolean => [...disk.keys()].some(k => k.startsWith(`${p}/`))
  const $ = {
    env: { get: async (name: string) => env[name] },
    fs: {
      list: async (p: string) => {
        if (!hasDir(p)) throw new Error('ENOENT')
        const names = new Set([...disk.keys()].filter(k => k.startsWith(`${p}/`)).map(k => k.slice(p.length + 1).split('/')[0]!))
        return [...names].map(name => {
          const f = disk.get(`${p}/${name}`)
          return { name, kind: f ? 'file' : 'dir', size: f ? (f.size ?? f.text.length) : 0, mtimeMs: f?.mtimeMs ?? 0, isLink: false }
        })
      },
      stat: async (p: string) => {
        const f = disk.get(p)
        if (!f) throw new Error('ENOENT')
        return { kind: 'file', size: f.size ?? f.text.length, mtimeMs: f.mtimeMs, isLink: false }
      },
      read: async (p: string) => {
        reads.push(p)
        const f = disk.get(p)
        if (!f) throw new Error('ENOENT')
        return f.text
      },
    },
    process: {
      run: async (argv: string[]) => {
        runs.push(argv)
        const [program, , bytes, path] = argv
        const f = disk.get(path ?? '')
        if (!f) return { exitCode: 1, stdout: '', stderr: '' }
        const n = Number(bytes)
        return { exitCode: 0, stdout: program === 'head' ? f.text.slice(0, n) : f.text.slice(-n), stderr: '' }
      },
    },
  } as unknown as EngineInterface
  return { $, reads, runs }
}

const file = (text: string, mtimeMs = ROLLOUT_MTIME) => ({ text, mtimeMs })
const baseDisk = (): Disk =>
  new Map([
    [`${CACHE}/delegations.jsonl`, file(DELEGATIONS)],
    [`${CACHE}/delegations/${FIRST}/events.jsonl`, file(EVENTS)],
    [ROLLOUT, file(ROLLOUT_FINISHED)],
  ])
const read = ($: EngineInterface, prev?: RunRecordsRead) => readRunRecords($, { cwd: CWD, sessionId: SESSION, now: NOW }, prev)

test('the ledger fallback: both runs of the session, the first with its rollout found by the thread id of events.jsonl', async () => {
  const { $ } = pretend(baseDisk())
  const { records } = await read($)
  expect(records.map(r => r.runId)).toEqual([FIRST, SECOND])
  expect(records[0]?.transcript).toMatchObject({ format: 'codex-rollout', path: ROLLOUT, threadId: THREAD, confidence: 'exact', eventsPath: `${CACHE}/delegations/${FIRST}/events.jsonl` })
  expect(records[0]).toMatchObject({ status: 'ok', title: 'Add note search', ticket: 'T1' })
})

test('a run with no thread id and a rollout of its workdir at/after its start: found, and marked guessed', async () => {
  const disk = baseDisk()
  disk.delete(`${CACHE}/delegations/${FIRST}/events.jsonl`)
  const { $ } = pretend(disk)
  const { records } = await read($)
  expect(records[0]?.transcript).toMatchObject({ path: ROLLOUT, threadId: THREAD, confidence: 'guessed', format: 'codex-rollout' })
  // the second run started at 10:20, after that rollout began: nothing to guess, so no path (and no pretence)
  expect(records[1]?.transcript?.path).toBeUndefined()
  expect(records[1]?.transcript?.confidence).toBeUndefined()
})

test('the guess needs the same workdir and a rollout written at/after the start', async () => {
  const other = pretend(new Map([...baseDisk()].filter(([k]) => !k.includes('/events.jsonl')).map(([k, v]) => [k, k === ROLLOUT ? file(ROLLOUT_FINISHED.replace('"cwd":"/work/acme-notes"', '"cwd":"/work/elsewhere"')) : v])))
  expect((await read(other.$)).records[0]?.transcript?.path).toBeUndefined()
  const old = pretend(new Map([...baseDisk()].filter(([k]) => !k.includes('/events.jsonl')).map(([k, v]) => [k, k === ROLLOUT ? file(ROLLOUT_FINISHED, Date.parse('2026-01-01T10:00:00.000Z')) : v])))
  expect((await read(old.$)).records[0]?.transcript?.path).toBeUndefined()
})

test('a rollout of another day folder far from the start is not looked at', async () => {
  const disk = baseDisk()
  disk.delete(ROLLOUT)
  disk.set(`${CODEX}/sessions/2026/10/01/rollout-2026-10-01T10-00-00-${THREAD}.jsonl`, file(ROLLOUT_FINISHED))
  expect((await read(pretend(disk).$)).records[0]?.transcript).toMatchObject({ threadId: THREAD })
  expect((await read(pretend(disk).$)).records[0]?.transcript?.path).toBeUndefined()
})

test('a record in `.router/runs` is preferred over the ledger row of the same run; other sessions, garbage and big files are ignored', async () => {
  const disk = baseDisk()
  const rec = { v: 1, runId: FIRST, harness: 'codex', sessionId: SESSION, startedAt: '2026-01-01T10:05:34.409Z', status: 'ok', title: 'From the record', transcript: { format: 'codex-rollout', path: '/elsewhere/rollout.jsonl' } }
  disk.set(`${CWD}/.router/runs/${FIRST}.json`, file(JSON.stringify(rec)))
  disk.set(`${CWD}/.router/runs/other.json`, file(JSON.stringify({ ...rec, runId: 'o-codex-000000', sessionId: 'someone-else' })))
  disk.set(`${CWD}/.router/runs/broken.json`, file('{"v":1,'))
  disk.set(`${CWD}/.router/runs/huge.json`, { text: '{}', mtimeMs: 1, size: RUN_IO.MAX_FILE_BYTES + 1 })
  disk.set(`${CWD}/.router/runs/notes.txt`, file('hello'))
  const { $, reads } = pretend(disk)
  const { records } = await read($)
  expect(records.map(r => [r.runId, r.title])).toEqual([[FIRST, 'From the record'], [SECOND, 'Review empty-note export']])
  expect(records[0]?.transcript).toMatchObject({ path: '/elsewhere/rollout.jsonl', confidence: 'exact' }) // a named path is kept as is
  expect(reads).not.toContain(`${CWD}/.router/runs/huge.json`)
  expect(reads).not.toContain(`${CWD}/.router/runs/notes.txt`)
})

test('an events path outside delegation-kit`s delegations folder is not trusted', async () => {
  const disk = baseDisk()
  disk.set('/etc/events.jsonl', file(EVENTS.replace(THREAD, EXAMPLE_OTHER_THREAD)))
  const rec = { v: 1, runId: FIRST, harness: 'codex', sessionId: SESSION, startedAt: '2026-01-01T10:05:34.409Z', status: 'ok', transcript: { eventsPath: '/etc/events.jsonl' } }
  disk.set(`${CWD}/.router/runs/${FIRST}.json`, file(JSON.stringify(rec)))
  const { $, runs } = pretend(disk)
  const { records } = await read($)
  expect(records[0]?.transcript?.threadId).toBe(THREAD) // from its own events.jsonl, not the named one
  expect(runs.some(a => a.includes('/etc/events.jsonl'))).toBe(false)
})

test('nothing there: no record folder, no ledger, a failing disk, no HOME -> an empty read, no throw', async () => {
  expect((await read(pretend(new Map()).$)).records).toEqual([])
  expect((await readRunRecords(pretend(new Map(), {}).$, { cwd: CWD, sessionId: SESSION })).records).toEqual([])
  const broken = { env: { get: async () => { throw new Error('x') } }, fs: { list: async () => { throw new Error('x') }, stat: async () => { throw new Error('x') }, read: async () => { throw new Error('x') } }, process: { run: async () => { throw new Error('x') } } } as unknown as EngineInterface
  expect((await read(broken)).records).toEqual([])
})

test('a ledger over the read cap is read through `tail`, its cut first line dropped; the second run (a late row) is still found', async () => {
  const disk = baseDisk()
  const junk = 'x'.repeat(200)
  const text = `${junk}${'\n'}${DELEGATIONS}`
  disk.set(`${CACHE}/delegations.jsonl`, { text, mtimeMs: 1, size: RUN_IO.MAX_LEDGER_BYTES + 1 })
  const { $, runs } = pretend(disk)
  const { records } = await read($)
  expect(runs.some(a => a[0] === 'tail' && a[3] === `${CACHE}/delegations.jsonl`)).toBe(true)
  expect(records.map(r => r.runId)).toEqual([FIRST, SECOND])
})

test('the same files and no run waiting: the previous read comes back untouched, nothing is read again', async () => {
  const disk = baseDisk()
  disk.set(`${CACHE}/delegations.jsonl`, file(DELEGATIONS.split('\n').filter(l => !l.includes(SECOND)).join('\n')))
  const { $, reads, runs } = pretend(disk)
  const first = await read($)
  expect(first.isPending).toBe(false)
  const before = reads.length + runs.length
  const second = await read($, first)
  expect(second).toBe(first)
  expect(reads.length + runs.length).toBe(before)
  disk.set(`${CACHE}/delegations.jsonl`, file(DELEGATIONS.split('\n').filter(l => !l.includes(SECOND)).join('\n') + '\n'))
  expect(await read($, first)).not.toBe(first) // the ledger grew: read again
})

test('a running run still waiting for its rollout is looked for again on the next poll, and the rollout appears', async () => {
  const disk = baseDisk()
  disk.delete(ROLLOUT)
  const { $ } = pretend(disk)
  const first = await read($)
  expect(first.isPending).toBe(true) // the second run is running and has no rollout yet
  expect(first.records[1]).toMatchObject({ status: 'running' })
  expect(await read($, first)).not.toBe(first) // so it is looked for again, not served from the signature
  disk.set(`${CACHE}/delegations.jsonl`, file(DELEGATIONS.split('\n').filter(l => !l.includes(SECOND)).join('\n')))
  expect((await read($)).isPending).toBe(false) // the only run ended long ago: no longer waited for
  const later = await readRunRecords($, { cwd: CWD, sessionId: SESSION, now: Date.parse('2026-01-01T10:06:50.000Z') }, undefined)
  expect(later.isPending).toBe(true) // ended 6 s ago and no rollout yet
  disk.set(ROLLOUT, file(ROLLOUT_FINISHED))
  const found = await readRunRecords($, { cwd: CWD, sessionId: SESSION, now: Date.parse('2026-01-01T10:06:55.000Z') }, later)
  expect(found).not.toBe(later)
  expect(found.records[0]?.transcript?.path).toBe(ROLLOUT)
  expect(found.isPending).toBe(false)
})

test('a guess found once stays (the previous read is remembered) and stays marked guessed', async () => {
  const disk = baseDisk()
  disk.delete(`${CACHE}/delegations/${FIRST}/events.jsonl`)
  const { $ } = pretend(disk)
  const first = await read($)
  disk.set(`${CACHE}/delegations.jsonl`, file(`${DELEGATIONS}\n`))
  const again = await read($, first)
  expect(again.records[0]?.transcript).toMatchObject({ path: ROLLOUT, confidence: 'guessed' })
})

test('roots: the options win, then delegation-kit`s env (DELEGATION_KIT_CACHE_DIR, then DELEGATION_KIT_CACHE), CODEX_HOME, then the home folder', async () => {
  const roots = (env: Env, opts = {}) => resolveRoots(pretend(new Map(), env).$, opts)
  expect(await roots({ HOME })).toEqual({ cacheRoot: CACHE, codexHome: CODEX })
  expect(await roots({ HOME: `${HOME}/`, DELEGATION_KIT_CACHE_DIR: '~/kit', CODEX_HOME: '/alt/codex' })).toEqual({ cacheRoot: `${HOME}/kit`, codexHome: '/alt/codex' })
  expect((await roots({ HOME, DELEGATION_KIT_CACHE: '/legacy' })).cacheRoot).toBe('/legacy')
  expect((await roots({ HOME, DELEGATION_KIT_CACHE_DIR: '/new', DELEGATION_KIT_CACHE: '/legacy' })).cacheRoot).toBe('/new')
  expect(await roots({ HOME, CODEX_HOME: '/alt' }, { cacheRoot: '/given/cache', codexHome: '/given/codex' })).toEqual({ cacheRoot: '/given/cache', codexHome: '/given/codex' })
  expect(await roots({})).toEqual({ cacheRoot: undefined, codexHome: undefined })
})

test('a run with another harness keeps its record and gets no rollout lookup', async () => {
  const disk = baseDisk()
  const agy = JSON.stringify({ id: 'a-agy-123456', status: 'running', startedAt: '2026-01-01T10:25:00.000Z', harness: 'agy', sessionId: SESSION, description: 'An agy run' })
  disk.set(`${CACHE}/delegations.jsonl`, file(`${DELEGATIONS}${agy}\n`))
  const { records } = await read(pretend(disk).$)
  const run = records.find(r => r.harness === 'agy')
  expect(run).toMatchObject({ title: 'An agy run', status: 'running', transcript: { format: 'agy-transcript' } })
  expect(run?.transcript?.path).toBeUndefined()
})
