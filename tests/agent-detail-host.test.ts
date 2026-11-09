// The host half of the drill-down with a stand-in `$`: which page requests count, when the transcript is read, that nothing is
// read or written for an agent nobody asked about, redaction on the way out, and that a request goes stale or is closed.
import { expect, test } from 'claude-code/testing'

import { AGENT_CLOSE_EVENT, AGENT_EVENT, AGENTS_INFO_SCENE_ID } from '../hooks/agents-info-scene'
import type { AgentRow } from '../hooks/agents-info-data'
import { DETAIL_FILE_NAME, DETAIL_HOST, DETAIL_REASON, DETAIL_STUB, detailTick, resetDetail, startDetailLoop, wantFrom } from '../hooks/agent-detail-host'
import type { BoardLane } from '../types'
import type { DetailBind, DetailSource } from '../hooks/agent-detail-host'
import type { SessionRow } from '../hooks/sessions-state'

const NOW = 1_767_000_000_000
const DIR = '/tmp/t/agents-info/sess-1'
const EVENTS = '/tmp/t/panel-sess-1.events.jsonl'
const HOME = '/Users/a'
const SESSION = 'sess-1'
const MAIN_PATH = `${HOME}/.claude/projects/p/${SESSION}.jsonl`
const AGENT_PATH = `${HOME}/.claude/projects/p/${SESSION}/subagents/agent-ag1.jsonl`
const MIN = 60_000
const SIBLING = 'sib-0001'
const SIBLING_PATH = `${HOME}/.claude/projects/q/${SIBLING}.jsonl`
const SIBLING_LINE = (id: string, text: string) => JSON.stringify({ type: 'assistant', timestamp: new Date(NOW - MIN).toISOString(), message: { id: id, content: [{ type: 'text', text }] } })
const SIBLING_TEXT = `${SIBLING_LINE('m8', 'cut by the partial read')}\n${SIBLING_LINE('m9', 'Sibling session says hello')}`
const FLUSH_TURNS = 100

const event = (n: number, name: string, data: unknown) => JSON.stringify({ n, t: NOW, scene: AGENTS_INFO_SCENE_ID, name, data })
const row = (over: Partial<AgentRow> = {}): AgentRow => ({
  id: 'ag1', name: 'T1 Agent', short: 'T1', state: 'working', pct: null, startedAt: NOW - 5 * MIN, endedAt: null, tokens: 100, kind: 'logic',
  kindLabel: 'Logic', kindColor: '#34d399', kindGlyph: 'ƒ', headline: '', files: [], loop: 'ag1', isMain: false, ...over,
})
const transcript = [
  JSON.stringify({ type: 'user', timestamp: new Date(NOW - 5 * MIN).toISOString(), message: { content: 'Brief with password=hunter2 inside' } }),
  JSON.stringify({ type: 'assistant', timestamp: new Date(NOW - 4 * MIN).toISOString(), message: { id: 'm1', content: [{ type: 'text', text: 'Working on /Users/a/secret/app.ts' }] } }),
].join('\n')

type Calls = { runs: string[][]; writes: { path: string; text: string }[]; reads: string[] }
function world(opts: { events?: string; size?: number; lanes?: BoardLane[]; sessions?: SessionRow[] } = {}) {
  const calls: Calls = { runs: [], writes: [], reads: [] }
  const files: Record<string, string> = { [EVENTS]: opts.events ?? '' }
  const clock = { now: NOW }
  const $ = {
    clock: { now: async () => clock.now, after: () => 0 },
    env: { get: async (k: string) => (k === 'HOME' ? HOME : undefined) },
    session: { id: async () => SESSION },
    fs: {
      stat: async (p: string) => {
        if (p in files) return { size: files[p]!.length }
        if (p === MAIN_PATH || p === AGENT_PATH || p === SIBLING_PATH) return { size: opts.size ?? transcript.length }
        throw new Error('ENOENT')
      },
      read: async (p: string) => { calls.reads.push(p); if (p in files) return files[p]; throw new Error('ENOENT') },
      write: async (p: string, t: string) => { calls.writes.push({ path: p, text: t }) },
    },
    process: {
      run: async (argv: readonly string[]) => {
        calls.runs.push([...argv])
        if (argv[0] === 'find' && argv.includes(`${SIBLING}.jsonl`)) return { exitCode: 0, stdout: `${SIBLING_PATH}\n` }
        if (argv[0] === 'tail' && argv[3] === SIBLING_PATH) return { exitCode: 0, stdout: SIBLING_TEXT }
        if (argv[0] === 'find') return { exitCode: 0, stdout: argv.join(' ').includes('agent-ag1') ? `${AGENT_PATH}\n` : `${MAIN_PATH}\n` }
        if (argv[0] === 'tail') return { exitCode: 0, stdout: transcript }
        if (argv[0] === 'head') return { exitCode: 0, stdout: transcript.split('\n')[0] }
        return { exitCode: 0, stdout: '' }
      },
    },
  }
  const rows = [row(), row({ id: 'sib', name: 'Sibling', loop: 'sib' }), row({ id: 'main', name: 'Me', isMain: true, loop: 'main' })]
  const lanes = opts.lanes ?? []
  const source: DetailSource = { dir: () => DIR, rows: () => rows, pulse: () => ({ loops: [], events: [], lanes }), sessions: () => opts.sessions ?? [] }
  const bind: DetailBind = { eventsFile: EVENTS, isCurrent: async () => true }
  return { $: $ as never, calls, files, clock, source, bind }
}
/** The stand-in `$` answers at once, so the loop's fire-and-forget start is done after a few turns of the promise queue. */
const flush = async (): Promise<void> => {
  for (let i = 0; i < FLUSH_TURNS; i++) await Promise.resolve()
}
const detailWrites = (c: Calls) => c.writes.filter(w => w.path.endsWith(`.${DETAIL_FILE_NAME}.tmp`))

test('wantFrom: the last request of the page wins; a close ends it; other scenes, bad ids and no events say nothing; pages are clamped', () => {
  expect(wantFrom([], NOW)).toBeUndefined()
  expect(wantFrom([{ scene: AGENTS_INFO_SCENE_ID, name: AGENT_EVENT, data: { id: 'a', pages: 2 } }], NOW)).toEqual({ id: 'a', pages: 2, at: NOW })
  expect(wantFrom([{ scene: AGENTS_INFO_SCENE_ID, name: AGENT_EVENT, data: { id: 'a' } }, { scene: AGENTS_INFO_SCENE_ID, name: AGENT_EVENT, data: { id: 'b', pages: 999 } }], NOW)).toMatchObject({ id: 'b', pages: 8 })
  expect(wantFrom([{ scene: AGENTS_INFO_SCENE_ID, name: AGENT_EVENT, data: { id: 'a' } }, { scene: AGENTS_INFO_SCENE_ID, name: AGENT_CLOSE_EVENT }], NOW)).toBeNull()
  expect(wantFrom([{ scene: 'other', name: AGENT_EVENT, data: { id: 'a' } }], NOW)).toBeUndefined()
  expect(wantFrom([{ scene: AGENTS_INFO_SCENE_ID, name: AGENT_EVENT, data: { id: '../etc/passwd' } }, { scene: AGENTS_INFO_SCENE_ID, name: AGENT_EVENT, data: { id: 5 } }], NOW)).toBeUndefined()
  expect(wantFrom([{ scene: AGENTS_INFO_SCENE_ID, name: AGENT_EVENT, data: { id: 'a', pages: 0 } }], NOW)).toMatchObject({ pages: 1 })
})

test('nobody asked: the transcript is never looked at and nothing is written', async () => {
  resetDetail()
  const w = world()
  await detailTick(w.$, w.source, w.bind)
  expect(w.calls.runs).toEqual([])
  expect(detailWrites(w.calls)).toEqual([])
})

test('a click: the agent\'s own transcript file is found, its end read, and a redacted detail written once; the same look again writes nothing', async () => {
  resetDetail()
  const w = world({ events: `${event(1, AGENT_EVENT, { id: 'ag1', pages: 1 })}\n` })
  await detailTick(w.$, w.source, w.bind)
  const find = w.calls.runs.find(r => r[0] === 'find')!
  expect(find.join(' ')).toContain(`${SESSION}/subagents/agent-ag1.jsonl`)
  expect(w.calls.runs.some(r => r[0] === 'tail' && r[2] === String(DETAIL_HOST.BASE_BYTES))).toBe(true)
  const writes = detailWrites(w.calls)
  expect(writes).toHaveLength(1)
  const detail = JSON.parse(writes[0]!.text)
  expect(detail).toMatchObject({ id: 'ag1', isMain: false, transcript: { isAvailable: true } })
  expect(writes[0]!.text).not.toContain('hunter2')
  expect(writes[0]!.text).not.toContain('/Users/a/secret')
  expect(detail.brief).toContain('Brief with')
  await detailTick(w.$, w.source, w.bind)
  expect(detailWrites(w.calls)).toHaveLength(1)
  // nothing changed but the clock: still rewritten every REFRESH_MS, so the page can tell the host is alive (updatedAt moves)
  w.clock.now += DETAIL_HOST.REFRESH_MS
  await detailTick(w.$, w.source, w.bind)
  const again = detailWrites(w.calls)
  expect(again).toHaveLength(2)
  expect(JSON.parse(again[1]!.text).updatedAt).toBe(detail.updatedAt + DETAIL_HOST.REFRESH_MS)
})

test('the main session reads the session file; asking for more pages reads a bigger tail', async () => {
  resetDetail()
  const w = world({ events: `${event(1, AGENT_EVENT, { id: 'main', pages: 3 })}\n`, size: DETAIL_HOST.BASE_BYTES * 10 })
  await detailTick(w.$, w.source, w.bind)
  expect(w.calls.runs.find(r => r[0] === 'find')!.join(' ')).toContain(`${SESSION}.jsonl`)
  expect(w.calls.runs.some(r => r[0] === 'tail' && r[2] === String(DETAIL_HOST.BASE_BYTES * 3))).toBe(true)
  expect(w.calls.runs.some(r => r[0] === 'head')).toBe(false)
  const detail = JSON.parse(detailWrites(w.calls)[0]!.text)
  expect(detail.transcript).toMatchObject({ pages: 3, isWhole: false, hasMore: true })
})

test('a partial read of a sub-agent file also reads its first line (the brief)', async () => {
  resetDetail()
  const w = world({ events: `${event(1, AGENT_EVENT, { id: 'ag1' })}\n`, size: DETAIL_HOST.BASE_BYTES * 10 })
  await detailTick(w.$, w.source, w.bind)
  expect(w.calls.runs.some(r => r[0] === 'head')).toBe(true)
  expect(JSON.parse(detailWrites(w.calls)[0]!.text).brief).toContain('Brief with')
})

test('an agent the page names that is not a row writes nothing; a request that is not repeated goes stale; a close stops it', async () => {
  resetDetail()
  const unknown = world({ events: `${event(1, AGENT_EVENT, { id: 'nope' })}\n` })
  await detailTick(unknown.$, unknown.source, unknown.bind)
  expect(detailWrites(unknown.calls)).toEqual([])

  resetDetail()
  const w = world({ events: `${event(1, AGENT_EVENT, { id: 'ag1' })}\n` })
  await detailTick(w.$, w.source, w.bind)
  const before = w.calls.runs.length
  w.clock.now += DETAIL_HOST.WANT_TTL_MS + 1
  await detailTick(w.$, w.source, w.bind)
  expect(w.calls.runs.length).toBe(before)

  resetDetail()
  const c = world({ events: `${event(1, AGENT_EVENT, { id: 'ag1' })}\n${event(2, AGENT_CLOSE_EVENT, {})}\n` })
  await detailTick(c.$, c.source, c.bind)
  expect(c.calls.runs).toEqual([])
})

test('a transcript that is not found still gives the metrics, with the reason', async () => {
  resetDetail()
  const w = world({ events: `${event(1, AGENT_EVENT, { id: 'ag1' })}\n` })
  ;(w.$ as { process: { run: (a: readonly string[]) => Promise<unknown> } }).process.run = async (argv: readonly string[]) => { w.calls.runs.push([...argv]); return { exitCode: 0, stdout: '' } }
  await detailTick(w.$, w.source, w.bind)
  const detail = JSON.parse(detailWrites(w.calls)[0]!.text)
  expect(detail.transcript).toMatchObject({ isAvailable: false })
  expect(detail.transcript.reason).toBe(DETAIL_REASON.NOT_FOUND)
  expect(detail.metrics).toBeDefined()
})

test('a transcript that was not found is looked for again only after LOCATE_RETRY_MS (the find walks every project folder)', async () => {
  resetDetail()
  const w = world({ events: `${event(1, AGENT_EVENT, { id: 'ag1' })}\n` })
  ;(w.$ as { process: { run: (a: readonly string[]) => Promise<unknown> } }).process.run = async (argv: readonly string[]) => { w.calls.runs.push([...argv]); return { exitCode: 0, stdout: '' } }
  const finds = () => w.calls.runs.filter(a => a[0] === 'find').length
  await detailTick(w.$, w.source, w.bind)
  expect(finds()).toBe(1)
  w.clock.now += DETAIL_HOST.REFRESH_MS
  await detailTick(w.$, w.source, w.bind)
  expect(detailWrites(w.calls)).toHaveLength(2)
  expect(finds()).toBe(1)
  w.clock.now += DETAIL_HOST.LOCATE_RETRY_MS
  await detailTick(w.$, w.source, w.bind)
  expect(finds()).toBe(2)
})

test('the loop starts by writing the stub (so the page\'s first read is no 404) and ignores requests that were already in the file', async () => {
  resetDetail()
  const w = world({ events: `${event(1, AGENT_EVENT, { id: 'ag1' })}\n` })
  startDetailLoop(w.$, w.source, w.bind)
  await flush()
  const writes = detailWrites(w.calls)
  expect(writes).toHaveLength(1)
  expect(writes[0]!.text).toBe(DETAIL_STUB)
  expect(w.calls.runs.some(r => r[0] === 'tail')).toBe(false)
})

test('a loop that is no longer the current one does nothing', async () => {
  resetDetail()
  const w = world({ events: `${event(1, AGENT_EVENT, { id: 'ag1' })}\n` })
  startDetailLoop(w.$, w.source, { ...w.bind, isCurrent: async () => false })
  await flush()
  expect(w.calls.runs.filter(r => r[0] === 'find' || r[0] === 'tail')).toEqual([])
})

const lane = (over: Partial<BoardLane> = {}): BoardLane => ({
  id: 'sib', label: 'Sibling', state: 'working', pct: null, step: '', note: '', goal: '', dod: [], at: null, startedAt: NOW - MIN, updatedAt: NOW, by: 'main', loop: 'sib', ...over,
})

test('a lane that stands for another session opens that session\'s transcript, found by its own file name like main (no head read), and cached', async () => {
  resetDetail()
  const w = world({ events: `${event(1, AGENT_EVENT, { id: 'sib' })}\n`, lanes: [lane({ session: SIBLING })], size: DETAIL_HOST.BASE_BYTES * 10 })
  await detailTick(w.$, w.source, w.bind)
  const find = w.calls.runs.find(r => r[0] === 'find')!
  expect(find).toEqual(['find', `${HOME}/.claude/projects`, '-maxdepth', '2', '-type', 'f', '-name', `${SIBLING}.jsonl`])
  expect(w.calls.runs.some(r => r[0] === 'head')).toBe(false)
  expect(JSON.parse(detailWrites(w.calls)[0]!.text).transcript).toMatchObject({ isAvailable: true })
  expect(detailWrites(w.calls)[0]!.text).toContain('Sibling session says hello')
  w.clock.now += DETAIL_HOST.REFRESH_MS
  await detailTick(w.$, w.source, w.bind)
  expect(w.calls.runs.filter(r => r[0] === 'find')).toHaveLength(1)
})

test('a lane with no session keeps the old behaviour: no sub-agent file, so NOT_FOUND', async () => {
  resetDetail()
  const w = world({ events: `${event(1, AGENT_EVENT, { id: 'sib' })}\n`, lanes: [lane()] })
  ;(w.$ as { process: { run: (a: readonly string[]) => Promise<unknown> } }).process.run = async (argv: readonly string[]) => { w.calls.runs.push([...argv]); return { exitCode: 0, stdout: '' } }
  await detailTick(w.$, w.source, w.bind)
  expect(w.calls.runs.find(r => r[0] === 'find')!.join(' ')).toContain(`${SESSION}/subagents/agent-sib.jsonl`)
  expect(JSON.parse(detailWrites(w.calls)[0]!.text).transcript.reason).toBe(DETAIL_REASON.NOT_FOUND)
})

test('a lane whose session file is missing is looked for again only after LOCATE_RETRY_MS; an unsafe session id is never searched', async () => {
  resetDetail()
  const w = world({ events: `${event(1, AGENT_EVENT, { id: 'sib' })}\n`, lanes: [lane({ session: SIBLING })] })
  ;(w.$ as { process: { run: (a: readonly string[]) => Promise<unknown> } }).process.run = async (argv: readonly string[]) => { w.calls.runs.push([...argv]); return { exitCode: 0, stdout: '' } }
  const finds = () => w.calls.runs.filter(a => a[0] === 'find').length
  await detailTick(w.$, w.source, w.bind)
  w.clock.now += DETAIL_HOST.REFRESH_MS
  await detailTick(w.$, w.source, w.bind)
  expect(finds()).toBe(1)
  w.clock.now += DETAIL_HOST.LOCATE_RETRY_MS
  await detailTick(w.$, w.source, w.bind)
  expect(finds()).toBe(2)

  resetDetail()
  const bad = world({ events: `${event(1, AGENT_EVENT, { id: 'sib' })}\n`, lanes: [lane({ session: '../x' })] })
  await detailTick(bad.$, bad.source, bad.bind)
  expect(bad.calls.runs.filter(r => r[0] === 'find')).toEqual([])
  expect(JSON.parse(detailWrites(bad.calls)[0]!.text).transcript.reason).toBe(DETAIL_REASON.NOT_FOUND)
})

const SESSION_ROW: SessionRow = { id: SIBLING, title: 'Fix login', state: 'waiting', project: 'alpha' }

test('a click on a card of the Other sessions frame: the page asks for that session id; the host builds a detail from `<session>.jsonl` with the card\'s name and state', async () => {
  resetDetail()
  const w = world({ events: `${event(1, AGENT_EVENT, { id: SIBLING })}\n`, sessions: [SESSION_ROW], size: DETAIL_HOST.BASE_BYTES * 10 })
  await detailTick(w.$, w.source, w.bind)
  expect(w.calls.runs.find(r => r[0] === 'find')).toEqual(['find', `${HOME}/.claude/projects`, '-maxdepth', '2', '-type', 'f', '-name', `${SIBLING}.jsonl`])
  expect(w.calls.runs.some(r => r[0] === 'head')).toBe(false)
  const detail = JSON.parse(detailWrites(w.calls)[0]!.text)
  expect(detail).toMatchObject({ id: SIBLING, name: 'Fix login', isMain: false, state: 'waiting', transcript: { isAvailable: true } })
  expect(detailWrites(w.calls)[0]!.text).toContain('Sibling session says hello')
})

test('a session id that is not one of the other sessions now builds nothing: no find, no read, no write', async () => {
  resetDetail()
  const w = world({ events: `${event(1, AGENT_EVENT, { id: SIBLING })}\n`, sessions: [{ ...SESSION_ROW, id: 'someone-else' }] })
  await detailTick(w.$, w.source, w.bind)
  expect(w.calls.runs).toEqual([])
  expect(detailWrites(w.calls)).toEqual([])
})

test('the session states map onto the words of the detail view', async () => {
  for (const [state, word] of [['busy', 'working'], ['waiting', 'waiting'], ['idle', 'done']] as const) {
    resetDetail()
    const w = world({ events: `${event(1, AGENT_EVENT, { id: SIBLING })}\n`, sessions: [{ ...SESSION_ROW, state }] })
    await detailTick(w.$, w.source, w.bind)
    expect(JSON.parse(detailWrites(w.calls)[0]!.text).state).toBe(word)
  }
})
