// The pure half of the sessions frame: which sessions are alive (registry + `ps`), what a transcript tail says, the busy / idle /
// may-be-waiting call, the order and the cap. Deterministic: the clock is an argument, nothing reads a disk.
import { expect, test } from 'claude-code/testing'

import { ageText, candidates, cleanPrompt, isAlive, liveSessions, parseEntry, parsePs, promptOf, readTail, SESSION_ROWS, sessionRows, stateOf } from '../hooks/sessions-state'
import type { LiveSession, SessionFacts } from '../hooks/sessions-state'
import { ID_A, ID_B, ID_DEAD, MIN, NOW, psText, registryFile, SELF, assistantText, thinking, toolResult, toolUse, toolUseOf, transcript, user } from './sessions-fixture'

const live = (id: string, over: Partial<LiveSession> = {}): LiveSession => ({ sessionId: id, pid: 1, cwd: '/work/alpha', name: 'alpha', status: 'idle', startedAt: 0, ...over })
const facts = (id: string, over: Partial<SessionFacts> = {}, liveOver: Partial<LiveSession> = {}): SessionFacts => ({
  live: live(id, liveOver), slug: '-work-alpha', tail: readTail(''), mainMs: NOW - 10 * MIN, lastWriteMs: NOW - 10 * MIN, ...over,
})

test('a registry entry counts only while its pid is a process that started at procStart', () => {
  const procs = parsePs(psText([101]))
  const entry = (pid: number, over = {}) => parseEntry(registryFile(pid, ID_A, over))!
  expect(isAlive(entry(101), procs)).toBe(true)
  expect(isAlive(entry(102), procs)).toBe(false) // no such pid
  expect(isAlive(entry(101, { procStart: 'Thu Nov 05 07:00:00 2026' }), procs)).toBe(false) // a recycled pid
  expect(isAlive(entry(101, { procStart: null }), procs)).toBe(true) // no start time: the process only has to be claude
  expect(isAlive(entry(999, { procStart: null }), procs)).toBe(false) // ... and cron is not
})

test('liveSessions: dead pids are out, a resumed session with no registry file is found through ps, the latest start wins a duplicate id', () => {
  const procs = parsePs(`${psText([101, 103])}  104     1 ${'Thu Nov  5 07:34:30 2026'} claude --resume ${ID_B}\n`)
  const entries = [
    parseEntry(registryFile(101, ID_A, { startedAt: 5 }))!,
    parseEntry(registryFile(103, ID_A, { startedAt: 9, cwd: '/work/newer' }))!,
    parseEntry(registryFile(102, ID_DEAD))!,
  ]
  const found = liveSessions(entries, procs)
  expect([...found.keys()].sort()).toEqual([ID_A, ID_B])
  expect(found.get(ID_A)).toMatchObject({ pid: 103, cwd: '/work/newer' })
  expect(found.get(ID_B)).toMatchObject({ pid: 104, cwd: null })
  expect(parseEntry('{"pid":"x"}')).toBeUndefined()
  expect(parseEntry('not json')).toBeUndefined()
})

test('the current task is the last real prompt: meta rows, tags, interrupts and tool results never count; a long one is cut, newlines collapsed, secrets masked', () => {
  const long = `fix the\n\nlogin   page ${'word '.repeat(60)}`
  const tail = readTail(transcript(
    user('first ask'),
    user(long),
    user('<command-name>/clear</command-name>'),
    user('system note', { isMeta: true }),
    user('[Request interrupted by user]'),
    toolResult('t1'),
  ))
  expect(tail.prompt).toBe(long.trim())
  const row = sessionRows([facts(ID_A, { tail })], SELF, NOW)[0]!
  expect(row.task!.length).toBeLessThanOrEqual(SESSION_ROWS.TASK_CHARS)
  expect(row.task).toMatch(/^fix the login page word word/)
  expect(row.task).toMatch(/…$/)
  const key = ['sk', 'abcdefghijklmnopqrstuvwx'].join('-') // built at run time so scanners do not flag the file
  const secret = readTail(transcript(user(`deploy with password=hunter2 and ${key} now`)))
  expect(sessionRows([facts(ID_A, { tail: secret })], SELF, NOW)[0]!.task).not.toMatch(/hunter2|sk-abcdef/)
  expect(promptOf({ type: 'user', message: { content: [{ type: 'text', text: 'from blocks' }] } })).toBe('from blocks')
})

test('a transcript tail gives title, branch, cwd and the tool calls still unanswered; its cut first line is skipped', () => {
  const tail = readTail(`{"type":"user","mess\n${transcript(
    JSON.stringify({ type: 'ai-title', aiTitle: 'Fix login' }),
    user('go'),
    toolUse('t1'),
    toolUse('t2'),
    toolResult('t1'),
  )}`)
  expect(tail).toMatchObject({ title: 'Fix login', branch: 'feature/x', cwd: '/work/alpha', prompt: 'go', pending: 1 })
})

test('busy: written in the last 30 s or the registry says busy; may be waiting: an unanswered call and quiet for 20 s; otherwise idle', () => {
  const pending = readTail(transcript(toolUse('t1')))
  expect(stateOf(facts(ID_A, { mainMs: NOW - 5000, lastWriteMs: NOW - 5000 }), NOW)).toBe('busy')
  expect(stateOf(facts(ID_A, {}, { status: 'busy' }), NOW)).toBe('busy')
  expect(stateOf(facts(ID_A), NOW)).toBe('idle')
  expect(stateOf(facts(ID_A, { tail: pending, mainMs: NOW - 5000, lastWriteMs: NOW - 5000 }), NOW)).toBe('busy') // a tool that just started is not waiting
  expect(stateOf(facts(ID_A, { tail: pending, mainMs: NOW - 25_000, lastWriteMs: NOW - 25_000 }), NOW)).toBe('waiting')
  expect(stateOf(facts(ID_A, { mainMs: NOW - 60 * MIN, lastWriteMs: NOW - 5000 }), NOW)).toBe('busy') // only a subagent wrote
})

const taskOf = (...lines: string[]): string | undefined => sessionRows([facts(ID_A, { tail: readTail(transcript(...lines)) })], SELF, NOW)[0]!.task

test('task line: a tool call in flight reads "<Tool>: <description, else command, else file>"; the last unanswered call wins; mcp prefixes are dropped', () => {
  expect(taskOf(user('go'), toolUseOf('t1', 'Bash', { command: 'npm test', description: 'Run the unit tests' }))).toBe('Bash: Run the unit tests')
  expect(taskOf(user('go'), toolUseOf('t1', 'Bash', { command: 'npm   test\n--silent' }))).toBe('Bash: npm test --silent')
  expect(taskOf(user('go'), toolUseOf('t1', 'Edit', { file_path: '/work/alpha/src/app.ts', old_string: 'x' }))).toBe('Edit: /work/alpha/src/app.ts')
  expect(taskOf(user('go'), toolUseOf('t1', 'Grep', { pattern: 'TODO' }))).toBe('Grep: TODO')
  expect(taskOf(user('go'), toolUseOf('t1', 'mcp__panel__board', { description: 'Draw the board' }))).toBe('board: Draw the board')
  expect(taskOf(user('go'), toolUseOf('t1', 'Read', {}))).toBe('Read')
  expect(taskOf(user('go'), toolUseOf('t1', 'Read', { file_path: 'a.ts' }), toolUseOf('t2', 'Bash', { description: 'Second one' }), toolResult('t1'))).toBe('Bash: Second one')
})

test('task line: an answered tool no longer shows (not even from an earlier read of the same session); the secret in a command is masked', () => {
  const before = readTail(transcript(user('go'), toolUseOf('t1', 'Bash', { description: 'Run it' })))
  expect(before.doing).toBe('Bash: Run it')
  const after = readTail(transcript(user('go'), assistantText('Done running it.'), toolResult('t1')))
  expect(after.doing).toBeNull()
  expect(taskOf(user('go'), toolUseOf('t1', 'Bash', { command: 'deploy password=hunter2 now' }))).not.toMatch(/hunter2/)
})

test('task line: with no tool in flight, the first sentence of the latest assistant text, markdown stripped, cut at 80; thinking is skipped', () => {
  expect(taskOf(user('go'), assistantText('**Fixing** the `login` bug in app.ts. Then I will run the tests.'))).toBe('Fixing the login bug in app.ts.')
  expect(taskOf(user('go'), assistantText('## Plan\n- [the docs](http://x.y) are next! More later'))).toBe('Plan the docs are next!')
  expect(taskOf(user('go'), assistantText('First text.'), thinking('secret musings. more'), assistantText('Latest text here. Second.'))).toBe('Latest text here.')
  expect(taskOf(user('go'), assistantText('No terminal punctuation at all'))).toBe('No terminal punctuation at all')
  expect(taskOf(user('go'), assistantText(`${'word '.repeat(40)}end.`))!.length).toBeLessThanOrEqual(SESSION_ROWS.TASK_CHARS)
  expect(taskOf(user('go'), assistantText('Sidechain says hi.', { isSidechain: true }))).toBe('go')
})

test('task line: assistant text older than the last real prompt describes the previous turn, so the prompt is the fallback', () => {
  expect(taskOf(user('first ask'), assistantText('Finished the first thing.'), user('now do the second'))).toBe('now do the second')
})

test('task line fallback: the last prompt with leading quote marks and arrows cleaned (the two live examples)', () => {
  expect(cleanPrompt("'''What you might be missing: - A store only helps...'''")).toBe('What you might be missing: - A store only helps...')
  expect(cleanPrompt("'No ETA — will report when it lands.' -> wtf do you mean...")).toBe('No ETA — will report when it lands. wtf do you mean...')
  expect(cleanPrompt('"quoted" => done')).toBe('quoted done')
  expect(cleanPrompt('  ```\n  fix it  ')).toBe('fix it')
  expect(taskOf(user("'''What you might be missing: - A store only helps...'''"))).toBe('What you might be missing: - A store only helps...')
})

test('rows: a branch of HEAD (detached or a worktree) is no tag; a real one stays', () => {
  const row = (branch: string | null) => sessionRows([facts(ID_A, { tail: { ...readTail(''), branch } })], SELF, NOW)[0]!
  expect(row('HEAD')).not.toHaveProperty('branch')
  expect(row('')).not.toHaveProperty('branch')
  expect(row('feature/x')).toMatchObject({ branch: 'feature/x' })
})

test('rows: may-be-waiting first (it needs the user), then busy, then idle; the cap never cuts a waiting one', () => {
  const pending = readTail(transcript(toolUse('t1')))
  const waiting = (id: string, ms: number) => facts(id, { tail: pending, mainMs: NOW - ms, lastWriteMs: NOW - ms }, { name: `w-${id.slice(0, 2)}` })
  const many = Array.from({ length: 9 }, (_, i) => facts(`${String(i).padStart(8, '0')}-0000-4000-8000-000000000000`, { lastWriteMs: NOW - 1000 - i }, { name: `busy${i}`, status: 'busy' }))
  const rows = sessionRows([...many, facts(ID_B, { lastWriteMs: NOW - 9 * MIN }, { name: 'idle' }), waiting(ID_A, 3 * MIN)], SELF, NOW)
  expect(rows).toHaveLength(SESSION_ROWS.MAX)
  expect(rows[0]).toMatchObject({ state: 'waiting', title: expect.stringMatching(/^w-aa/) })
  expect(rows.slice(1).every(r => r.state === 'busy')).toBe(true)
})

test('rows: busy first, then the most recent; the current session is left out; at most 8; project is the folder name, age is coarse', () => {
  const rows = sessionRows([
    facts(ID_A, { lastWriteMs: NOW - 5 * MIN }, { name: 'older idle' }),
    facts(ID_B, { lastWriteMs: NOW - 1 * MIN }, { name: 'newer idle', cwd: '/work/beta/' }),
    facts('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', { lastWriteMs: NOW - 2 * MIN }, { name: 'busy by registry', status: 'busy' }),
    facts(SELF, { lastWriteMs: NOW }, { name: 'me', status: 'busy' }),
  ], SELF, NOW)
  expect(rows.map(r => r.title)).toEqual(['busy by registry', 'newer idle', 'older idle'])
  expect(rows.map(r => r.state)).toEqual(['busy', 'idle', 'idle'])
  expect(rows[1]).toMatchObject({ project: 'beta', age: '1m' })
  expect(rows[1]).not.toHaveProperty('branch')
  const many = Array.from({ length: 12 }, (_, i) => facts(`${String(i).padStart(8, '0')}-0000-4000-8000-000000000000`, { lastWriteMs: NOW - i * MIN }))
  expect(sessionRows(many, SELF, NOW)).toHaveLength(8)
  expect(sessionRows([], SELF, NOW)).toEqual([])
})

test('candidates: only the sessions that can reach the frame are worth a tail read', () => {
  const map = new Map(Array.from({ length: 12 }, (_, i) => [`s${i}`, live(`s${i}`)] as const))
  const picked = candidates(map, new Map(Array.from({ length: 12 }, (_, i) => [`s${i}`, NOW - i * MIN] as const)), 's3', NOW)
  expect(picked).toHaveLength(8)
  expect(picked.map(l => l.sessionId)).not.toContain('s3')
  expect(picked[0]!.sessionId).toBe('s0')
})

test('ageText is minutes at the finest', () => {
  expect([0, 59_000, MIN, 59 * MIN, 60 * MIN, 25 * 60 * MIN, 49 * 60 * MIN].map(ageText)).toEqual(['now', 'now', '1m', '59m', '1h', '1d', '2d'])
})
