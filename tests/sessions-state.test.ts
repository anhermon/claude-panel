// The pure half of the sessions frame: which sessions are alive (registry + `ps`), what a transcript tail says, the busy / idle /
// may-be-waiting call, the order and the cap. Deterministic: the clock is an argument, nothing reads a disk.
import { expect, test } from 'claude-code/testing'

import { ageText, candidates, isAlive, liveSessions, parseEntry, parsePs, promptOf, readTail, SESSION_ROWS, sessionRows, stateOf } from '../hooks/sessions-state'
import type { LiveSession, SessionFacts } from '../hooks/sessions-state'
import { ID_A, ID_B, ID_DEAD, MIN, NOW, psText, registryFile, SELF, toolResult, toolUse, transcript, user } from './sessions-fixture'

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
