// The always-loaded cost of the panel: a slim advertised schema (the rest behind `help` and the skill), tools that can wait behind
// ToolSearch, and subagents kept off the board.
import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import { VIZ_KINDS, FRAME_TYPES, FRAME_CAPS, validateFrame } from '../hooks/board-frames'
import { CONFIG_DEFAULTS, configOf } from '../hooks/panel-config'
import { BLOCK_KINDS_HELP, HELP_TOPICS, helpText } from '../hooks/panel-help'
import { contextBlock, MAX_INJECTIONS_PER_SESSION, START_INSTRUCTION } from '../hooks/proactive'
import { profileOf } from '../hooks/session-context'
import { baselineText, FRAME_LIMITS_NOTE, PANEL_LOAD_NOTE, passiveBaselineText, SCENE_LOAD_NOTE, SCENE_TOOL_DESCRIPTION, toolDescription, TOOL_INPUT_SCHEMA } from '../hooks/spec'
import { SUBAGENT_DENY, subagentDeny } from '../hooks/subagent-policy'
import { boot, dir, file, SCENE_TOOL, STATE_FILE, TOOL } from './boot'

const COMPOSER = { kind: 'composer' } as const
const WORK = 'Build a cache. Keep its entries bounded.'
const TOKEN_TARGET = 1150
const BYTES_PER_TOKEN = 4
const FRAME = { id: 'plan', type: 'steps', items: [{ t: 'Implement cache', state: 'doing' }] }
const LANE = { id: 'lint', label: 'Lint', step: 'running', pct: 40 }
const SCENE_DIR = '/private/tmp/example-scene'
const SCENE = { id: 'example', dir: SCENE_DIR, alt: 'An example', shot: false }
const COMPOSE = { model: 'model', promptModel: 'model', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] } as const

const bytes = (v: unknown): number => new TextEncoder().encode(typeof v === 'string' ? v : JSON.stringify(v)).length
const setup = ($: Engine, on: Parameters<typeof boot>[1]) =>
  boot($, on, { sessionId: () => 'sess-1', files: { [SCENE_DIR]: dir(), [`${SCENE_DIR}/index.html`]: file() }, setup: on => {
    on('prompt.submit', (_, e) => ({ text: e.text, context: e.context }))
    on('fs.list', () => ({ value: [] }))
    on('session.repo', () => ({ value: null }))
    on('prompt.compose', () => ({ sections: [] }))
  } })
const stateOf = (b: Awaited<ReturnType<typeof boot>>) => JSON.parse(b.writes.filter(w => w.path === STATE_FILE).at(-1)?.text ?? 'null')

test('options: defaults and odd values', () => {
  expect(CONFIG_DEFAULTS).toMatchObject({ deferScene: true, deferPanel: false, subagentPanel: 'lane-only' })
  expect(configOf()).toMatchObject({ deferScene: true, deferPanel: false, subagentPanel: 'lane-only' })
  expect(configOf({ deferScene: false, deferPanel: true, subagentPanel: 'deny' })).toMatchObject({ deferScene: false, deferPanel: true, subagentPanel: 'deny' })
  expect(configOf({ subagentPanel: 'allow' }).subagentPanel).toBe('allow')
  expect(configOf({ deferScene: 'no', deferPanel: 1, subagentPanel: 'everything' })).toMatchObject({ deferScene: true, deferPanel: false, subagentPanel: 'lane-only' })
})

test('the panel description and schema stay within about 1,150 tokens', () => {
  const tokens = (bytes(toolDescription()) + bytes(TOOL_INPUT_SCHEMA)) / BYTES_PER_TOKEN
  expect(tokens).toBeLessThanOrEqual(TOKEN_TARGET)
  const text = toolDescription() + JSON.stringify(TOOL_INPUT_SCHEMA)
  for (const rare of ['rings{', 'swimlane{', 'sankey', 'BLOCK', 'callout{', 'dod']) expect(text).not.toContain(rare)
  for (const core of ['task{title,why}', 'frame_remove', 'frames_clear', 'viz{kind,data', 'compare{', 'timeline{', 'steps{', 'metric{']) expect(text).toContain(core)
})

test('scene is deferred by default; deferPanel defers the panel too; deferScene false lists both', async ($, on) => {
  const b = await setup($, on)
  expect(b.deferred).toEqual({ [TOOL]: false, [SCENE_TOOL]: true })
})
test('deferPanel registers both tools behind ToolSearch', { options: { deferPanel: true } }, async ($, on) => {
  const b = await setup($, on)
  expect(b.deferred).toEqual({ [TOOL]: true, [SCENE_TOOL]: true })
})
test('deferScene false keeps the scene tool in the prompt', { options: { deferScene: false } }, async ($, on) => {
  const b = await setup($, on)
  expect(b.deferred).toEqual({ [TOOL]: false, [SCENE_TOOL]: false })
})

test('the texts the model reads say how to load a deferred tool', async ($, on) => {
  expect(SCENE_LOAD_NOTE).toBe('ToolSearch select:mcp__panel__scene')
  expect(PANEL_LOAD_NOTE).toBe('ToolSearch select:mcp__panel__panel')
  const both = { deferScene: true, deferPanel: true }
  const neither = { deferScene: false, deferPanel: false }
  expect(baselineText()).toContain(SCENE_LOAD_NOTE)
  expect(baselineText()).not.toContain(PANEL_LOAD_NOTE)
  expect(passiveBaselineText()).toContain(SCENE_LOAD_NOTE)
  expect(baselineText(both)).toContain(PANEL_LOAD_NOTE)
  expect(passiveBaselineText(both)).toContain(PANEL_LOAD_NOTE)
  expect(baselineText(neither)).not.toContain('ToolSearch')
  expect(baselineText(both).split('\n').length).toBeLessThanOrEqual(12)
  expect(toolDescription()).toContain(SCENE_LOAD_NOTE)
  expect(toolDescription(neither)).not.toContain('ToolSearch')
  expect(SCENE_TOOL_DESCRIPTION).not.toContain('ToolSearch')
  // The section of the system prompt follows the options.
  const b = await setup($, on)
  expect(b.registered).toContain(TOOL)
  expect((await $.prompt.compose(COMPOSE)).sections.at(-1)?.text).toBe(baselineText())
})
test('with deferPanel the composed baseline and the prompt note both name the panel load call', { options: { deferPanel: true } }, async ($, on) => {
  await setup($, on)
  expect((await $.prompt.compose(COMPOSE)).sections.at(-1)?.text).toBe(baselineText({ deferScene: true, deferPanel: true }))
  const entered = await $.prompt.submit({ text: WORK, wait: false, origin: COMPOSER })
  expect(entered.context?.[0]).toContain(PANEL_LOAD_NOTE)
  expect(entered.context?.[0]).toContain('<panel-context>')
})
test('without deferPanel the prompt note does not mention ToolSearch', async ($, on) => {
  await setup($, on)
  const entered = await $.prompt.submit({ text: WORK, wait: false, origin: COMPOSER })
  expect(entered.context?.[0]).toContain('<panel-context>')
  expect(entered.context?.[0]).not.toContain('ToolSearch')
})
test('contextBlock puts the load call ahead of the clipped body', () => {
  const profile = profileOf({ prompt: WORK, markers: [], toolCounts: {} })
  expect(contextBlock(profile, [], 1, true)).toMatch(/^<panel-context>Load the panel tool first: ToolSearch select:mcp__panel__panel\. Session:/)
  expect(contextBlock(profile, [], 1)).toBe(contextBlock(profile, [], 1, false))
})

test('help: every frame type, viz kind and group has a topic; unknown topics list them', () => {
  for (const type of FRAME_TYPES.filter(t => t !== 'viz')) expect(helpText(type), type).toContain(`frame type ${type}`)
  for (const kind of VIZ_KINDS) expect(helpText(kind), kind).toContain(`viz kind ${kind}(`)
  expect(helpText('viz')).toContain(`${VIZ_KINDS[0]}(`)
  expect(helpText('viz')).toContain('Choose by shape')
  expect(helpText('cards')).toContain(BLOCK_KINDS_HELP)
  expect(helpText('lane')).toContain('dod[')
  expect(helpText('more')).toContain('labels{')
  expect(helpText('  RINGS ')).toContain('rings{items')
  for (const unknown of ['nope', '', undefined, 3, '__proto__', 'constructor']) expect(helpText(unknown)).toContain(`help topics: ${HELP_TOPICS.join(' ')}`)
})

test('help returns the guide and changes nothing; it must be sent alone', async ($, on) => {
  const b = await setup($, on)
  await $.tool.call({ tool: TOOL, task: { title: 'Keep me' } })
  const before = b.writes.length
  const out = await $.tool.call({ tool: TOOL, help: 'swimlane' })
  expect(String(out.result)).toContain('swimlane{items')
  expect(b.writes.length).toBe(before)
  const mixed = await $.tool.call({ tool: TOOL, help: 'viz', task: { title: 'Other' } })
  expect(String(mixed.deny)).toContain('help must be sent alone')
  expect(stateOf(b).task.title).toBe('Keep me')
})

test('fields left out of the advertised schema are still accepted', async ($, on) => {
  const b = await setup($, on)
  const fields = Object.keys((TOOL_INPUT_SCHEMA as { properties: object }).properties)
  for (const gone of ['cards', 'card', 'card_remove', 'labels', 'done_add', 'canvas', 'clear']) expect(fields).not.toContain(gone)
  const card = { id: 'plan', title: 'Plan', blocks: [{ kind: 'callout', tone: 'info', text: 'Hello' }] }
  expect((await $.tool.call({ tool: TOOL, card, labels: { next: 'Later' }, done_add: ['one'] })).deny).toBeUndefined()
  expect(stateOf(b).cards.map((c: { id: string }) => c.id)).toEqual(['plan'])
  expect(stateOf(b).done).toContain('one')
  const rich = { id: 'tl', type: 'swimlane', items: [{ label: 'a', state: 'working', from: 0, to: 5, segs: [{ k: 'ui', a: 0, b: 5 }] }] }
  expect((await $.tool.call({ tool: TOOL, frame: rich })).deny).toBeUndefined()
  const lane = { id: 'w', goal: 'Ship it', dod: [{ t: 'Tests pass', state: 'todo' }], at: 0 }
  expect((await $.tool.call({ tool: TOOL, lane })).deny).toBeUndefined()
})

test('policy: pure verdicts per mode', () => {
  expect(subagentDeny('allow', true, {})).toBeUndefined()
  expect(subagentDeny('allow', false, { task: { title: 'x' } })).toBeUndefined()
  expect(subagentDeny('deny', false, { lane: LANE })).toBe(SUBAGENT_DENY)
  expect(subagentDeny('lane-only', true, {})).toBe(SUBAGENT_DENY)
  expect(subagentDeny('lane-only', false, { lane: LANE })).toBeUndefined()
  expect(subagentDeny('lane-only', false, { lane: LANE, lane_remove: 'x', frame: FRAME })).toBeUndefined()
  for (const input of [{}, { task: { title: 'x' } }, { lane: LANE, status: 'done' }, { frame_remove: 'a' }, { frames_clear: true }, { help: 'viz' }, { cards: [] }])
    expect(subagentDeny('lane-only', false, input), JSON.stringify(input)).toBe(SUBAGENT_DENY)
  expect(SUBAGENT_DENY).not.toContain('\n')
})

test('lane-only (default): a subagent posts its lane or frame, nothing else; the main session is unchanged', async ($, on) => {
  const b = await setup($, on)
  expect((await $.tool.call({ tool: TOOL, agentId: 'w1', lane: LANE })).deny).toBeUndefined()
  expect((await $.tool.call({ tool: TOOL, agentId: 'w1', frame: FRAME })).deny).toBeUndefined()
  expect((await $.tool.call({ tool: TOOL, agentId: 'w1', lane_remove: 'lint' })).deny).toBeUndefined()
  const before = b.writes.length
  for (const input of [{ task: { title: 'Hijack' } }, { lane: LANE, status: 'done' }, { frames_clear: true }, {}, { help: 'viz' }])
    expect((await $.tool.call({ tool: TOOL, agentId: 'w1', ...input })).deny, JSON.stringify(input)).toBe(SUBAGENT_DENY)
  expect((await $.tool.call({ tool: SCENE_TOOL, agentId: 'w1', ...SCENE })).deny).toBe(SUBAGENT_DENY)
  expect(b.writes.length).toBe(before)
  expect((await $.tool.call({ tool: TOOL, task: { title: 'Main task' } })).deny).toBeUndefined()
  expect((await $.tool.call({ tool: SCENE_TOOL, ...SCENE })).deny).toBeUndefined()
  expect(stateOf(b).task.title).toBe('Main task')
})
test('subagentPanel allow keeps today\'s behaviour', { options: { subagentPanel: 'allow' } }, async ($, on) => {
  const b = await setup($, on)
  expect((await $.tool.call({ tool: TOOL, agentId: 'w1', task: { title: 'Worker task' } })).deny).toBeUndefined()
  expect((await $.tool.call({ tool: SCENE_TOOL, agentId: 'w1', ...SCENE })).deny).toBeUndefined()
  expect(stateOf(b).task.title).toBe('Worker task')
})
test('subagentPanel deny blocks every panel and scene call of a subagent', { options: { subagentPanel: 'deny' } }, async ($, on) => {
  await setup($, on)
  for (const input of [{ lane: LANE }, { frame: FRAME }, { task: { title: 'x' } }])
    expect((await $.tool.call({ tool: TOOL, agentId: 'w1', ...input })).deny).toBe(SUBAGENT_DENY)
  expect((await $.tool.call({ tool: SCENE_TOOL, agentId: 'w1', ...SCENE })).deny).toBe(SUBAGENT_DENY)
  expect((await $.tool.call({ tool: TOOL, lane: LANE })).deny).toBeUndefined()
})

const ok = (n: number, fill = 'x') => fill.repeat(n)
const refused = (frame: unknown): boolean => { try { validateFrame(frame); return false } catch { return true } }
const accepted = (frame: unknown): boolean => !refused(frame)
// Each advertised limit is read back out of the text the model sees, then the validator is probed at it and one over.
const advertised = (re: RegExp): number[] => {
  const m = re.exec(FRAME_LIMITS_NOTE)
  if (m === null) throw new Error(`limit not advertised: ${re}`)
  return m.slice(1).map(Number)
}
const PROBES: { name: string; re: RegExp; build: (n: number[], i: number, len: number) => unknown }[] = []
const probe = (name: string, re: RegExp, builders: ((len: number) => unknown)[]) => PROBES.push({ name, re, build: (_n, i, len) => builders[i]!(len) })
probe('frame title', /frame title<=(\d+)/, [len => ({ id: 'a', type: 'text', title: ok(len), text: 'x' })])
probe('text', /text: text<=(\d+) sub<=(\d+)/, [len => ({ id: 'a', type: 'text', text: ok(len) }), len => ({ id: 'a', type: 'text', text: 'x', sub: ok(len) })])
probe('metric', /metric: value<=(\d+) label<=(\d+)/, [len => ({ id: 'a', type: 'metric', value: ok(len) }), len => ({ id: 'a', type: 'metric', value: '1', label: ok(len) })])
probe('steps', /steps: items<=(\d+) t<=(\d+)/, [
  len => ({ id: 'a', type: 'steps', items: Array.from({ length: len }, () => ({ t: 'x', state: 'todo' })) }),
  len => ({ id: 'a', type: 'steps', items: [{ t: ok(len), state: 'todo' }] }),
])
probe('timeline', /timeline: items<=(\d+) when<=(\d+) text<=(\d+)/, [
  len => ({ id: 'a', type: 'timeline', items: Array.from({ length: len }, () => ({ text: 'x' })) }),
  len => ({ id: 'a', type: 'timeline', items: [{ when: ok(len), text: 'x' }] }),
  len => ({ id: 'a', type: 'timeline', items: [{ text: ok(len) }] }),
])
const side = (over: object) => ({ title: 'T', items: ['x'], ...over })
probe('compare', /compare: title<=(\d+) items<=(\d+) item<=(\d+)/, [
  len => ({ id: 'a', type: 'compare', left: side({ title: ok(len) }), right: side({}) }),
  len => ({ id: 'a', type: 'compare', left: side({ items: Array.from({ length: len }, () => 'x') }), right: side({}) }),
  len => ({ id: 'a', type: 'compare', left: side({ items: [ok(len)] }), right: side({}) }),
])
probe('ask', /ask: q<=(\d+) options<=(\d+) option<=(\d+)/, [
  len => ({ id: 'a', type: 'ask', q: ok(len), options: ['x'] }),
  len => ({ id: 'a', type: 'ask', q: 'q', options: Array.from({ length: len }, () => 'x') }),
  len => ({ id: 'a', type: 'ask', q: 'q', options: [ok(len)] }),
])

test('advertised frame limits equal the validator limits (at the cap accepted, one over refused)', () => {
  let checked = 0
  for (const { name, re, build } of PROBES) {
    advertised(re).forEach((limit, i) => {
      expect(accepted(build([], i, limit)), `${name}[${i}] at ${limit}`).toBe(true)
      expect(refused(build([], i, limit + 1)), `${name}[${i}] at ${limit + 1}`).toBe(true)
      checked++
    })
  }
  expect(checked).toBe(16)
})

test('advertised limits come from FRAME_CAPS and the schema carries the same maxLength', () => {
  const frame = (TOOL_INPUT_SCHEMA.properties.frame.properties) as Record<string, { maxLength?: number }>
  expect(frame.title!.maxLength).toBe(FRAME_CAPS.TITLE_CHARS)
  expect(frame.text!.maxLength).toBe(FRAME_CAPS.TEXT_CHARS)
  expect(frame.id!.maxLength).toBe(FRAME_CAPS.ID_CHARS)
  expect(advertised(/frame title<=(\d+)/)[0]).toBe(frame.title!.maxLength)
  expect(advertised(/text: text<=(\d+)/)[0]).toBe(frame.text!.maxLength)
  expect(toolDescription()).toContain(FRAME_LIMITS_NOTE)
  expect(toolDescription({ deferScene: false, deferPanel: true })).toContain(FRAME_LIMITS_NOTE)
})

test('the first context block carries the proactive guidance even with a long stack', () => {
  const profile = { ...profileOf({ prompt: WORK, markers: [], toolCounts: {} }), stack: ['typescript', 'react', 'postgres', 'kubernetes', 'terraform'] }
  const block = contextBlock(profile, ['riskgrid', 'compare', 'scene'], 7)
  expect(block).toContain(START_INSTRUCTION)
  for (const part of ['3 tool calls', 'task+why', 'evidence', 'one-line', 'Main session']) expect(START_INSTRUCTION).toContain(part)
  expect(START_INSTRUCTION.length).toBeLessThanOrEqual(160)
})
test('the tool description names when to post, in a short note', () => {
  const note = toolDescription().slice(0, toolDescription().indexOf(' Put something'))
  expect(note).toContain('Main session')
  expect(note).toContain('3 tool calls')
  expect(note).toContain('one-line')
  expect(bytes(note) / BYTES_PER_TOKEN).toBeLessThanOrEqual(40)
})
test('work prompts inject the guidance; chat injects nothing; at most three blocks per session', async ($, on) => {
  await setup($, on)
  const first = await $.prompt.submit({ text: WORK, wait: false, origin: COMPOSER })
  expect(first.context?.join('\n')).toContain(START_INSTRUCTION)
  const chat = await $.prompt.submit({ text: 'thanks, that makes sense', wait: false, origin: COMPOSER })
  expect(chat.context ?? []).toEqual([])
  let blocks = 1
  for (const text of ['Fix the login bug in auth.ts', 'Write a migration script for users', 'Refactor the payment service', 'Deploy the staging build', 'Add unit tests for the parser', 'Rename the config keys', 'Debug the flaky checkout test'])
    for (let i = 0; i < 6; i++) {
      const r = await $.prompt.submit({ text, wait: false, origin: COMPOSER })
      if ((r.context ?? []).some(c => c.includes('<panel-context>'))) blocks++
    }
  expect(blocks).toBeLessThanOrEqual(MAX_INJECTIONS_PER_SESSION)
})
