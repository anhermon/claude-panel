import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import { HISTORY_KEY, startSession, pushForm } from '../hooks/context-history'
import { CONFIG_DEFAULTS, configOf } from '../hooks/panel-config'
import type { EngineInterface } from 'claude-code'
import { BOOKKEEPING_TOOLS, callPlan, contextBlock, CONTEXT_MAX_CHARS, formsOfFrame, forSession, INJECT_COOLDOWN_PROMPTS, initialProactive, MAX_INJECTIONS_PER_SESSION, promptPlan, recordForms, seedOf, taskFromPrompt, TASK_TITLE_CHARS, TASK_WHY } from '../hooks/proactive'
import { profileOf, STACK_RULES } from '../hooks/session-context'
import { BASELINE_TEXT, PASSIVE_BASELINE_TEXT } from '../hooks/spec'
import { boot, CWD, dir, file, SCENE_TOOL, STATE_FILE, TOOL } from './boot'

const COMPOSER = { kind: 'composer' } as const
const WORK = 'Build a cache. Keep its entries bounded.'
const EXPECTED_TASK = { title: 'Build a cache', why: TASK_WHY }
const OTHER_CONTEXT = 'Context from another hook'
const EVENTS_FILE = STATE_FILE.replace(/\.json$/, '.events.jsonl')
const THRESHOLD = CONFIG_DEFAULTS.autoTaskAfterCalls
const READ_TOOL = 'Read'
const READ_PATH = `${CWD}/source.ts`
const FRAME = { id: 'plan', type: 'steps', items: [{ t: 'Implement cache', state: 'doing' }] }
const CONTEXT_BLOCKS = 1
const PROMPT_REPETITIONS = 3
const SCENE_DIR = '/private/tmp/example-scene'
const SCENE_INPUT = { id: 'example', dir: SCENE_DIR, alt: 'A measured example', shot: false }
const VIZ_FRAME = { id: 'flow', type: 'viz', kind: 'sankey', data: { links: [{ from: 'Work', to: 'Tests', value: 1 }] } }

const submit = ($: Engine, text = WORK, extra: object = {}) => $.prompt.submit({ text, wait: false, origin: COMPOSER, ...extra })
const call = ($: Engine, extra: object = {}) => $.tool.call({ tool: READ_TOOL, file_path: READ_PATH, ...extra })
const stateOf = (b: Awaited<ReturnType<typeof boot>>) => JSON.parse(b.writes.filter(w => w.path === STATE_FILE).at(-1)?.text ?? 'null')

const sessionBox = { id: 'sess-1' }
async function setup($: Engine, on: Parameters<typeof boot>[1], isDropping = { value: false }, texts: Record<string, string> = {}, markers: string[] = ['tsconfig.json']) {
  sessionBox.id = 'sess-1'
  return boot($, on, { sessionId: () => sessionBox.id, texts, files: { [SCENE_DIR]: dir(), [`${SCENE_DIR}/index.html`]: file() }, setup: on => {
    on('prompt.submit', { text: /./ }, (_, e, next) => next({ ...e, context: [...(e.context ?? []), OTHER_CONTEXT] }))
    on('prompt.submit', (_, e) => isDropping.value ? { drop: 'Blocked for test' } : { text: e.text, context: e.context })
    on('tool.call', { tool: READ_TOOL }, () => ({ result: 'read' }))
    on('tool.call', { tool: /^(ToolSearch|TodoWrite|Skill)$/ }, () => ({ result: 'bookkeeping' }))
    on('fs.list', () => ({ value: markers.map(name => ({ name, kind: 'file' as const, size: 0, mtimeMs: 0, isLink: false })) }))
    on('session.repo', () => ({ value: null }))
    on('prompt.compose', () => ({ sections: [] }))
  } })
}

const BUILD = 'build'
const TITLE = 'Build a cache'
const fakeEngine = (session: object) => ({ session, clock: { now: async () => 0 }, store: { get: async () => undefined, set: async () => undefined } }) as unknown as EngineInterface

test('pure prompt plans inject once, chat keeps the stored title and only restarts the count', () => {
  const chat = promptPlan(initialProactive(), 'chat', '')
  expect(chat.inject).toBe(false)
  const first = promptPlan(chat.state, BUILD, TITLE)
  expect(first.inject).toBe(true)
  expect(promptPlan(first.state, BUILD, TITLE).inject).toBe(false)
  const afterChat = promptPlan({ ...first.state, calls: 3 }, 'chat', '')
  expect(afterChat.state).toMatchObject({ title: TITLE, calls: 0, job: BUILD })
  expect(promptPlan(afterChat.state, BUILD, TITLE).inject).toBe(false)
})

test('a job that flaps does not re-inject: cooldown between notes and a hard cap per session', () => {
  const jobs = ['debug', 'build', 'ops', 'build', 'debug', 'ops'] as const
  let state = initialProactive()
  const injected: boolean[] = []
  for (const job of jobs) {
    const plan = promptPlan(state, job, TITLE)
    injected.push(plan.inject)
    state = plan.state
  }
  expect(injected).toEqual([true, false, false, false, false, false])
  // The cooldown elapses only after INJECT_COOLDOWN_PROMPTS work prompts without a note, and only for a changed job.
  state = promptPlan(initialProactive(), 'debug', TITLE).state
  for (let n = 0; n < INJECT_COOLDOWN_PROMPTS; n++) {
    expect(promptPlan(state, 'ops', TITLE).inject, `prompt ${n}`).toBe(false)
    state = promptPlan(state, 'debug', TITLE).state
  }
  expect(promptPlan(state, 'debug', TITLE).inject).toBe(false)
  expect(promptPlan(state, 'ops', TITLE).inject).toBe(true)
  let capped = initialProactive()
  let notes = 0
  for (let n = 0; n < MAX_INJECTIONS_PER_SESSION * (INJECT_COOLDOWN_PROMPTS + 2); n++) {
    const plan = promptPlan(capped, n % 2 === 0 ? 'ops' : 'debug', TITLE)
    if (plan.inject) notes++
    capped = plan.state
  }
  expect(notes).toBe(MAX_INJECTIONS_PER_SESSION)
})

test('a new work prompt re-arms the safety net; the state keeps only the redacted title, never the prompt', () => {
  const secret = 'Quokka-9000 password=hunter2 wants a cache'
  const armed = promptPlan({ ...initialProactive('a'), seeded: true }, BUILD, taskFromPrompt(secret).title)
  expect(armed.state.seeded).toBe(false)
  expect(JSON.stringify(armed.state)).not.toContain('hunter2')
  expect(Object.keys(armed.state)).not.toContain('prompt')
  expect(forSession(armed.state, 'other')).toEqual(initialProactive('other'))
  expect(forSession(armed.state, 'a')).toBe(armed.state)
})

test('pure call plans honor the threshold, panel exclusions, existing tasks, bookkeeping tools and zero', () => {
  let state = promptPlan(initialProactive(), BUILD, TITLE).state
  expect(callPlan(state, TOOL, THRESHOLD, false).state).toEqual(state)
  expect(callPlan(state, SCENE_TOOL, THRESHOLD, false).state).toEqual(state)
  for (const tool of BOOKKEEPING_TOOLS) for (let n = 0; n < THRESHOLD * 2; n++) state = callPlan(state, tool, THRESHOLD, false).state
  expect(state.calls).toBe(0)
  for (let n = 1; n <= THRESHOLD; n++) {
    const plan = callPlan(state, READ_TOOL, THRESHOLD, false)
    expect(plan.seed).toBe(n === THRESHOLD)
    state = plan.state
  }
  expect(callPlan(state, READ_TOOL, THRESHOLD, false).seed).toBe(false)
  expect(callPlan({ ...state, seeded: false }, READ_TOOL, 0, false).seed).toBe(false)
  expect(callPlan({ ...state, seeded: false }, READ_TOOL, THRESHOLD, true).seed).toBe(false)
  expect(callPlan(initialProactive(), READ_TOOL, THRESHOLD, false).seed).toBe(false)
})

test('task titles use the first sentence, remove private text and bookkeeping, and fit the title cap', () => {
  expect(taskFromPrompt(WORK)).toEqual(EXPECTED_TASK)
  const title = taskFromPrompt('T47 01-cache: Fix Alice files at /Users/Alice/work/app.ts with password=hidden. Next sentence.', ['Alice']).title
  for (const privateText of ['T47', '01-cache', 'Alice', '/Users', '/work', 'hidden', 'Next sentence']) expect(title).not.toContain(privateText)
  expect(taskFromPrompt(`Build ${'a'.repeat(TASK_TITLE_CHARS)}`).title.length).toBeLessThanOrEqual(TASK_TITLE_CHARS)
})

test('task titles drop emails, URLs and drive paths, keep ordinary slash words and short names, and respect e.g.', () => {
  expect(taskFromPrompt('Email bob.smith@example.com about the release').title).toBe('Email [email] about the release')
  expect(taskFromPrompt('Fix ssh://host.example/repo and https://example.com/a/b today').title).toBe('Fix ssh:[path] and https:[path] today')
  expect(taskFromPrompt('Open C:\\Users\\Someone\\file.txt now').title).toBe('Open [path] now')
  expect(taskFromPrompt('Fix read/write race in I/O layer').title).toBe('Fix read/write race in I/O layer')
  expect(taskFromPrompt('Fix src/auth.ts and a/b/c now').title).toBe('Fix [path] and [path] now')
  expect(taskFromPrompt('Ask dev about the dev server', ['dev']).title).toBe('Ask dev about the dev server')
  expect(taskFromPrompt('Ask Angela about it', ['Angela']).title).toBe('Ask [user] about it')
  expect(taskFromPrompt('Compare Postgres vs MySQL e.g. for writes. Then decide.').title).toBe('Compare Postgres vs MySQL e.g. for writes')
  expect(taskFromPrompt('Pick one, i.e. the cheap one. Then go.').title).toBe('Pick one, i.e. the cheap one')
})

test('task titles cut the input first: a 585KB paste finishes fast and never reaches the scrub', () => {
  const paste = `Fix the crash. ${'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0 '.repeat(14_500)}`
  expect(paste.length).toBeGreaterThan(585_000)
  const started = performance.now()
  expect(taskFromPrompt(paste).title).toBe('Fix the crash')
  expect(performance.now() - started).toBeLessThan(500)
})

test('context stays bounded and contains only generic profile text, suggestions and avoidance advice', () => {
  const profile = profileOf({ prompt: 'Review private-project', markers: STACK_RULES.flatMap(r => [...r.markers]), branch: 'private-branch', toolCounts: {} })
  const block = contextBlock(profile, ['riskgrid', 'compare', 'scene'], seedOf('session-a'))
  expect(block.length).toBeLessThanOrEqual(CONTEXT_MAX_CHARS)
  expect(block).toMatch(/^<panel-context>.*<\/panel-context>$/)
  expect(block).toContain('task + why')
  expect(block).toContain('unless the content demands')
  expect(block).toContain('riskgrid, compare.')
  expect(block).not.toContain('scene')
  expect(block).not.toContain('private')
  expect(block).toContain('Candidates:')
  expect(block).not.toContain('Try:')
  expect(seedOf('session-a')).not.toBe(seedOf('session-b'))
  expect(formsOfFrame({ type: 'viz', kind: 'sources' })).toEqual(['viz', 'sources'])
  expect(formsOfFrame(null)).toEqual([])
})

test('configuration defaults, zero, false and invalid input are handled explicitly', () => {
  expect(configOf()).toMatchObject({ proactive: true, autoTaskAfterCalls: THRESHOLD })
  expect(configOf({ proactive: false, autoTaskAfterCalls: 0 })).toMatchObject({ proactive: false, autoTaskAfterCalls: 0 })
  expect(configOf({ proactive: 'false', autoTaskAfterCalls: -1 })).toMatchObject({ proactive: true, autoTaskAfterCalls: THRESHOLD })
})

test('context injection deduplicates by job, ignores non-messages and retries dropped prompts', async ($, on) => {
  const dropping = { value: false }
  await setup($, on, dropping)
  const notice = '[SYSTEM NOTIFICATION - NOT USER INPUT]\n<task-notification><status>completed</status></task-notification>'
  for (const text of ['/help', '!build', 'Thanks', notice]) expect((await submit($, text)).context).toEqual([OTHER_CONTEXT])
  expect((await submit($, WORK, { isMeta: true })).context).toEqual([OTHER_CONTEXT])
  expect((await submit($, WORK, { command: { name: 'help', args: '' } })).context).toEqual([OTHER_CONTEXT])
  dropping.value = true
  expect((await submit($)).drop).toBe('Blocked for test')
  dropping.value = false
  expect((await submit($)).context?.filter(b => b.startsWith('<panel-context>'))).toHaveLength(CONTEXT_BLOCKS)
  for (let n = 0; n < PROMPT_REPETITIONS; n++) expect((await submit($)).context).toEqual([OTHER_CONTEXT])
  // A changed job inside the cooldown gets no second note; one past it does.
  let skipped = 0
  for (; ; skipped++) {
    const context = (await submit($, 'Debug the cache')).context
    if (context?.[0]?.startsWith('<panel-context>') === true) {
      expect(context[0]).toContain('Session: debug')
      break
    }
    expect(context).toEqual([OTHER_CONTEXT])
    expect(skipped).toBeLessThan(INJECT_COOLDOWN_PROMPTS)
  }
  expect(skipped).toBe(INJECT_COOLDOWN_PROMPTS - PROMPT_REPETITIONS)
  expect((await submit($, 'Choose a strategy')).context).toEqual([OTHER_CONTEXT])
})

test('panel context, browser events and another hook context survive in chain order', async ($, on) => {
  const texts = { [EVENTS_FILE]: `${JSON.stringify({ n: 1, t: 1000, scene: 'example', name: 'pick', data: {} })}\n` }
  await setup($, on, { value: false }, texts)
  const entered = await submit($)
  expect(entered.text).toBe(WORK)
  expect(entered.context?.[0]).toContain('<panel-context>')
  expect(entered.context?.[1]).toContain('<panel-events')
  expect(entered.context?.[2]).toBe(OTHER_CONTEXT)
  expect((await submit($)).context).toEqual([OTHER_CONTEXT])
})

test('concurrent same-job prompts inject one context and concurrent calls seed one task', async ($, on) => {
  const b = await setup($, on)
  const entered = await Promise.all(Array.from({ length: PROMPT_REPETITIONS }, () => submit($)))
  expect(entered.flatMap(p => p.context ?? []).filter(c => c.startsWith('<panel-context>')), 'context blocks').toHaveLength(CONTEXT_BLOCKS)
  await Promise.all(Array.from({ length: THRESHOLD + 1 }, () => call($)))
  expect(stateOf(b).task).toEqual(EXPECTED_TASK)
  const taskWrites = b.writes.filter(w => w.path === STATE_FILE && JSON.parse(w.text).task?.why === TASK_WHY)
  expect(taskWrites, 'automatic task writes').toHaveLength(CONTEXT_BLOCKS)
})

test('safety net seeds at the threshold through panel state, once, and a model task replaces it', async ($, on) => {
  const b = await setup($, on)
  await submit($)
  for (let n = 1; n < THRESHOLD; n++) await call($)
  expect(stateOf(b).task).toBeNull()
  await call($)
  expect(stateOf(b).task).toEqual(EXPECTED_TASK)
  expect(b.opened).toContain('panel')
  const seededRev = stateOf(b).rev
  await call($)
  expect(stateOf(b).rev).toBe(seededRev)
  await $.tool.call({ tool: TOOL, task: { title: 'Refined task', why: 'Measured evidence' } })
  expect(stateOf(b).task.title).toBe('Refined task')
  await $.tool.call({ tool: TOOL, clear: true })
  await call($)
  expect(stateOf(b).task).toBeNull()
})

test('zero disables seeding while contextual guidance still works', { options: { autoTaskAfterCalls: 0 } }, async ($, on) => {
  const b = await setup($, on)
  expect((await submit($)).context?.[0]).toContain('<panel-context>')
  for (let n = 0; n <= THRESHOLD; n++) await call($)
  expect(stateOf(b).task).toBeNull()
})

test('proactive false disables guidance, automatic tasks and history recording', { options: { proactive: false } }, async ($, on) => {
  const b = await setup($, on)
  expect((await submit($)).context).toEqual([OTHER_CONTEXT])
  await $.tool.call({ tool: TOOL, frame: FRAME })
  expect(b.stored.has(HISTORY_KEY)).toBe(false)
  for (let n = 0; n <= THRESHOLD; n++) await call($)
  expect(stateOf(b).task).toBeNull()
  const composed = await $.prompt.compose({ model: 'model', promptModel: 'model', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] })
  expect(composed.sections.at(-1)?.text).toBe(PASSIVE_BASELINE_TEXT)
})

test('existing model tasks, chat and subagents do not trigger automatic tasks', async ($, on) => {
  const b = await setup($, on)
  await submit($, 'Thanks')
  for (let n = 0; n <= THRESHOLD; n++) await call($)
  expect(stateOf(b).task).toBeNull()
  await submit($)
  for (let n = 0; n <= THRESHOLD; n++) await call($, { agentId: 'worker' })
  expect(stateOf(b).task).toBeNull()
  await $.tool.call({ tool: TOOL, task: { title: 'Model task' } })
  for (let n = 0; n <= THRESHOLD; n++) await call($)
  expect(stateOf(b).task.title).toBe('Model task')
})

test('successful forms are remembered once; rejected frames are not recorded and stale sessions guide context', async ($, on) => {
  const b = await setup($, on)
  let history = startSession([], 'older-a', 'build', 0)
  history = pushForm(history, 'older-a', 'steps')
  for (const key of ['older-b', 'older-c']) history = pushForm(startSession(history, key, 'build', 0), key, 'steps')
  b.stored.set(HISTORY_KEY, history)
  expect((await submit($)).context?.[0]).toContain('Avoid recent forms')
  await $.tool.call({ tool: TOOL, frame: FRAME })
  await $.tool.call({ tool: TOOL, frame: FRAME })
  await $.tool.call({ tool: TOOL, frame: { id: 'bad', type: 'unknown' } })
  const remembered = b.stored.get(HISTORY_KEY) as { forms: string[] }[]
  expect(remembered.at(-1)?.forms).toEqual(['steps'])
  expect(JSON.stringify(remembered)).not.toContain(WORK)
})

test('successful viz and scene posts record their forms; failures and scene controls add nothing', async ($, on) => {
  const b = await setup($, on)
  await submit($)
  const viz = await $.tool.call({ tool: TOOL, frame: VIZ_FRAME })
  expect(viz.deny).toBeUndefined()
  const scene = await $.tool.call({ tool: SCENE_TOOL, ...SCENE_INPUT })
  expect(scene.deny).toBeUndefined()
  await $.tool.call({ tool: SCENE_TOOL, ...SCENE_INPUT })
  await $.tool.call({ tool: SCENE_TOOL, remove: SCENE_INPUT.id })
  await $.tool.call({ tool: SCENE_TOOL, id: 'bad', dir: '/not-allowed', alt: 'Refused' })
  const remembered = b.stored.get(HISTORY_KEY) as { forms: string[] }[]
  expect(remembered.at(-1)?.forms).toEqual(['viz', 'sankey', 'scene'])
  expect(JSON.stringify(remembered)).not.toContain(SCENE_DIR)
})

test('system prompt section stays static as panel forms change', async ($, on) => {
  await setup($, on)
  for (let n = 0; n < PROMPT_REPETITIONS; n++) await $.tool.call({ tool: TOOL, frame: { ...FRAME, id: `frame-${n}` } })
  const composed = await $.prompt.compose({ model: 'model', promptModel: 'model', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] })
  expect(composed.sections.at(-1)?.text).toBe(BASELINE_TEXT)
})

const SECRET_DIR = 'secret-project'
const SECRET_PROMPT = 'Build the Quokka9000 cache with password=hunter2 for Zed'

test('the injected block and the stored state never carry a directory name or the prompt text', async ($, on) => {
  const b = await setup($, on, { value: false }, {}, [SECRET_DIR, 'tsconfig.json'])
  const block = (await submit($, SECRET_PROMPT)).context?.find(c => c.startsWith('<panel-context>')) ?? ''
  expect(block).toContain('TypeScript')
  for (const leak of [SECRET_DIR, 'Quokka9000', 'hunter2', 'Zed']) expect(block).not.toContain(leak)
  for (let n = 0; n < THRESHOLD; n++) await call($)
  const written = JSON.stringify(b.writes.map(w => w.text))
  for (const leak of [SECRET_DIR, 'hunter2']) expect(written).not.toContain(leak)
  expect(JSON.stringify([...b.stored.values()])).not.toContain('Quokka9000')
})

test('only prompts the person sent act: automated origins neither inject nor seed', async ($, on) => {
  const b = await setup($, on)
  for (const kind of ['scheduled-trigger', 'task-notification', 'peer', 'sdk', 'peer-send-message', 'unclassified'])
    expect((await submit($, WORK, { origin: { kind } })).context, kind).toEqual([OTHER_CONTEXT])
  for (let n = 0; n <= THRESHOLD; n++) await call($)
  expect(stateOf(b).task).toBeNull()
  expect((await submit($, WORK, { origin: { kind: 'bridge' } })).context?.[0]).toContain('<panel-context>')
})

test('a new session id starts clean: the same job is announced again and old counts do not seed', async ($, on) => {
  const b = await setup($, on)
  expect((await submit($)).context?.[0]).toContain('<panel-context>')
  expect((await submit($)).context).toEqual([OTHER_CONTEXT])
  for (let n = 1; n < THRESHOLD; n++) await call($)
  sessionBox.id = 'sess-2'
  await call($)
  expect(stateOf(b).task).toBeNull()
  expect((await submit($)).context?.[0]).toContain('<panel-context>')
})

test('a new work prompt re-arms the safety net after the board was cleared', async ($, on) => {
  const b = await setup($, on)
  await submit($)
  for (let n = 0; n < THRESHOLD; n++) await call($)
  expect(stateOf(b).task).toEqual(EXPECTED_TASK)
  await $.tool.call({ tool: TOOL, clear: true })
  await submit($, 'Debug the flaky test')
  for (let n = 0; n < THRESHOLD; n++) await call($)
  expect(stateOf(b).task.title).toBe('Debug the flaky test')
})

test('an approval after a plan still starts the task; bookkeeping tools do not count', async ($, on) => {
  const b = await setup($, on)
  await submit($)
  await submit($, 'yes, do it')
  for (const tool of ['ToolSearch', 'TodoWrite', 'Skill'] as const) for (let n = 0; n <= THRESHOLD; n++) await $.tool.call({ tool } as never)
  expect(stateOf(b).task).toBeNull()
  for (let n = 0; n < THRESHOLD; n++) await call($)
  expect(stateOf(b).task).toEqual(EXPECTED_TASK)
})

test('a failing session id or clock while remembering forms never fails the call', async () => {
  const broken = fakeEngine({ id: () => Promise.reject(new Error('no session')) })
  await expect(recordForms(broken, ['steps'])).resolves.toBeUndefined()
  const noClock = { ...fakeEngine({ id: async () => 'k' }), clock: { now: () => Promise.reject(new Error('no clock')) } } as unknown as EngineInterface
  await expect(recordForms(noClock, ['steps'])).resolves.toBeUndefined()
})

test('a task-only panel call after a motion prompt is nudged toward the motion kinds; a plain build prompt is not', async ($, on) => {
  const motion = await setup($, on)
  await submit($, 'Build a beat-synced particle animation for the intro video')
  const nudged = JSON.stringify(await $.tool.call({ tool: TOOL, task: { title: 'Intro animation', why: 'Measured evidence' } }))
  expect(nudged).toMatch(/waveform|shotlist|easing|galton|particles|scene3d/)
})
