// The auto board end to end (everything beneath the mod stood in for, see boot.ts): the hook layer alone (prompt, TodoWrite,
// Edit, Bash, the end of the turn) draws the board in live/data.json, with no call to the panel tool.
import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { COOLDOWN_MS, LEAD_MS } from '../hooks/pulse-flush'
import { boot, STATE_FILE, TOOL } from './boot'

const DATA_TEMP = '/tmp/t/claude-panel/board/sess-1/live/.data.json.tmp'
const SOURCE_MARK = '/web/builtin/board'
const COMPOSER = { kind: 'composer' } as const
const PROMPT = 'Add a cache to the loader. Keep the entries bounded and cover it with tests.'
const FINAL = `${'The cache is in and the loader uses it. '.repeat(15)}Tests pass.`
const SECRET = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789'
const MAX_FRAMES = 6

type Json = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

const CHECKLIST_PATH = '/work/proj/CHECKLIST.md'
const CHECKLIST_TEXT = '- [x] Read the loader\n- [~] Write the cache\n- [ ] Run the tests\n'

async function autoBoot($: Engine, on: On, files: Record<string, string> = {}) {
  const box = { panelCalls: 0 }
  const b = await boot($, on, {
    sessionId: () => 'sess-1',
    setup: o => {
      o('prompt.submit', (_, e) => ({ text: e.text, context: e.context }))
      o('turn.complete', (_, e) => ({ text: e.answer }))
      o('tool.call', (_, e) => {
        if (e.tool === TOOL) box.panelCalls++
        return { result: 'done' } as never
      })
      o('session.repo', () => ({ value: null }))
      o('fs.list', (_, e) => ({ value: e.path.endsWith(SOURCE_MARK) ? ['index.html', 'board.js', 'board.css'].map(name => ({ name, kind: 'file' as const, size: 1, mtimeMs: 1, isLink: false })) : [] }))
    },
    texts: new Proxy({}, { get: (_, k) => (typeof k === 'string' && k.includes(`${SOURCE_MARK}/`) ? `// ${k.split('/').pop()}\n` : typeof k === 'string' ? files[k] : undefined) }),
  })
  const frames = async (): Promise<Json[]> => {
    await b.clock.advance(LEAD_MS + COOLDOWN_MS)
    return (JSON.parse(b.writes.filter(w => w.path === DATA_TEMP).at(-1)?.text ?? 'null') as Json).frames
  }
  return { ...b, frames, box }
}

/** A built-in tool call as the engine would send it (the typed overloads want every field of the tool's schema). */
const call = ($: Engine, input: object) => $.tool.call(input as never)
const todo = (content: string, status: string) => ({ content, status, activeForm: content })
const submit = ($: Engine, text: string, origin: { kind: string } = COMPOSER) => $.prompt.submit({ text, wait: false, origin } as never)
const hasData = (f: Json): boolean => Object.entries(f).some(([k, v]) => !['id', 'type', 'title', 'size'].includes(k) && (Array.isArray(v) ? v.length > 0 : v !== '' && v !== undefined && v !== null))

test('acceptance: prompt, plan, edit, test run and final answer draw now, plan and last-answer from the hooks alone', async ($, on) => {
  const b = await autoBoot($, on)
  // point 1: after the prompt
  await submit($, PROMPT)
  const p1 = await b.frames()
  expect(p1.find(f => f.id === 'now')).toMatchObject({ type: 'now', text: 'Add a cache to the loader', sub: 'working', status: 'working' })
  expect(p1.find(f => f.id === 'plan')).toBeUndefined()
  // point 2: mid-turn
  await call($, { tool: 'TodoWrite', todos: [todo('Read the loader', 'completed'), todo('Write the cache', 'in_progress'), todo('Run the tests', 'pending')] })
  await call($, { tool: 'Edit', file_path: '/work/proj/src/loader.ts', old_string: 'a', new_string: 'b' })
  await call($, { tool: 'Bash', command: 'npm test' })
  await call($, { tool: 'TodoWrite', todos: [todo('Read the loader', 'completed'), todo('Write the cache', 'completed'), todo('Run the tests', 'in_progress')] })
  const p2 = await b.frames()
  expect(p2.find(f => f.id === 'plan')).toMatchObject({ type: 'steps', items: [{ t: 'Read the loader', state: 'done' }, { t: 'Write the cache', state: 'done' }, { t: 'Run the tests', state: 'doing' }] })
  expect(p2.find(f => f.id === 'now')).toMatchObject({ text: 'Add a cache to the loader', sub: 'working · 2 calls · last: ran npm test', status: 'working' })
  expect(p2.find(f => f.id === 'last-answer')).toBeUndefined()
  // point 3: after the turn
  await $.turn.complete({ answer: FINAL, durationMs: 5, isAborted: false, turnId: 't1', reason: 'answer' })
  const p3 = await b.frames()
  const answer = p3.find(f => f.id === 'last-answer')
  expect(answer).toMatchObject({ type: 'text' })
  expect(answer?.text.length).toBeLessThanOrEqual(400)
  expect(FINAL.startsWith(answer?.text.replace(/…$/, ''))).toBe(true)
  expect(p3.find(f => f.id === 'now')).toMatchObject({ status: 'done' })
  expect(p3.find(f => f.id === 'now')).not.toHaveProperty('sub') // `done` once
  expect(p3.map(f => f.id).slice(0, 3)).toEqual(['now', 'last-answer', 'plan'])
  for (const frames of [p1, p2, p3]) {
    expect(frames.length).toBeLessThanOrEqual(MAX_FRAMES)
    for (const f of frames) expect(hasData(f), `frame ${f.id} has data`).toBe(true)
  }
  // the board came from the facts: no task was posted or seeded (panelCalls is zero by construction: the mod answers its own tool)
  const stateWrites = b.writes.filter(w => w.path === STATE_FILE)
  expect(stateWrites.every(w => JSON.parse(w.text).task === null)).toBe(true)
  expect(b.box.panelCalls).toBe(0)
})

test('gates: a prompt the person did not type sets no goal, a subagent turn and its calls change nothing, a TL;DR leads the answer', async ($, on) => {
  const b = await autoBoot($, on)
  await submit($, 'Refactor the whole billing module now.', { kind: 'sdk' })
  expect(await b.frames()).toEqual([])
  await submit($, PROMPT)
  await call($, { tool: 'Edit', file_path: '/work/proj/a.ts', old_string: 'a', new_string: 'b', agentId: 'ag-1' })
  await $.turn.complete({ answer: 'subagent report', durationMs: 5, isAborted: false, turnId: 't-a', reason: 'answer', agentId: 'ag-1' })
  const mid = await b.frames()
  expect(mid.find(f => f.id === 'now')).toMatchObject({ sub: 'working' })
  expect(mid.find(f => f.id === 'last-answer')).toBeUndefined()
  await $.turn.complete({ answer: '**TL;DR:** Cache added.\n\nDetails follow.', durationMs: 5, isAborted: false, turnId: 't1', reason: 'answer' })
  expect((await b.frames()).find(f => f.id === 'last-answer')).toMatchObject({ text: 'TL;DR: Cache added.' })
})

test('redaction: a secret in the prompt, a todo and the answer never reaches live/data.json', async ($, on) => {
  const b = await autoBoot($, on)
  await submit($, `Rotate the key ${SECRET} in the config.`)
  await call($, { tool: 'TodoWrite', todos: [todo(`Use ${SECRET}`, 'pending')] })
  await $.turn.complete({ answer: `Rotated ${SECRET}.`, durationMs: 5, isAborted: false, turnId: 't1', reason: 'answer' })
  expect(JSON.stringify(await b.frames())).not.toContain(SECRET)
})

type Held = { value: unknown; version: number }
type StateEvent = { key: string; value: unknown }

/** An in-memory `$.state` that outlives the mod (what a reload keeps), seeded with the facts of an earlier instance. */
function keepFacts(on: On, seed?: object) {
  const store = new Map<string, Held>()
  if (seed !== undefined) store.set('facts', { value: { shape: 'panel-facts-1', value: seed }, version: 1 })
  on('state.get', (_, e) => ({ value: store.get((e as unknown as StateEvent).key) ?? { value: undefined, version: 0 } }) as never)
  on('state.set', (_, e) => {
    const { key, value } = e as unknown as StateEvent
    const version = (store.get(key)?.version ?? 0) + 1
    store.set(key, { value, version })
    return { value: { isSet: true, version } } as never
  })
  return store
}

test('the facts are kept in the session state, and a reload draws the board again from them', async ($, on) => {
  const store = keepFacts(on)
  const first = await autoBoot($, on)
  await submit($, PROMPT)
  await $.turn.complete({ answer: 'All done.', durationMs: 5, isAborted: false, turnId: 't1', reason: 'answer' })
  expect((await first.frames()).map(f => f.id)).toEqual(['now', 'last-answer'])
  const held = (store.get('facts')?.value as { shape: string; value: Json }).value
  expect(held).toMatchObject({ sessionKey: 'sess-1', goal: 'Add a cache to the loader', turn: 'done', answer: 'All done.' })
})

test('a new instance reads the kept facts at its first draw (a reload does not fire session.start again)', async ($, on) => {
  keepFacts(on, { sessionKey: 'sess-1', goal: 'Kept goal', turn: 'done', calls: 3, last: 'ran npm', todos: [{ id: '1', t: 'Kept step', state: 'doing' }], allDoneAt: 0, answer: 'Kept answer.' })
  const b = await autoBoot($, on)
  const frames = await b.frames()
  expect(frames.map(f => f.id)).toEqual(['now', 'last-answer', 'plan'])
  expect(frames[0]).toMatchObject({ text: 'Kept goal', status: 'done' })
})

test('facts of another session are not drawn (after /clear)', async ($, on) => {
  keepFacts(on, { sessionKey: 'other', goal: 'Old goal', turn: 'done', calls: 0, last: '', todos: [], allDoneAt: 0, answer: 'Old.' })
  const b = await autoBoot($, on)
  expect(await b.frames()).toEqual([])
})

test('a one-line question after a task replaces the goal, and the answer is plain text with its bullets on separate lines (r2 / p3)', async ($, on) => {
  const b = await autoBoot($, on)
  await submit($, PROMPT)
  await $.turn.complete({ answer: 'Done.', durationMs: 5, isAborted: false, turnId: 't1', reason: 'answer' })
  await submit($, 'what is 2+2')
  await $.turn.complete({ answer: '4.', durationMs: 5, isAborted: false, turnId: 't2', reason: 'answer' })
  const frames = await b.frames()
  expect(frames.find(f => f.id === 'now')).toMatchObject({ text: 'What is 2+2', status: 'done' })
  expect(frames.find(f => f.id === 'last-answer')).toMatchObject({ text: '4.' })
  await submit($, 'what is 3+3', { kind: 'sdk' }) // an automated prompt does not change the goal
  expect((await b.frames()).find(f => f.id === 'now')).toMatchObject({ text: 'What is 2+2' })
  await submit($, PROMPT)
  await $.turn.complete({ answer: 'Done. All steps finished.\n\nThe `cache` is in:\n- **Loader:** uses it\n- **Tests:** pass', durationMs: 5, isAborted: false, turnId: 't3', reason: 'answer' })
  expect((await b.frames()).find(f => f.id === 'last-answer')?.text).toBe('The cache is in:\n• Loader: uses it\n• Tests: pass')
})

test('the default board holds no limits or other-sessions frame, and only the goal, plan and answer of this session', async ($, on) => {
  const b = await autoBoot($, on)
  await submit($, PROMPT)
  await call($, { tool: 'TodoWrite', todos: [todo('Read the loader', 'in_progress')] })
  await $.turn.complete({ answer: 'Finished.', durationMs: 5, isAborted: false, turnId: 't1', reason: 'answer' })
  expect((await b.frames()).map(f => f.id)).toEqual(['now', 'last-answer', 'plan'])
})

test('plan: the subagent-progress checklist tool and a CHECKLIST.md Write or Edit draw the plan on a session with no TodoWrite', async ($, on) => {
  const b = await autoBoot($, on, { [CHECKLIST_PATH]: CHECKLIST_TEXT })
  await submit($, PROMPT)
  await call($, { tool: 'mcp__subagent-progress__checklist', items: [{ content: '1 Read the loader', status: 'completed' }, { content: '2 Write the cache', status: 'in_progress' }] })
  expect((await b.frames()).find(f => f.id === 'plan')).toMatchObject({ items: [{ t: '1 Read the loader', state: 'done' }, { t: '2 Write the cache', state: 'doing' }] })
  await call($, { tool: 'Write', file_path: CHECKLIST_PATH, content: '- [x] A\n- [ ] B\n' })
  expect((await b.frames()).find(f => f.id === 'plan')).toMatchObject({ items: [{ t: 'A', state: 'done' }, { t: 'B', state: 'todo' }] })
  await call($, { tool: 'Edit', file_path: CHECKLIST_PATH, old_string: 'x', new_string: 'y' })
  expect((await b.frames()).find(f => f.id === 'plan')).toMatchObject({ items: [{ t: 'Read the loader', state: 'done' }, { t: 'Write the cache', state: 'doing' }, { t: 'Run the tests', state: 'todo' }] })
})

test('plan: a one-line question after a finished task clears the old completed plan; a plan still in progress stays', async ($, on) => {
  const b = await autoBoot($, on)
  await submit($, PROMPT)
  await call($, { tool: 'TodoWrite', todos: [todo('Read the loader', 'completed'), todo('Write the cache', 'completed')] })
  await $.turn.complete({ answer: 'Cache added.', durationMs: 5, isAborted: false, turnId: 't1', reason: 'answer' })
  expect((await b.frames()).find(f => f.id === 'plan')).toBeDefined()
  await submit($, 'what is 3+3?')
  expect((await b.frames()).find(f => f.id === 'plan')).toBeUndefined()
  await call($, { tool: 'TodoWrite', todos: [todo('Read the loader', 'completed'), todo('Write the cache', 'in_progress')] })
  await submit($, 'also, one more thing')
  expect((await b.frames()).find(f => f.id === 'plan')).toMatchObject({ items: [{ t: 'Read the loader', state: 'done' }, { t: 'Write the cache', state: 'doing' }] })
})

test('plan: an Edit of an unreadable CHECKLIST.md leaves the plan as it was', async ($, on) => {
  const b = await autoBoot($, on)
  await submit($, PROMPT)
  await call($, { tool: 'Write', file_path: CHECKLIST_PATH, content: '- [x] A\n' })
  await call($, { tool: 'Edit', file_path: CHECKLIST_PATH, old_string: 'x', new_string: 'y' })
  expect((await b.frames()).find(f => f.id === 'plan')).toMatchObject({ items: [{ t: 'A', state: 'done' }] })
})
