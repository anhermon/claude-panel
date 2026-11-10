import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import { FORM_NUDGE_MAX_CHARS, formNudgePlan, formNudgeText, MAX_FORM_NUDGES_PER_SESSION } from '../hooks/form-nudge'
import { initialProactive } from '../hooks/proactive'
import type { ProactiveState } from '../hooks/proactive'
import { BASELINE_TEXT } from '../hooks/spec'
import { boot, TOOL } from './boot'

const COMPOSER = { kind: 'composer' } as const
const WORK = 'Build a cache. Keep its entries bounded.'
const CHAT = 'Thanks'
const TASK = { title: 'Refined task', why: 'Measured evidence' }
const FRAME = { id: 'plan', type: 'steps', items: [{ t: 'Implement cache', state: 'doing' }] }
const NUDGE_MARK = 'add one form that fits it'
const BASELINE_MAX_LINES = 12

const working = (extra: Partial<ProactiveState> = {}): ProactiveState => ({ ...initialProactive('k'), job: 'build', ...extra })
const submit = ($: Engine, text = WORK) => $.prompt.submit({ text, wait: false, origin: COMPOSER })
const panel = async ($: Engine, input: object): Promise<string> => String((await $.tool.call({ tool: TOOL, ...input })).result ?? '')

async function setup($: Engine, on: Parameters<typeof boot>[1]) {
  return boot($, on, { sessionId: () => 'sess-1', setup: on => {
    on('prompt.submit', (_, e) => ({ text: e.text, context: e.context }))
    on('fs.list', () => ({ value: [] }))
    on('session.repo', () => ({ value: null }))
  } })
}

test('plan: only a task-only call in a work job under the cap is nudged, and each nudge is counted', () => {
  expect(formNudgePlan(working(), true, false)).toEqual({ state: working({ formNudges: 1 }), nudge: true })
  for (const [hasTask, hasForm] of [[false, false], [true, true], [false, true]] as const)
    expect(formNudgePlan(working(), hasTask, hasForm).nudge, `task ${hasTask} form ${hasForm}`).toBe(false)
  expect(formNudgePlan(working({ job: 'chat' }), true, false).nudge).toBe(false)
  expect(formNudgePlan(working({ job: null }), true, false).nudge).toBe(false)
  expect(formNudgePlan(working({ formNudges: MAX_FORM_NUDGES_PER_SESSION - 1 }), true, false).nudge).toBe(true)
  const capped = working({ formNudges: MAX_FORM_NUDGES_PER_SESSION })
  expect(formNudgePlan(capped, true, false)).toEqual({ state: capped, nudge: false })
})

test('text: one plain line within the cap that names the candidates and works without any', () => {
  const text = formNudgeText(['steps', 'filetree', 'testresults', 'uml'])
  expect(text).toBe('Task is up. When you have first evidence, add one form that fits it (candidates: steps, filetree, testresults, uml); do not wait for the end.')
  expect(text.length).toBeLessThanOrEqual(FORM_NUDGE_MAX_CHARS)
  expect(text).not.toContain('\n')
  expect(formNudgeText([])).not.toContain('candidates')
  expect(formNudgeText(Array.from({ length: 40 }, (_, n) => `form${n}`)).length).toBeLessThanOrEqual(FORM_NUDGE_MAX_CHARS)
})

test('the baseline stays static, short and asks for the form after the task', () => {
  expect(BASELINE_TEXT.split('\n').length).toBeLessThanOrEqual(BASELINE_MAX_LINES)
  expect(BASELINE_TEXT).toContain('After the task, add one form that fits the evidence as soon as you have some.')
})

test('tool: a task-only call in a work job gets the line; a task with a frame does not', async ($, on) => {
  await setup($, on)
  await submit($)
  const lines = (await panel($, { task: TASK })).split('\n')
  expect(lines.filter(l => l.includes(NUDGE_MARK))).toHaveLength(1)
  expect(lines.find(l => l.includes(NUDGE_MARK))?.length).toBeLessThanOrEqual(FORM_NUDGE_MAX_CHARS)
  expect(await panel($, { task: TASK, frame: FRAME })).not.toContain(NUDGE_MARK)
  // The board now holds a frame: a later task-only call is no longer task-only.
  expect(await panel($, { task: TASK })).not.toContain(NUDGE_MARK)
})

test('tool: a task with a card is not nudged', async ($, on) => {
  await setup($, on)
  await submit($)
  expect(await panel($, { task: TASK, card: { id: 'notes', blocks: [{ kind: 'text', text: 'Evidence' }] } })).not.toContain(NUDGE_MARK)
})

test('tool: a chat job, a frame-only call and a worker call are not nudged', async ($, on) => {
  await setup($, on)
  await submit($, CHAT)
  expect(await panel($, { task: TASK })).not.toContain(NUDGE_MARK)
  await panel($, { clear: true, frames_clear: true })
  await submit($)
  expect(await panel($, { status: 'working' })).not.toContain(NUDGE_MARK)
  expect(await $.tool.call({ tool: TOOL, task: TASK, agentId: 'worker' }).then(r => String(r.result ?? ''))).not.toContain(NUDGE_MARK)
})

test('tool: the third task-only call in a session is not nudged', async ($, on) => {
  await setup($, on)
  await submit($)
  const nudged: boolean[] = []
  for (let n = 0; n <= MAX_FORM_NUDGES_PER_SESSION; n++) nudged.push((await panel($, { task: TASK })).includes(NUDGE_MARK))
  expect(nudged).toEqual([true, true, false])
})

test('tool: proactive false never nudges', { options: { proactive: false } }, async ($, on) => {
  await setup($, on)
  await submit($)
  expect(await panel($, { task: TASK })).not.toContain(NUDGE_MARK)
})
