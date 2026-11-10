// The ambient Pulse end to end through the engine (everything beneath the mod stood in for, see boot.ts): a fake
// stream of tool calls from the main loop and from a subagent, the file the pulse keeps, the pulse feed in the board's
// data file, `/panel pulse on|off|status`, and the `lane` part of the panel tool. (The Pulse has no scene of its own:
// it is a frame of the built-in board.)
import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { AgentInfo, On } from 'claude-code'

import { COOLDOWN_MS, LEAD_MS } from '../hooks/pulse-flush'
import { boot, dir, file, RUN, SCENE_TOOL, STATE_FILE, TOOL } from './boot'
import type { BootOptions, Entry } from './boot'

const PULSE_DIR = '/tmp/t/claude-panel/pulse/sess-1'
const PULSE_TEMP = `${PULSE_DIR}/live/.pulse.json.tmp`
const PULSE_FILE = `${PULSE_DIR}/live/pulse.json`
const BOARD_DIR = '/tmp/t/claude-panel/board/sess-1'
const BOARD_DATA_TEMP = `${BOARD_DIR}/live/.data.json.tmp`
const SOURCE_MARK = '/web/builtin/board/'
const SOURCE_FILES = ['index.html', 'board.js', 'board.css', 'notes.md'] // notes.md is no scene file
const AGENT = 'ag-1'
const SECRETS = ['SECRET', '/Users', 'push', '--force', 'origin', 'token', '/private']
const VIZ = '/private/tmp/viz'
const DISK: Record<string, Entry> = { '/tmp/viz': dir(VIZ), [`${VIZ}/index.html`]: file() }

type Json = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
type Setup = {
  /** What `$.agent.list()` answers; change it between calls. */
  agents: AgentInfo[]
  /** How long a `Bash` call takes in the fake tool (the others answer at once). */
  slowMs: number
  /** Answer the next call with this error instead of a result. */
  deny?: string
}

const agentRow = (extra: Partial<AgentInfo>): AgentInfo =>
  ({ id: AGENT, description: 'T25 pulse', type: 'general-purpose', status: 'running', parentModel: 'sonnet', background: true, fork: false, ...extra }) as AgentInfo

/** Boot with the pulse on, a fake tool at the bottom, a fake agent list and the scene's source files on the pretend disk. */
async function pulseBoot($: Engine, on: On, opts: BootOptions = {}, initial: Partial<Setup> = {}) {
  const setup: Setup = { agents: [], slowMs: 0, ...initial }
  const base: Record<string, string> = { ...opts.texts }
  // Any file of web/builtin/board/ reads as a line naming it; everything else is what the test put in `texts`.
  const texts = new Proxy(base, {
    get: (target, key) => (typeof key === 'string' && key.includes(SOURCE_MARK) ? `// ${key.split('/').pop()}\n` : target[key as string]),
  })
  let clock: Awaited<ReturnType<typeof boot>>['clock'] | undefined
  const b = await boot($, on, {
    files: DISK,
    pulse: true,
    ...opts,
    texts,
    setup: o => {
      opts.setup?.(o)
      o('fs.list', (_, e) => ({
        value: e.path.endsWith(SOURCE_MARK.replace(/\/$/, '')) ? SOURCE_FILES.map(name => ({ name, kind: 'file' as const, size: 1, mtimeMs: 1, isLink: false })) : [],
      }))
      o('agent.list', () => ({ value: setup.agents }))
      o('agent.spawn', () => ({ model: 'sonnet', agentId: AGENT }))
      o('turn.start', (_, e) => ({ turnId: e.turnId }))
      o('turn.complete', (_, e) => ({ text: e.answer }))
      o('tool.call', async (_, e) => {
        if (e.tool === 'Bash' && setup.slowMs > 0) await clock?.sleep(setup.slowMs)
        const deny = setup.deny
        setup.deny = undefined
        return deny === undefined ? ({ result: 'done' } as never) : { deny }
      })
    },
  })
  clock = b.clock
  const snapshots = (): Json[] => b.writes.filter(w => w.path === PULSE_TEMP).map(w => JSON.parse(w.text) as Json)
  const snap = (): Json => snapshots().at(-1) ?? {}
  /** The board data written last (the pulse frame is in it while the pulse is on). */
  const data = (): Json => JSON.parse(b.writes.filter(w => w.path === BOARD_DATA_TEMP).at(-1)?.text ?? 'null') as Json
  const frameIds = (): string[] => (data()?.frames ?? []).map((f: Json) => f.id)
  const stateWrites = () => b.writes.filter(w => w.path === STATE_FILE)
  const state = (): Json => JSON.parse(stateWrites().at(-1)?.text ?? 'null') as Json
  /** Let a pending flush happen. */
  const flush = () => b.clock.advance(LEAD_MS + COOLDOWN_MS)
  return { ...b, setup, snapshots, snap, data, frameIds, state, stateWrites, flush, texts: base }
}

const spawn = ($: Engine) =>
  $.agent.spawn({ tool_use_id: 'tu-1', prompt: 'Ticket: T25 (P0)\nGoal: Wire the pulse into the board. Then do SECRET-BODY work.\n\nSECRET-BODY details', description: 'T25 pulse', subagentType: 'general-purpose' } as never)

// ---- start -----------------------------------------------------------------------------------------------------------

test('pulse on: no scene of its own (the board is the one built-in scene), the file is written atomically, the pulse frame is in the board data', async ($, on) => {
  const { writes, ran, state, snap, snapshots, flush, frameIds, data } = await pulseBoot($, on)
  const copied = writes.filter(w => w.path.startsWith(`${BOARD_DIR}/`) && !w.path.includes('/live/')).map(w => w.path.replace(`${BOARD_DIR}/`, ''))
  expect(copied.sort()).toEqual(['board.css', 'board.js', 'index.html'])
  expect(writes.some(w => w.path.startsWith(`${PULSE_DIR}/`) && !w.path.includes('/live/'))).toBe(false)
  expect(state().scenes.map((s: Json) => s.id)).toEqual(['board'])
  expect(state().scenes[0]).toMatchObject({ id: 'board', layout: 'stage', builtin: true, dir: BOARD_DIR, entry: 'index.html', title: 'Board' })
  await flush()
  expect(data().pulse).toBeDefined() // the feed is in the data; the decorative pulse frame is not on the board by itself
  expect(frameIds()).not.toContain('pulse')
  await $.tool.call({ tool: 'Read', file_path: '/home/example/secret/key.pem' })
  await flush()
  expect(snap().loops[0]).toMatchObject({ id: 'main', calls: 1, lastTool: 'Read', lastTarget: 'key.pem', files: ['key.pem'] })
  expect(snap().events.at(-1)).toMatchObject({ loop: 'main', tool: 'Read', target: 'key.pem' })
  // temp file first, then one move onto live/pulse.json
  expect(ran.some(argv => argv.join(' ') === `mv -f -- ${PULSE_TEMP} ${PULSE_FILE}`)).toBe(true)
  expect(snapshots().length).toBeGreaterThan(0)
})

test('an earlier snapshot is read back at start: the counts go on from it', async ($, on) => {
  const earlier = { v: 1, now: 5, session: { turn: 'idle', startedAt: 1, turnStartedAt: 0 }, totals: {}, loops: [{ id: 'main', label: 'main', kind: 'main', status: 'idle', lastTool: 'Edit', lastTarget: 'a.ts', calls: 41, busy: 0, counts: { Edit: 41 }, files: ['a.ts'], startedAt: 1, lastAt: 5 }], lanes: [], events: [] }
  const { snap, flush } = await pulseBoot($, on, { texts: { [PULSE_FILE]: JSON.stringify(earlier) } })
  await $.tool.call({ tool: 'Read', file_path: '/p/b.ts' })
  await flush()
  expect(snap().loops[0]).toMatchObject({ calls: 42, files: ['b.ts', 'a.ts'] })
})

// ---- the stream of calls -------------------------------------------------------------------------------------------------

test('main and subagent calls land in their own loops; only a tool name and a short target are kept', async ($, on) => {
  const { snap, snapshots, flush, setup, writes, data } = await pulseBoot($, on)
  await spawn($)
  setup.agents = [agentRow({})]
  await $.tool.call({ tool: 'Bash', command: 'git push --force origin main' })
  await $.tool.call({ tool: 'WebFetch', url: 'https://user:pw@docs.example.com/private?token=SECRET', prompt: 'SECRET' })
  await $.tool.call({ tool: 'WebSearch', query: 'SECRET-SEARCH', mode: 'standard' })
  await $.tool.call({ tool: 'Read', file_path: '/home/example/proj/src/app.ts', agentId: AGENT })
  await $.tool.call({ tool: 'Read', file_path: '/home/example/proj/src/state.ts', agentId: AGENT })
  await $.tool.call({ tool: 'Bash', command: 'npm test -- --token SECRET', agentId: AGENT })
  await flush()
  const s = snap()
  const main = s.loops.find((l: Json) => l.id === 'main')
  const agent = s.loops.find((l: Json) => l.id === AGENT)
  expect(main).toMatchObject({ calls: 3, counts: { Bash: 1, WebFetch: 1, WebSearch: 1 } })
  expect(agent).toMatchObject({ kind: 'subagent', parent: 'main', label: 'T25 pulse', calls: 3, files: ['state.ts', 'app.ts'], lastTool: 'Bash', lastTarget: 'npm test' })
  const targets = s.events.map((e: Json) => `${e.loop === 'main' ? 'main' : 'agent'}:${e.tool}:${e.target}`)
  expect(targets).toEqual(
    expect.arrayContaining(['main:Bash:git', 'main:WebFetch:docs.example.com', 'main:WebSearch:13 chars', 'agent:Read:app.ts', 'agent:Read:state.ts', 'agent:Bash:npm test']),
  )
  expect(s.totals).toMatchObject({ agents: 1 })
  // with zero effort from anyone the board shows one row per agent (name, state, current action) and the time per agent (main is not an agent: no bar for it)
  expect(data().frames.map((f: Json) => [f.id, f.type, f.size])).toEqual([['now-doing', 'doing', 's'], ['lanes', 'lanes', 'l'], ['bars', 'bars', 's'], ['activity-timeline', 'swimlane', 'm']])
  // the rows say what each agent is FOR (spawn description + the ticket and first goal sentence of its prompt), never a shell word
  expect(data().lanes.map((l: Json) => [l.label, l.state, l.step, l.calls])).toEqual([['main', 'working', '', 3], ['pulse', 'working', '(P0) · Wire the pulse into the board', 3]])
  expect(JSON.stringify(data().lanes)).not.toMatch(/Bash|npm|WebSearch|WebFetch/)
  expect(data().frames.find((f: Json) => f.id === 'bars').title).toBe('Time per agent')
  expect(data().frames.find((f: Json) => f.id === 'bars').items.map((i: Json) => [i.label, i.value])).toEqual([['pulse', 0]]) // the test clock has not moved: 0 minutes
  // nothing the pulse ever wrote (the temp file, whichever write) holds a secret
  const everything = writes.filter(w => w.path.startsWith(`${PULSE_DIR}/live/`)).map(w => w.text).join('\n')
  expect(snapshots().length).toBeGreaterThan(0)
  for (const secret of SECRETS) expect(everything).not.toContain(secret)
})

test('the hook is pass-through: a call is on the pulse while it runs, its result is untouched, a deny is marked', async ($, on) => {
  const { snap, flush, setup, clock } = await pulseBoot($, on, {}, { slowMs: 5000 })
  const pending = $.tool.call({ tool: 'Bash', command: 'sleep 4' })
  await clock.advance(LEAD_MS + 10)
  expect(snap().loops[0]).toMatchObject({ busy: 1, lastTool: 'Bash', lastTarget: 'sleep' }) // seen at once, while it runs
  await clock.advance(5000)
  const done = await pending
  expect(done.result).toBe('done')
  await flush()
  expect(snap().loops[0]).toMatchObject({ busy: 0 })
  setup.deny = 'not allowed'
  const denied = await $.tool.call({ tool: 'Read', file_path: '/p/x.ts' })
  expect(denied.deny).toBe('not allowed')
  await flush()
  expect(snap().events.at(-1)).toMatchObject({ tool: 'Read', target: 'x.ts', err: true })
})

test('writes are coalesced: a burst of 50 calls is one write; a steady stream is at most two a second', async ($, on) => {
  const { snapshots, clock, flush } = await pulseBoot($, on)
  await flush()
  const before = snapshots().length
  for (let i = 0; i < 50; i++) await $.tool.call({ tool: 'Read', file_path: `/p/f${i}.ts` })
  await clock.advance(LEAD_MS)
  expect(snapshots().length - before).toBe(1)
  await flush()
  const mark = snapshots().length
  for (let i = 0; i < 100; i++) {
    await $.tool.call({ tool: 'Read', file_path: '/p/steady.ts' })
    await clock.advance(50)
  }
  expect((snapshots().length - mark) / 5).toBeLessThanOrEqual(2)
})

test('turns and the agent list: a finished agent is done, the main loop goes idle, a listed agent gets its label', async ($, on) => {
  const { snap, flush, setup } = await pulseBoot($, on)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await spawn($)
  setup.agents = [agentRow({ description: 'T25 pulse and lanes', name: 'pulser' })]
  await $.tool.call({ tool: 'Read', file_path: '/p/a.ts', agentId: AGENT })
  await flush()
  expect(snap().session.turn).toBe('running')
  expect(snap().loops.find((l: Json) => l.id === AGENT)).toMatchObject({ status: 'running', label: 'T25 pulse and lanes', name: 'pulser' })
  setup.agents = [agentRow({ status: 'completed' })]
  await $.turn.complete({ answer: 'SECRET ANSWER', durationMs: 5, isAborted: false, turnId: 't-a', reason: 'answer', agentId: AGENT })
  await $.turn.complete({ answer: 'SECRET ANSWER', durationMs: 5, isAborted: false, turnId: 't1', reason: 'answer' })
  await flush()
  expect(snap().session.turn).toBe('idle')
  expect(snap().loops.find((l: Json) => l.id === AGENT)?.status).toBe('done')
  expect(JSON.stringify(snap())).not.toContain('SECRET')
})

test('a turn that ends flushes at once: the file is current before a reload could drop the timers', async ($, on) => {
  const { snapshots, clock } = await pulseBoot($, on)
  await $.tool.call({ tool: 'Read', file_path: '/p/last.ts' })
  const before = snapshots().length
  await $.turn.complete({ answer: '', durationMs: 5, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.settle() // the recording runs beside the hook, not inside it
  expect(snapshots().length).toBeGreaterThan(before)
  expect(snapshots().at(-1)?.events.at(-1)).toMatchObject({ target: 'last.ts' })
})

// ---- /panel pulse -----------------------------------------------------------------------------------------------------------

test('/panel pulse: status, off takes the feed out of the board data and stops recording, on brings both back', async ($, on) => {
  const { data, snapshots, flush, url } = await pulseBoot($, on)
  const run = async (args: string) => (await $.command.run({ command: 'panel', args, ...RUN })).text
  expect(await run('pulse')).toMatch(new RegExp(`^pulse: on · 0 calls · 1 loops · 0 lanes · ${url().replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}s/board/$`))
  expect(await run('pulse status')).toMatch(/^pulse: on/)
  expect(await run('pulse maybe')).toBe('usage: /panel pulse on|off|status')

  expect(await run('pulse off')).toMatch(/^pulse: off/)
  await flush()
  expect(data().pulse).toBeUndefined()
  const quiet = snapshots().length
  await $.tool.call({ tool: 'Read', file_path: '/p/a.ts' })
  await flush()
  expect(snapshots().length).toBe(quiet)

  expect(await run('pulse on')).toMatch(/^pulse: on/)
  await $.tool.call({ tool: 'Read', file_path: '/p/b.ts' })
  await flush()
  expect(data().pulse).toBeDefined()
  expect(snapshots().length).toBeGreaterThan(quiet)
  expect(snapshots().at(-1)?.events.at(-1)).toMatchObject({ target: 'b.ts' })
})

test('PANEL_PULSE=off at start: no board, no pulse files, no recording; /panel pulse on starts it', async ($, on) => {
  const b = await boot($, on, { files: DISK, setup: o => o('fs.list', () => ({ value: [] })) })
  expect(b.writes.some(w => w.path.startsWith(PULSE_DIR))).toBe(false)
  expect(b.last().scenes ?? []).toEqual([])
  const status = await $.command.run({ command: 'panel', args: 'pulse', ...RUN })
  expect(status.text).toMatch(/^pulse: off/)
})

// ---- the built-in scene beside the model's own ----------------------------------------------------------------------------------

test('the scene tool leaves the built-in board alone: clear keeps it, remove is refused with the way out', async ($, on) => {
  const { state } = await pulseBoot($, on)
  const viz = { id: 'viz', dir: '/tmp/viz', alt: 'A visual.', shot: false }
  await $.tool.call({ tool: SCENE_TOOL, ...viz })
  expect(state().scenes.map((s: Json) => s.id)).toEqual(['board', 'viz'])
  expect((await $.tool.call({ tool: SCENE_TOOL, clear: true })).result).toMatch(/^scenes cleared \(1 removed\) \(the built-in board stays/)
  expect(state().scenes.map((s: Json) => s.id)).toEqual(['board'])
  const removed = await $.tool.call({ tool: SCENE_TOOL, remove: 'board' })
  expect(removed.deny).toMatch(/frame_remove/)
  expect(state().scenes.map((s: Json) => s.id)).toEqual(['board'])
  const over = await $.tool.call({ tool: SCENE_TOOL, ...viz, id: 'board' })
  expect(over.deny).toMatch(/frame/)
  expect((await $.tool.call({ tool: SCENE_TOOL, clear: true })).deny).toMatch(/frames_clear/)
})

// ---- lanes ---------------------------------------------------------------------------------------------------------------------------

test('a lane-only panel call answers with the lane, changes no panel section, and lands in the pulse file next to its node', async ($, on) => {
  const { snap, flush, setup, stateWrites } = await pulseBoot($, on)
  await spawn($)
  setup.agents = [agentRow({})]
  await $.tool.call({ tool: 'Read', file_path: '/p/a.ts', agentId: AGENT })
  const before = stateWrites().length
  const r = await $.tool.call({ tool: TOOL, agentId: AGENT, lane: { id: 't25', label: 'T25 pulse', state: 'working', pct: 40, step: 'writing the tests' } })
  expect(r.result).toBe('lane t25 · working 40%')
  expect(stateWrites().length).toBe(before)
  await flush()
  expect(snap().lanes).toHaveLength(1)
  expect(snap().lanes[0]).toMatchObject({ id: 't25', state: 'working', pct: 40, step: 'writing the tests', by: AGENT, loop: AGENT })
  expect(snap().loops.find((l: Json) => l.id === AGENT)?.counts).toMatchObject({ lane: 1 }) // a lane call is agent activity
  // an upsert: only what is sent changes
  const upsert = await $.tool.call({ tool: TOOL, agentId: AGENT, lane: { id: 't25', state: 'testing' } })
  expect(upsert.result).toBe('lane t25 · testing 40%')
  await flush()
  expect(snap().lanes).toHaveLength(1)
  expect(snap().lanes[0]).toMatchObject({ state: 'testing', pct: 40, step: 'writing the tests' })
  const done = await $.tool.call({ tool: TOOL, agentId: AGENT, lane: { id: 't25', state: 'done' } })
  expect(done.result).toBe('lane t25 · done 100%')
  expect((await $.tool.call({ tool: TOOL, agentId: AGENT, lane_remove: 't25' })).result).toBe('lane t25 removed')
  await flush()
  expect(snap().lanes).toEqual([])
})

test('a lane rides along with other panel fields; a lane with no node of its own stands free', async ($, on) => {
  const { snap, flush } = await pulseBoot($, on)
  const r = await $.tool.call({ tool: TOOL, status: 'working', lane: { id: 'plan', label: 'Release plan', state: 'waiting', step: 'a review' } })
  expect(r.result).toContain('lane plan · waiting')
  await flush()
  expect(snap().lanes[0]).toMatchObject({ id: 'plan', by: 'main', loop: null })
})

test('lane refusals name the field and change nothing; twelve active lanes are the limit', async ($, on) => {
  const { snap, flush } = await pulseBoot($, on)
  const denials: [Record<string, unknown>, RegExp][] = [
    [{ lane: { id: 'Bad Id' } }, /^panel: lane\.id "Bad Id" is invalid/],
    [{ lane: { id: 'a', state: 'busy' } }, /^panel: lane\.state "busy" must be one of working, testing, waiting, blocked, done/],
    [{ lane: { id: 'a', pct: 150 } }, /^panel: lane\.pct 150 must be a number from 0 to 100/],
    [{ lane: { id: 'a', colour: 'red' } }, /^panel: lane\.colour is not a known field/],
    [{ lane_remove: 'No Way' }, /^panel: lane_remove "No Way" is invalid/],
  ]
  for (const [input, pattern] of denials) {
    const r = await $.tool.call({ tool: TOOL, ...input })
    expect(r.result).toBeUndefined()
    expect(r.deny).toMatch(pattern)
  }
  for (let i = 0; i < 12; i++) expect((await $.tool.call({ tool: TOOL, lane: { id: `l${i}` } })).result).toBe(`lane l${i} · working`)
  const thirteenth = await $.tool.call({ tool: TOOL, lane: { id: 'one-too-many' } })
  expect(thirteenth.deny).toMatch(/^panel: lane: already 12 active lanes \(l0, .*l11\): finish one \(state "done"\) or remove it with lane_remove before adding "one-too-many"$/)
  // finishing one makes room: the oldest done lane is evicted
  await $.tool.call({ tool: TOOL, lane: { id: 'l4', state: 'done' } })
  expect((await $.tool.call({ tool: TOOL, lane: { id: 'one-too-many' } })).result).toBe('lane one-too-many · working')
  await flush()
  const ids = snap().lanes.map((l: Json) => l.id)
  expect(ids).toHaveLength(12)
  expect(ids).not.toContain('l4')
  expect(ids).toContain('one-too-many')
})

test('with the pulse off a lane still works, and the result says where to see it', async ($, on) => {
  const b = await boot($, on, { files: DISK })
  const r = await $.tool.call({ tool: TOOL, lane: { id: 't25', state: 'working', pct: 40 } })
  expect(r.result).toBe('lane t25 · working 40%\npulse is off: /panel pulse on shows what each agent is doing')
  expect(b.writes.some(w => w.path.startsWith(PULSE_DIR))).toBe(false)
})
