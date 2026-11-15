// The facts the hooks keep of the session (hooks/session-facts.ts): the pure reducer, the frames it draws, and how the board
// takes them (precedence, the frame cap, the insight option). The hooks themselves are in auto-board-flow.test.tsx.
import { expect, test } from 'claude-code/testing'

import { assembleFrames, AUTO_FRAMES_MAX, newBoardModel } from '../hooks/board-model'
import type { BoardInput } from '../hooks/board-model'
import { ANSWER_CHARS, answerHead, checkboxTodos, factsFrames, factsState, initialFacts, PLAN_HIDE_MS, reduce, TASK_WHY } from '../hooks/session-facts'
import type { FactsEvent, SessionFacts } from '../hooks/session-facts'
import { taskFromPrompt } from '../hooks/proactive'
import { clipWords } from '../hooks/transcript-redact'
import type { BoardFrame } from '../types'

const T = 1_000_000
const prompt = (title = 'Add a cache to the loader'): FactsEvent => ({ kind: 'prompt', t: T, title })
const tool = (name: string, input: Record<string, unknown> = {}, extra: Partial<Extract<FactsEvent, { kind: 'tool' }>> = {}): FactsEvent => ({ kind: 'tool', t: T, tool: name, input, ...extra })
const turn = (answer: string, reason = 'answer', agentId?: string): FactsEvent => ({ kind: 'turn', t: T, answer, reason, ...(agentId === undefined ? {} : { agentId }) })
const run = (...events: FactsEvent[]): SessionFacts => events.reduce(reduce, initialFacts('k'))
const todos = (...items: [string, string][]) => tool('TodoWrite', { todos: items.map(([content, status]) => ({ content, status, activeForm: content })) })

test('prompt: every human prompt sets the goal and starts the turn (a one-line question is its own goal); a subagent event changes nothing', () => {
  const f = run(prompt())
  expect(f).toMatchObject({ goal: 'Add a cache to the loader', turn: 'working', calls: 0 })
  expect(reduce(f, prompt('What is 2+2'))).toMatchObject({ goal: 'What is 2+2', turn: 'working' })
  expect(reduce(f, { kind: 'prompt', t: T, title: '' })).toMatchObject({ goal: 'Add a cache to the loader', turn: 'working' }) // nothing to say: the old goal stays
  expect(reduce(f, tool('Edit', { file_path: '/a/b.ts' }, { agentId: 'ag-1' }))).toBe(f)
  expect(reduce(f, turn('hello', 'answer', 'ag-1'))).toBe(f)
})

test('tool: work calls count and name the last action; bookkeeping, panel calls and errors do not', () => {
  const f = run(prompt(), tool('Edit', { file_path: '/home/x/proj/src/cache.ts' }), tool('Bash', { command: 'npm test' }), tool('ToolSearch', {}), tool('mcp__panel__panel', {}), tool('Read', { file_path: 'x.ts' }, { isError: true }))
  expect(f).toMatchObject({ calls: 2, last: 'ran npm test' })
  expect(factsState(f, false)).toEqual({ sub: 'working · 2 calls · last: ran npm test', status: 'working' })
  expect(run(prompt(), tool('Edit', { file_path: '/x/cache.ts' })).last).toBe('edited cache.ts')
})

test('state: waiting on you for a pending ask, working with its counts, done and stopped after the turn', () => {
  const f = run(prompt())
  expect(factsState(f, false).sub).toBe('working')
  expect(factsState(f, true)).toEqual({ sub: 'waiting on you', status: 'waiting' })
  expect(factsState(reduce(f, turn('ok')), false)).toEqual({ sub: '', status: 'done' }) // the chip says done: no second `done` line
  expect(factsState(reduce(f, turn('', 'aborted')), false).sub).toBe('stopped')
})

test('plan: TodoWrite maps pending/in_progress/completed to todo/doing/done; Task* tools edit the same list', () => {
  const f = run(todos(['Read the loader', 'completed'], ['Write the cache', 'in_progress'], ['Run the tests', 'pending']))
  expect(f.todos.map(t => [t.t, t.state])).toEqual([['Read the loader', 'done'], ['Write the cache', 'doing'], ['Run the tests', 'todo']])
  expect(factsFrames(f, T)).toEqual([expect.objectContaining({ id: 'plan', type: 'steps', items: [{ t: 'Read the loader', state: 'done' }, { t: 'Write the cache', state: 'doing' }, { t: 'Run the tests', state: 'todo' }] })])
  const tasks = run(tool('TaskCreate', { subject: 'First' }, { text: 'Task #1 created' }), tool('TaskCreate', { subject: 'Second' }), tool('TaskUpdate', { taskId: '1', status: 'in_progress' }), tool('TaskUpdate', { taskId: '2', status: 'deleted' }))
  expect(tasks.todos).toEqual([{ id: '1', t: 'First', state: 'doing' }])
  expect(tasks.calls).toBe(0)
})

test('plan: capped at 6 rows with `+N more`, hidden when empty and 60 s after every step is done, back when work reopens', () => {
  const many = run(todos(...Array.from({ length: 9 }, (_, i): [string, string] => [`step ${i + 1}`, i < 2 ? 'completed' : 'pending'])))
  const items = (factsFrames(many, T)[0] as unknown as { items: { t: string }[] }).items
  expect(items).toHaveLength(6)
  expect(items.at(-1)?.t).toBe('+4 more')
  expect(items[0]?.t).toBe('step 2') // the window follows the work: one finished step of context, then the open ones
  expect(factsFrames(initialFacts('k'), T)).toEqual([])
  const done = run(todos(['a', 'completed'], ['b', 'completed']))
  expect(done.allDoneAt).toBe(T)
  expect(factsFrames(done, T + PLAN_HIDE_MS - 1)).toHaveLength(1)
  expect(factsFrames(done, T + PLAN_HIDE_MS)).toEqual([])
  expect(reduce(done, todos(['a', 'completed'], ['c', 'pending'])).allDoneAt).toBe(0)
})

test('last answer: the head of the main final message (about 400 characters) once the turn ends; a TL;DR line wins; hidden while a turn runs', () => {
  const long = `${'word '.repeat(200)}end`
  const f = run(prompt(), turn(long))
  expect(f.answer.length).toBeLessThanOrEqual(ANSWER_CHARS)
  expect(f.answer.startsWith('word word')).toBe(true)
  expect(factsFrames(f, T)).toEqual([expect.objectContaining({ id: 'last-answer', type: 'text', text: f.answer })])
  expect(answerHead('**TL;DR:** Cache added, tests pass.\n\nLong detail follows.')).toBe('TL;DR: Cache added, tests pass.')
  expect(answerHead('TL;DR: short\nmore')).toBe('TL;DR: short')
  expect(answerHead('Intro line\nTL;DR: not first')).toBe('Intro line TL;DR: not first')
  expect(answerHead('## Summary\n\nCache added, **tests pass**.\n\nMore detail.')).toBe('Cache added, tests pass.')
  expect(factsFrames(reduce(f, prompt()), T)).toEqual([]) // the next prompt clears it
  expect(run(prompt(), turn('why', 'refusal')).answer).toBe('')
  expect(run(prompt(), turn('', 'answer'))).toMatchObject({ turn: 'done', answer: '' })
  expect(factsFrames(run(prompt(), turn('')), T)).toEqual([]) // an empty answer draws no frame
})

test('redaction: the goal, the plan, the last action and the answer are scrubbed', () => {
  const secret = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789'
  const f = run(
    prompt(`Use key ${secret} to deploy`),
    todos([`rotate ${secret}`, 'pending']),
    tool('Bash', { command: `curl -H "Authorization: Bearer ${secret}" https://x.test` }),
    turn(`Done with ${secret} in /Users/someone/work`),
  )
  const all = JSON.stringify(f)
  expect(all).not.toContain(secret)
  expect(all).not.toContain('/Users/someone')
})

// ---- the board takes the facts ------------------------------------------------------------------------------------------

const BASE: BoardInput = { task: null, status: 'working', ask: null, choices: [], lanes: [], loops: [], pulse: undefined, now: T }
const ids = (frames: readonly BoardFrame[]): string[] => frames.map(f => f.id)

test('autoFrames: the facts add now, last-answer and plan in that order; nothing is drawn without a goal, an answer or a plan', () => {
  expect(assembleFrames(newBoardModel(), { ...BASE, facts: initialFacts('k') })).toEqual([])
  const f = run(prompt(), todos(['a', 'doing']), turn('All done.'))
  const frames = assembleFrames(newBoardModel(), { ...BASE, facts: f })
  expect(ids(frames)).toEqual(['now', 'last-answer', 'plan'])
  expect(frames[0]).toMatchObject({ type: 'now', text: 'Add a cache to the loader', status: 'done' })
  expect(frames[0]).not.toHaveProperty('sub') // `done` is said once, by the chip
})

test('precedence: a model frame with the same id wins; a model task wins over the goal; a seeded task gives way to it', () => {
  const f = run(prompt(), turn('Auto answer.'))
  const mine: BoardFrame = { id: 'last-answer', type: 'text', text: 'Mine' } as BoardFrame
  const withModel = assembleFrames({ ...newBoardModel(), frames: [mine] }, { ...BASE, facts: f })
  expect(withModel.filter(x => x.id === 'last-answer')).toEqual([mine])
  const posted = assembleFrames(newBoardModel(), { ...BASE, facts: f, task: { title: 'Posted task', why: 'Because' } })
  expect(posted.find(x => x.id === 'now')).toMatchObject({ text: 'Posted task' })
  const seeded = assembleFrames(newBoardModel(), { ...BASE, facts: f, task: { title: 'Seeded title', why: TASK_WHY } })
  expect(seeded.find(x => x.id === 'now')).toMatchObject({ text: 'Add a cache to the loader', status: 'done' })
  expect(assembleFrames(newBoardModel(), { ...BASE, task: { title: 'Seeded title', why: TASK_WHY } }).find(x => x.id === 'now')).toMatchObject({ text: 'Seeded title' })
  expect(assembleFrames({ ...newBoardModel(), removedAuto: ['plan'] }, { ...BASE, facts: run(prompt(), todos(['a', 'doing'])) }).map(x => x.id)).toEqual(['now'])
})

test('autoFrames: a pending ask shows `waiting on you` under the goal', () => {
  const frames = assembleFrames(newBoardModel(), { ...BASE, facts: run(prompt(), tool('Edit', { file_path: 'a.ts' })), ask: 'Ship it?' })
  expect(ids(frames)).toEqual(['ask', 'now'])
  expect(frames[1]).toMatchObject({ sub: 'waiting on you', status: 'waiting' })
})

test('the board never exceeds six frames of its own and keeps the priority ones', () => {
  const sessions = Array.from({ length: 3 }, (_, i) => ({ id: `s${i}`, name: `S${i}`, state: 'working', project: 'p', task: 't', updatedAt: T })) as unknown as BoardInput['sessions']
  const input: BoardInput = { ...BASE, facts: run(prompt(), todos(['a', 'doing']), turn('Answer')), sessions, usage: { contextPct: 40, contextTokens: 1, updatedAt: T } as unknown as BoardInput['usage'] }
  const frames = assembleFrames(newBoardModel(), input)
  expect(frames.length).toBeLessThanOrEqual(AUTO_FRAMES_MAX)
  expect(ids(frames).slice(0, 3)).toEqual(['now', 'last-answer', 'plan'])
})

// ---- fix round: what a glance should say --------------------------------------------------------------------------------

// The final message of the interactive run (p3): inline code, bold, a bullet list and a filler opener.
const P3_ANSWER = [
  'Done. All steps finished, nothing left to continue.',
  '',
  '`isEven` is in `math.ts`, and `node --test math.test.ts` passes: 2 tests, 0 failures, 0 skipped. Nothing failed, so I changed nothing to fix a failure.',
  '',
  '- **Function:** `isEven(n)` returns `n % 2 === 0`. See [the docs](https://example.test/x) for more.',
  '- **Tests:** the `isEven` test asserts `isEven(-2)` and `isEven(0)`, both `true`.',
  '- *Checklist:* `CHECKLIST.md` is ticked.',
].join('\n')

test('goal: a one-line question is the goal itself, so the goal never lags the answer (r2: "what is 2+2")', () => {
  const f = run(prompt('Use the TodoWrite tool to plan, then add isPrime to math.ts'), turn('Done.'), prompt(taskFromPrompt('what is 2+2').title), turn('4.'))
  expect(f).toMatchObject({ goal: 'What is 2+2', answer: '4.', turn: 'done' })
})

test('goal: the first sentence, cut at a word with an ellipsis when over the cap (p3: no more "run the te…")', () => {
  const p3 = 'Make a todo list, then add a function isEven to math.ts with a test, run the tests and report the result. Then stop.'
  const goal = run(prompt(taskFromPrompt(p3).title)).goal
  expect(goal.endsWith('…')).toBe(true)
  expect(goal.length).toBeLessThanOrEqual(80)
  expect(p3.startsWith(goal.slice(0, -1))).toBe(true)
  expect(p3.charAt(goal.length - 1)).toBe(' ') // the cut falls on a word boundary
  expect(taskFromPrompt('Short one. Second sentence.').title).toBe('Short one')
})

test('last answer: plain text from the real p3 message: no markdown, no filler opener, bullets on their own lines, at most 400 characters', () => {
  const head = answerHead(P3_ANSWER)
  expect(head).toBe([
    'isEven is in math.ts, and node --test math.test.ts passes: 2 tests, 0 failures, 0 skipped. Nothing failed, so I changed nothing to fix a failure.',
    '• Function: isEven(n) returns n % 2 === 0. See the docs for more.',
    '• Tests: the isEven test asserts isEven(-2) and isEven(0), both true.',
    '• Checklist: CHECKLIST.md is ticked.',
  ].join('\n'))
  expect(head).not.toMatch(/[`*]|\]\(/)
  expect(head.length).toBeLessThanOrEqual(ANSWER_CHARS)
  expect(answerHead(`${P3_ANSWER}\n${'- another long bullet point\n'.repeat(30)}`).length).toBeLessThanOrEqual(ANSWER_CHARS)
})

test('plan: a new human prompt clears a fully complete plan, an in-progress plan stays, an automated prompt (no title) clears nothing', () => {
  const done = run(todos(['a', 'completed'], ['b', 'completed']))
  const next = reduce(done, prompt('what is 3+3'))
  expect(next).toMatchObject({ todos: [], allDoneAt: 0, goal: 'what is 3+3' })
  expect(factsFrames(next, T).find(f => f.id === 'plan')).toBeUndefined()
  const open = reduce(run(todos(['a', 'completed'], ['b', 'in_progress'])), prompt('and then?'))
  expect(open.todos).toHaveLength(2)
  expect(reduce(done, prompt('  ')).todos).toHaveLength(2)
})

test('last answer: past the cap, whole trailing bullets drop (never a cut mid-bullet); only a first line over the cap is cut at a word', () => {
  const head = 'Added isEven to math.ts with a test file, and all 3 tests pass. All 3 checklist items are done.'
  const bullets = [
    '- math.ts: new isEven(n: number): boolean, which checks n % 2 === 0. Negative even numbers return true. Fractions and NaN return false.',
    '- math.test.ts: new file with 3 tests covering even numbers, odd numbers, and non-integers.',
    '- Test run: deno test math.test.ts gave 3 passed, 0 failed.',
    '- Runner: the deno runner was used for every test in this run, with no extra flags.',
  ]
  const out = answerHead([head, ...bullets].join('\n'))
  const rows = out.split('\n')
  expect(out.length).toBeLessThanOrEqual(ANSWER_CHARS)
  expect(rows).toHaveLength(4)
  expect(rows[3]).toBe('• Test run: deno test math.test.ts gave 3 passed, 0 failed.')
  expect(out).not.toContain('Runner')
  expect(out).not.toContain('…')
  const long = answerHead(`${'word '.repeat(200)}\n- bullet`)
  expect(long.length).toBeLessThanOrEqual(ANSWER_CHARS)
  expect(long).not.toContain('bullet')
})

test('last answer: filler openers go (a small list), an all-filler answer and a plain answer stay, a code fence keeps its code', () => {
  expect(answerHead('Done. All steps finished, nothing left to continue.')).toBe('Done. All steps finished, nothing left to continue.')
  expect(answerHead('Sure. The cache is in.')).toBe('The cache is in.')
  expect(answerHead('All set! Tests pass: 4 of 4.')).toBe('Tests pass: 4 of 4.')
  expect(answerHead('4.')).toBe('4.')
  expect(answerHead('Run this:\n```sh\nnpm test\n```')).toBe('Run this: npm test')
  expect(answerHead('Surely this stays.')).toBe('Surely this stays.')
})

test('plan: a `__checklist` tool call (the subagent-progress checklist) mirrors its items and is not work', () => {
  const f = run(prompt(), tool('mcp__subagent-progress__checklist', { items: [{ content: '1 Read the files', status: 'completed' }, { content: '2 Write tests', status: 'in_progress', activeForm: 'Writing tests' }, { content: '3 Summarise', status: 'pending' }] }))
  expect(f.todos.map(t => [t.t, t.state])).toEqual([['1 Read the files', 'done'], ['2 Write tests', 'doing'], ['3 Summarise', 'todo']])
  expect(f.calls).toBe(0)
  const again = reduce(f, tool('mcp__subagent-progress__checklist', { items: [{ content: '1 Read the files', status: 'completed' }, { content: '2 Write tests', status: 'completed' }, { content: '3 Summarise', status: 'completed' }] }))
  expect(again.allDoneAt).toBe(T)
  expect(reduce(f, tool('mcp__subagent-progress__checklist', { items: 'junk' }))).toBe(f)
})

test('plan: checkboxes of a CHECKLIST.md Write (content) or Edit (the file read back) are the plan; an unreadable Edit and other files are skipped; subagents change nothing', () => {
  const md = '# Checklist\n- [x] Read the files\n- [ ] **Write** `tests`\n- [~] Run them\n* [X] Upper case\nnot a box\n- [] bad\n'
  const wrote = run(prompt(), tool('Write', { file_path: '/work/proj/CHECKLIST.md', content: md }))
  expect(wrote.todos.map(t => [t.t, t.state])).toEqual([['Read the files', 'done'], ['Write tests', 'todo'], ['Run them', 'doing'], ['Upper case', 'done']])
  expect(wrote.calls).toBe(1)
  expect(checkboxTodos(md)).toHaveLength(4)
  const edited = run(prompt(), tool('Edit', { file_path: '/work/proj/checklist.md', old_string: 'a', new_string: 'b' }, { file: md }))
  expect(edited.todos).toHaveLength(4)
  const unreadable = run(prompt(), tool('Edit', { file_path: '/work/proj/CHECKLIST.md', old_string: 'a', new_string: 'b' }))
  expect(unreadable.todos).toEqual([])
  expect(run(prompt(), tool('Write', { file_path: '/work/proj/NOTES.md', content: md })).todos).toEqual([])
  expect(reduce(wrote, tool('Write', { file_path: 'CHECKLIST.md', content: '- [ ] other' }, { agentId: 'ag-1' }))).toBe(wrote)
})

test('clipWords: whole text under the cap, else a cut at a word with an ellipsis (no dangling comma), a hard cut only for one long word', () => {
  expect(clipWords('short', 10)).toBe('short')
  expect(clipWords('add a function, then run the tests', 24)).toBe('add a function, then…')
  expect(clipWords('x'.repeat(20), 10)).toBe('xxxxxxxxx…')
})
