// Human agent titles: spawn description cleaning, brief -> title, activity placeholders, the lazy transcript lookup.
import { expect, test } from 'claude-code/testing'

import { cutWords, isPlaceholder, NAME_CAPS, placeholderFor, plainTitle, resetNames, resolveBriefTitle, titleFromBrief } from '../hooks/agent-names'
import { beginCall, newModel, setLoopTitle, snapshot, syncAgents } from '../hooks/pulse-model'
import { shortNameOf } from '../hooks/agents-info-data'

const HASH = /agent [0-9a-f]{4}/i
const NOW = 1_767_000_000_000

test('plainTitle: ticket token, model/effort suffix and control characters go; first letter capitalised; empty stays empty', () => {
  expect(plainTitle('T66 · fix transcript lookup (sonnet/low)')).toBe('Fix transcript lookup')
  expect(plainTitle('T7: review router state')).toBe('Review router state')
  expect(plainTitle('t12. ship it')).toBe('Ship it')
  expect(plainTitle('T9')).toBe('T9')
  expect(plainTitle('  \n ')).toBe('')
  expect(plainTitle('')).toBe('')
})

test('titleFromBrief: first imperative sentence without Ticket lines, paths and notes; cut at a word boundary', () => {
  expect(titleFromBrief('Ticket: T66\n\nFix the transcript lookup. Then run tests.')).toBe('Fix the transcript lookup')
  expect(titleFromBrief('Panel mod (MOD=/Users/x/panel) review router state')).toBe('Panel mod review router state')
  const long = titleFromBrief('Investigate the flaky behaviour of the delegation diagram renderer today')
  expect(long.length).toBeLessThanOrEqual(NAME_CAPS.TITLE_CHARS)
  expect(long.endsWith(' ')).toBe(false)
  expect('Investigate the flaky behaviour of the delegation diagram renderer today').toContain(long.toLowerCase().slice(1))
  expect(titleFromBrief('')).toBe('')
  expect(titleFromBrief('Ticket: T1\n---')).toBe('')
  expect(cutWords('short', 40)).toBe('short')
})

test('placeholderFor: by latest tool kind, never a hash', () => {
  expect(placeholderFor()).toBe('Agent')
  expect(placeholderFor('reading')).toBe('Agent · read')
  expect(placeholderFor('tests')).toBe('Agent · tests')
  expect(isPlaceholder('Agent · read')).toBe(true)
  expect(isPlaceholder('Fix lanes')).toBe(false)
  expect(placeholderFor('logic')).not.toMatch(HASH)
})

test('an unseen agent shows an activity placeholder that follows its tools, then takes a late title; the list does not clobber it with a bare type', () => {
  const m = newModel(NOW)
  beginCall(m, NOW, 'e99c4d20', 'Read', 'a.ts')
  expect(m.loops.get('e99c4d20')?.label).toBe('Agent · read')
  beginCall(m, NOW + 1, 'e99c4d20', 'Bash', 'vitest run')
  expect(m.loops.get('e99c4d20')?.label).toBe('Agent · tests')
  syncAgents(m, NOW + 2, [{ id: 'e99c4d20', description: '', type: 'general-purpose', status: 'running' }])
  expect(m.loops.get('e99c4d20')?.label).toBe('Agent · tests')
  expect(setLoopTitle(m, 'e99c4d20', 'Fix transcript lookup')).toBe(true)
  beginCall(m, NOW + 3, 'e99c4d20', 'Read', 'b.ts')
  expect(m.loops.get('e99c4d20')?.label).toBe('Fix transcript lookup')
  expect(setLoopTitle(m, 'e99c4d20', 'Other')).toBe(false)
  expect(JSON.stringify(snapshot(m, NOW + 4))).not.toMatch(HASH)
})

test('the ticker names an agent by its title and a later title replaces the placeholder in rebuilt rows', () => {
  const m = newModel(NOW)
  beginCall(m, NOW, 'e99c4d20', 'Read', 'a.ts')
  const label = (): string => m.loops.get('e99c4d20')?.label ?? ''
  expect(label()).not.toMatch(HASH)
  expect(`${shortNameOf(label())} started`).toBe('Agent · read started')
  setLoopTitle(m, 'e99c4d20', 'Review router state')
  expect(`${shortNameOf(label())} started`).toBe('Review router… started')
})

test('resolveBriefTitle: reads the transcript head once per agent, bounded retries, never throws', async () => {
  resetNames()
  let runs = 0
  const brief = JSON.stringify({ type: 'user', message: { content: 'Ticket: T66\n\nReview router state. More text.' } })
  const $ = {
    env: { get: async () => '/home/u' },
    session: { id: async () => 'sess1' },
    process: {
      run: async (argv: readonly string[]) => {
        runs++
        return argv[0] === 'find' ? { exitCode: 0, stdout: '/p/sess1/subagents/agent-ab12.jsonl\n' } : { exitCode: 0, stdout: brief }
      },
    },
  } as never
  expect(await resolveBriefTitle($, 'ab12', NOW)).toBe('Review router state')
  expect(runs).toBe(2)
  expect(await resolveBriefTitle($, 'ab12', NOW + 10_000)).toBeUndefined() // done: not asked again
  expect(runs).toBe(2)
  expect(await resolveBriefTitle($, 'bad id!', NOW)).toBeUndefined()
  const broken = { env: { get: async () => { throw new Error('x') } }, session: { id: async () => 's' }, process: { run: async () => ({ exitCode: 1, stdout: '' }) } } as never
  expect(await resolveBriefTitle(broken, 'cd34', NOW)).toBeUndefined()
  expect(await resolveBriefTitle(broken, 'cd34', NOW + 1)).toBeUndefined() // inside the retry gap: no second try
  resetNames()
})
