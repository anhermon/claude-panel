// The agent insight's pure parts: the kind of work, its headline, the mix, the humane feed, the activity strip, the files and the tokens of one agent.
import { expect, test } from 'claude-code/testing'

import { feedOf, filesOf, headlineOf, INSIGHT_CAPS, insightOf, kindOfLoop, mixOf, segmentsOfLoop, stripOf } from '../hooks/agent-insight'
import { addTokens, beginCall, MAIN_LOOP, newModel, restore, snapshot, spawnLoop, tokensOf } from '../hooks/pulse-model'
import type { PulseEvent, PulseLoop } from '../hooks/pulse-model'
import { bashTarget, targetOf } from '../hooks/pulse-redact'
import { KIND_META, STRIP_NONE } from '../hooks/work-kinds'

const NOW = 1_767_000_000_000
const SEC = 1000
const AGENT = 'ag-1'
const loop = (over: Partial<PulseLoop> = {}): PulseLoop => ({
  id: AGENT, label: 'Agent', kind: 'subagent', status: 'running', lastTool: '', lastTarget: '', calls: 0, busy: 0, counts: {}, files: [],
  startedAt: NOW - 60 * SEC, lastAt: NOW, ...over,
})
/** Events of AGENT, one every 2 s ending at NOW. */
const evs = (calls: [string, string?][], id = AGENT): PulseEvent[] =>
  calls.map(([tool, target], i) => ({ t: NOW - (calls.length - 1 - i) * 2 * SEC, loop: id, tool, target: target ?? '' }))
const reads = (n: number): [string, string?][] => Array.from({ length: n }, (_, i) => ['Read', `f${i}.ts`])

test('bash targets: the verb of the run joins the program, nothing else of the command does', () => {
  expect(bashTarget('npm run test')).toBe('npm test')
  expect(bashTarget('cd /a && node --test web/ --token=SECRET')).toBe('node test')
  expect(bashTarget('/opt/homebrew/bin/tsc -p .')).toBe('tsc')
  expect(bashTarget('claude plugin test .')).toBe('claude test')
  expect(bashTarget('git log --grep=test')).toBe('git') // `--grep=test` is not the word test
  expect(bashTarget('cat secrets.txt && npm test')).toBe('cat') // only the first command is looked at
  expect(bashTarget('FOO=hunter2 npm run build')).toBe('npm build')
  expect(bashTarget('echo hello world')).toBe('echo')
  expect(targetOf('Bash', { command: 'npm test -- --password hunter2' })).toBe('npm test')
})

test('kindOfLoop: the dominant kind of the last calls; thinking after 20 s of quiet; waiting / done from the status', () => {
  const kind = (calls: [string, string?][], over: Partial<PulseLoop> = {}, now = NOW): string => kindOfLoop(loop(over), evs(calls), now)
  expect(kind(reads(5))).toBe('reading')
  expect(kind([...reads(3), ['Edit', 'board.css'], ['Edit', 'lanes.html']])).toBe('ui')
  expect(kind([...reads(3), ['Edit', 'a.ts'], ['Edit', 'b.ts']])).toBe('logic')
  expect(kind([...reads(2), ['Bash', 'tsc']])).toBe('tests')
  expect(kind([['Edit', 'a.test.ts'], ['Edit', 'b.test.ts']])).toBe('tests')
  expect(kind([['Read', 'shot.png'], ['Bash', 'node render']])).toBe('visual')
  expect(kind([['Bash', 'git'], ['Bash', 'node'], ['Bash', 'rm']])).toBe('working')
  expect(kind([['Agent'], ['SendMessage']])).toBe('delegating')
  expect(kind([['WebSearch', '12 chars'], ['WebFetch', 'x.io'], ['WebSearch', '9 chars']])).toBe('research')
  expect(kind([...reads(5), ['Bash', 'npm test'], ['Bash', 'npm test']])).toBe('tests') // a test run counts three reads: making outweighs looking
  expect(kind([...reads(7), ['Bash', 'npm test']])).toBe('reading') // but one run among seven reads is still reading
  expect(kind([...reads(30), ['Edit', 'a.ts'], ['Edit', 'a.ts'], ['Edit', 'a.ts']])).toBe('logic') // only the last 8 count
  expect(kind(reads(3), {}, NOW + INSIGHT_CAPS.THINK_AFTER_MS + SEC)).toBe('thinking')
  expect(kind(reads(3), { busy: 1 }, NOW + INSIGHT_CAPS.THINK_AFTER_MS + SEC)).toBe('reading') // a call is still running
  expect(kind([], {}, NOW)).toBe('thinking') // nothing done yet
  expect(kind([], { counts: { Edit: 4, Read: 1 } })).toBe('working') // events gone (a snapshot read back): per-tool counts know no file, so no kind of edit is guessed
  expect(kind([], { counts: { Read: 4, Grep: 1 } })).toBe('reading')
  expect(kind(reads(3), { status: 'done' })).toBe('done')
  expect(kind(reads(3), { status: 'idle' })).toBe('waiting')
  expect(kind([['lane', 'x'], ['mcp__savvy-progress__step']])).toBe('thinking') // bookkeeping is not work
})

test('headlineOf: a sentence per kind, with the files it writes or what the check looks at', () => {
  const head = (calls: [string, string?][]): string => { const e = evs(calls); return headlineOf(kindOfLoop(loop(), e, NOW), e, AGENT) }
  expect(head([['Edit', 'board.css'], ['Edit', 'lanes.html'], ['Edit', 'x.css']])).toBe('Writing UI · x.css, lanes.html')
  expect(head([['Edit', 'agent-insight.ts']])).toBe('Writing logic · agent-insight.ts')
  expect(head([['Bash', 'npm test']])).toBe('Running tests')
  expect(head([['Edit', 'a.test.ts']])).toBe('Writing tests · a.test.ts')
  expect(head([['Read', 'truth-1.png']])).toBe('Checking visually · reading screenshot')
  expect(head([['Bash', 'node render']])).toBe('Checking visually · rendering')
  expect(head([['mcp__claude-in-chrome__navigate']])).toBe('Checking visually · in the browser')
  expect(head([['Write', 'README.md']])).toBe('Writing docs · README.md')
  expect(head([['WebSearch', '5 chars']])).toBe('Researching')
  expect(head(reads(3))).toBe('Reading code')
  expect(head([['Agent']])).toBe('Delegating')
  expect(head([['Bash', 'git']])).toBe('Working')
  expect(headlineOf('thinking', [], AGENT)).toBe('Thinking')
  expect(headlineOf('done', [], AGENT)).toBe('Finished')
})

test('feedOf: the last actions in plain words, consecutive ones collapsed, newest first, never a shell word', () => {
  expect(feedOf(evs([...reads(4), ['Edit', 'board.js'], ['Bash', 'npm test']]), AGENT)).toEqual(['ran tests', 'edited board.js', 'read 4 files'])
  expect(feedOf(evs([['Read', 'a.ts'], ['Grep'], ['Glob'], ['Write', 'x.md'], ['Edit', 'a.ts'], ['Edit', 'b.ts']]), AGENT)).toEqual(['edited 2 files', 'wrote x.md', 'searched the code'])
  expect(feedOf(evs([['Bash', 'sed'], ['Bash', 'cat'], ['Bash', 'tsc'], ['Bash', 'git'], ['Agent'], ['Bash', 'node']]), AGENT)).toEqual(['ran a script', 'handed work to an agent', 'used git'])
  expect(feedOf(evs([['Read', 'a.ts'], ['Read', 'a.ts']]), AGENT)).toEqual(['read a.ts']) // the same file twice is one file
  expect(feedOf(evs([['Bash', 'rm'], ['WebSearch', '12 chars']]), AGENT)).toEqual(['searched the web', 'ran a command'])
  expect(feedOf(evs([['lane', 'x'], ['Skill']]), AGENT)).toEqual([])
  expect(feedOf(evs(reads(20)), AGENT)).toEqual(['read 8 files']) // only the last 8 events
  const all = JSON.stringify(feedOf(evs([['Bash', 'sed'], ['Bash', 'grep'], ['Bash', 'rm'], ['Bash', 'curl']]), AGENT))
  expect(all).not.toMatch(/\b(?:sed|grep|rm|curl)\b/)
  expect(feedOf(evs(reads(3)), 'someone-else')).toEqual([]) // other loops' events are not this agent's
})

const MIN = 60_000
const e = (minutesAgo: number, tool: string, target = ''): PulseEvent => ({ t: NOW - minutesAgo * MIN, loop: AGENT, tool, target })

test('stripOf: one letter per bucket, the kind with most time in the slice, oldest first; the window is the last 6 minutes', () => {
  const lp = loop({ startedAt: NOW - 12 * MIN, lastAt: NOW })
  // minutes 6..12 are the window (24 buckets of 15 s): reads in the first quarter, a test in the middle, edits at the end
  const strip = stripOf(lp, [e(20, 'Edit', 'old.ts'), e(5.9, 'Read', 'a.ts'), e(5.8, 'Read', 'b.ts'), e(3, 'Bash', 'tsc'), e(0.1, 'Edit', 'c.ts'), e(0, 'Edit', 'c.ts')], NOW)
  expect(strip).toHaveLength(INSIGHT_CAPS.STRIP_BUCKETS)
  expect(strip[0]).toBe(KIND_META.reading.letter)
  expect(strip[12]).toBe(KIND_META.tests.letter)
  expect(strip[23]).toBe(KIND_META.logic.letter)
  expect([...strip].filter(c => c === KIND_META.logic.letter)).toHaveLength(1) // the edit from 20 minutes ago is outside the window
  expect([...strip].filter(c => c === STRIP_NONE).length).toBeGreaterThan(15) // quiet buckets are empty
  expect(stripOf(lp, [], NOW)).toBe(STRIP_NONE.repeat(INSIGHT_CAPS.STRIP_BUCKETS))
  // a young agent: its whole life is the window, its first call lands in the first bucket
  const young = loop({ startedAt: NOW - 30 * SEC, lastAt: NOW })
  const yStrip = stripOf(young, [{ t: NOW - 30 * SEC, loop: AGENT, tool: 'Read', target: 'a.ts' }, { t: NOW, loop: AGENT, tool: 'Agent', target: '' }], NOW)
  expect(yStrip[0]).toBe(KIND_META.reading.letter)
  expect(yStrip[23]).toBe(KIND_META.delegating.letter)
})

test('mixOf: the share of the last 10 minutes per kind, adding up to 100, largest first; the model keeps the spans for the whole session', () => {
  // 6 min of UI edits, 2 min of tests, 1 min of visual checks (calls every 15 s inside each stretch)
  const calls: PulseEvent[] = []
  for (let t = 0; t < 6 * MIN; t += 15 * SEC) calls.push({ t: NOW - 9 * MIN + t, loop: AGENT, tool: 'Edit', target: 'board.css' })
  for (let t = 0; t < 2 * MIN; t += 15 * SEC) calls.push({ t: NOW - 3 * MIN + t, loop: AGENT, tool: 'Bash', target: 'npm test' })
  for (let t = 0; t < 1 * MIN; t += 15 * SEC) calls.push({ t: NOW - 1 * MIN + t, loop: AGENT, tool: 'Read', target: 'a.png' })
  const mix = mixOf(loop({ startedAt: NOW - 9 * MIN }), calls, NOW)
  expect(mix.reduce((a, r) => a + r.pct, 0)).toBe(100)
  expect(mix.map(r => r.kind)).toEqual(['ui', 'tests', 'visual'])
  expect(mix[0]!.pct).toBeGreaterThan(55)
  expect(mix[0]!.pct).toBeLessThan(75)
  expect(mixOf(loop(), [], NOW)).toEqual([])
  // the pulse model keeps the spans as calls begin: a long session is not limited to the ring's 200 events
  const m = newModel(NOW - 100 * MIN)
  spawnLoop(m, NOW - 100 * MIN, { id: AGENT, label: 'Agent' })
  for (let i = 0; i < 400; i++) beginCall(m, NOW - 100 * MIN + i * 15 * SEC, AGENT, i < 200 ? 'Edit' : 'Read', i < 200 ? 'board.css' : 'a.ts')
  const lp = m.loops.get(AGENT)!
  expect(m.ring).toHaveLength(200)
  expect(lp.spans!.map(s => s.k)).toEqual(['ui', 'reading'])
  expect(mixOf({ ...lp, status: 'done', lastAt: NOW }, m.ring, NOW).map(r => r.kind)).toEqual(['reading']) // the last 10 minutes: only reads
  expect(segmentsOfLoop({ ...lp, status: 'done', lastAt: NOW }, m.ring, NOW).map(s => s.k)).toEqual(['ui', 'reading'])
  const back = newModel(NOW)
  restore(back, JSON.parse(JSON.stringify(snapshot(m, NOW))))
  expect(back.loops.get(AGENT)!.spans).toEqual(lp.spans)
})

test('filesOf and insightOf: up to 3 basenames, tokens null until known, lastCallAt from the events', () => {
  const lp = loop({ files: ['a.ts', 'b.ts', 'c.ts', 'd.ts'], tokens: 1234, busy: 1 })
  expect(filesOf(lp)).toEqual(['a.ts', 'b.ts', 'c.ts'])
  expect(filesOf(loop({ files: ['x'.repeat(60)] }))[0]).toHaveLength(INSIGHT_CAPS.FILE_CHARS)
  const insight = insightOf(lp, evs(reads(2)), NOW)
  expect(insight).toMatchObject({ kind: 'reading', headline: 'Reading code', tokens: 1234, isBusy: true, isMain: false, lastCallAt: NOW, files: ['a.ts', 'b.ts', 'c.ts'] })
  expect(insightOf(loop(), [], NOW)).toMatchObject({ tokens: null, feed: [], files: [] })
  expect(insightOf(loop({ id: MAIN_LOOP, kind: 'main' }), [], NOW).isMain).toBe(true)
})

test('tokens: the requests of a loop add up (fresh input + cache writes + output, cache reads left out) and survive a snapshot', () => {
  expect(tokensOf({ input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 100, cache_read_input_tokens: 9999 })).toBe(115)
  const m = newModel(NOW)
  spawnLoop(m, NOW, { id: AGENT, label: 'Agent' })
  expect(m.loops.get(AGENT)?.tokens).toBeUndefined() // unknown, not zero
  addTokens(m, NOW, AGENT, null)
  addTokens(m, NOW, AGENT, { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 500 })
  expect(m.loops.get(AGENT)?.tokens).toBeUndefined() // a request that counted nothing leaves it unknown
  addTokens(m, NOW, AGENT, { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 100, cache_read_input_tokens: 0 })
  addTokens(m, NOW, AGENT, { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 })
  expect(m.loops.get(AGENT)?.tokens).toBe(117)
  beginCall(m, NOW, AGENT, 'Read', 'a.ts')
  const back = newModel(NOW)
  expect(restore(back, JSON.parse(JSON.stringify(snapshot(m, NOW))))).toBe(true)
  expect(back.loops.get(AGENT)?.tokens).toBe(117)
})
