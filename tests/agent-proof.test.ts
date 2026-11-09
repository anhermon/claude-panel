// T68: the proof of a delegated ticket agent. `Eval:` in the brief, `Eval result: PASS|FAIL` in the final report, the three states
// (no eval / eval not passed / passed), an agent that is not a ticket never flagged, and the bounded lazy transcript lookup.
import { expect, test } from 'claude-code/testing'

import { briefTextOf, evalLineOf, finalTextOf, isTicketBrief, PROOF_CAPS, proofOf, resetProof, resolveProof, resultOfReport, whatOfEval } from '../hooks/agent-proof'
import { beginCall, newModel, restore, setLoopProof, snapshot, syncAgents } from '../hooks/pulse-model'
import { agentRowsOf } from '../hooks/agents-info-data'
import type { BoardInput } from '../hooks/board-model'

const NOW = 1_767_000_000_000
const BRIEF = 'Ticket: T68\nRepo: the panel mod\n\nGOAL: every ticket needs an eval.\n\nEval: run `node --test web/**/*.test.mjs`; pass means 0 failures. Then render it.\n\nHARD RULES: max 800 lines.'
const REPORT_PASS = 'Result: done.\n\nVerification: all green.\n\nEval result: PASS\n12 tests, 0 failures'

test('isTicketBrief: a `Ticket:` line makes it a ticket, nothing else does', () => {
  expect(isTicketBrief(BRIEF)).toBe(true)
  expect(isTicketBrief('  ticket: T9\nDo it')).toBe(true)
  expect(isTicketBrief('Survey the docs and report.')).toBe(false)
  expect(isTicketBrief('Please open a ticket: T9 is a thing')).toBe(false)
})

test('evalLineOf: the `Eval:` line of the brief, scrubbed and cut; "Eval result:" is not an eval line; absent gives empty', () => {
  expect(evalLineOf(BRIEF)).toBe('run `node --test web/**/*.test.mjs`; pass means 0 failures. Then render it.')
  expect(evalLineOf('Ticket: T1\n- **Eval:** open the page and see the chip')).toBe('open the page and see the chip')
  expect(evalLineOf('Ticket: T1\nEval result: PASS is what the report ends with')).toBe('')
  expect(evalLineOf('Ticket: T1\nno such line')).toBe('')
  expect(evalLineOf(`Eval: ${'x'.repeat(500)}`).length).toBeLessThanOrEqual(PROOF_CAPS.EVAL_CHARS)
})

test('whatOfEval: plain words, the first clause, within 60 characters', () => {
  expect(whatOfEval('run `node --test web/**/*.test.mjs`; pass means 0 failures. Then render it.')).toBe('run node --test web/**/*.test.mjs')
  expect(whatOfEval('open the [board](http://x) and see the chip.')).toBe('open the board and see the chip')
  const long = whatOfEval(`check ${'every single little thing '.repeat(8)}`)
  expect(long.length).toBeLessThanOrEqual(PROOF_CAPS.WHAT_CHARS)
  expect(long.endsWith('…')).toBe(true)
  expect(whatOfEval('')).toBe('')
})

test('resultOfReport: only a stated PASS is pass; FAIL is fail; the last marker wins; a missing marker is none', () => {
  expect(resultOfReport(REPORT_PASS)).toBe('pass')
  expect(resultOfReport('...\nEval result: FAIL\n2 failures')).toBe('fail')
  expect(resultOfReport('**Eval result: PASS**')).toBe('pass')
  expect(resultOfReport('Eval result: FAIL\nfixed it\nEval result: PASS')).toBe('pass')
  expect(resultOfReport('Eval result: PASS\nthen it broke\nEval result: FAIL')).toBe('fail')
  expect(resultOfReport('Everything works. All tests pass.')).toBe('none')
  expect(resultOfReport('Eval result: maybe')).toBe('none')
  expect(resultOfReport('')).toBe('none')
})

test('proofOf: no Ticket line is no proof (never flagged); a ticket without an Eval line has an empty eval; with PASS it is pass', () => {
  expect(proofOf('Survey the docs', REPORT_PASS)).toBeUndefined()
  expect(proofOf('Ticket: T1\nDo the thing', REPORT_PASS)).toEqual({ eval: '', what: '', result: 'none' }) // a PASS cannot prove a missing eval
  expect(proofOf(BRIEF, 'Result: done')).toEqual({ eval: evalLineOf(BRIEF), what: 'run node --test web/**/*.test.mjs', result: 'none' })
  expect(proofOf(BRIEF, REPORT_PASS)).toMatchObject({ result: 'pass', what: 'run node --test web/**/*.test.mjs' })
  expect(proofOf(BRIEF, 'Eval result: FAIL')).toMatchObject({ result: 'fail' })
})

const row = (type: string, text: string): string => JSON.stringify({ type, message: { content: [{ type: 'text', text }] } })

test('briefTextOf / finalTextOf: the whole first message, and the last assistant text of a tail (a cut first line is skipped)', () => {
  expect(briefTextOf(row('user', BRIEF))).toBe(BRIEF)
  expect(briefTextOf(JSON.stringify({ type: 'user', message: { content: BRIEF } }))).toBe(BRIEF)
  expect(briefTextOf(row('assistant', 'hi'))).toBe('')
  expect(briefTextOf('{"type":"user","mess')).toBe('')
  const tail = ['ssage":{"content":"cut line"}}', row('assistant', 'working'), JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash' }] } }), row('assistant', REPORT_PASS), JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result' }] } })].join('\n')
  expect(finalTextOf(tail)).toBe(REPORT_PASS)
  expect(finalTextOf('')).toBe('')
})

/** A pretend `$` whose transcript has the given lines (find, head -c, tail -c). */
function pretend(lines: string[], counts: { runs: number } = { runs: 0 }) {
  return {
    env: { get: async () => '/home/u' },
    session: { id: async () => 'sess1' },
    process: {
      run: async (argv: readonly string[]) => {
        counts.runs++
        if (argv[0] === 'find') return { exitCode: 0, stdout: '/p/sess1/subagents/agent-ab12.jsonl\n' }
        return { exitCode: 0, stdout: lines.join('\n') + '\n' }
      },
    },
  } as never
}

test('resolveProof: a finished ticket agent gets its proof once; a non-ticket gets null (unflagged); bounded retries; never throws', async () => {
  resetProof()
  const counts = { runs: 0 }
  const $ = pretend([row('user', BRIEF), row('assistant', 'working'), row('assistant', REPORT_PASS)], counts)
  expect(await resolveProof($, 'ab12', NOW)).toMatchObject({ result: 'pass', eval: evalLineOf(BRIEF) })
  expect(counts.runs).toBe(3) // find + head + tail
  expect(await resolveProof($, 'ab12', NOW + 10_000)).toBeUndefined() // done: not asked again
  expect(counts.runs).toBe(3)
  const plain = { runs: 0 }
  expect(await resolveProof(pretend([row('user', 'Survey the docs'), row('assistant', 'Eval result: PASS')], plain), 'plain', NOW)).toBeNull()
  expect(plain.runs).toBe(2) // find + head; the tail is not read for a non-ticket
  expect(await resolveProof($, 'main', NOW)).toBeUndefined()
  expect(await resolveProof($, 'bad id!', NOW)).toBeUndefined()
  const broken = { env: { get: async () => { throw new Error('x') } }, session: { id: async () => 's' }, process: { run: async () => ({ exitCode: 1, stdout: '' }) } } as never
  expect(await resolveProof(broken, 'cd34', NOW)).toBeUndefined()
  expect(await resolveProof(broken, 'cd34', NOW + 1)).toBeUndefined() // inside the retry gap
  resetProof()
})

test('the pulse keeps the proof of a loop, survives a snapshot round trip, and an agents row carries it (null for the session and non-tickets)', () => {
  const m = newModel(NOW)
  beginCall(m, NOW, 'main', 'Read', 'a.ts')
  beginCall(m, NOW, 'cd34', 'Read', 'b.ts') // a second agent still running: the crew shows
  beginCall(m, NOW, 'ab12', 'Read', 'a.ts')
  syncAgents(m, NOW + 1, [{ id: 'ab12', description: 'Add the eval chip', type: 'general-purpose', status: 'completed' }])
  expect(m.loops.get('ab12')?.proof).toBeUndefined()
  const proof = proofOf(BRIEF, REPORT_PASS)!
  expect(setLoopProof(m, 'ab12', proof)).toBe(true)
  expect(setLoopProof(m, 'ab12', proof)).toBe(false) // unchanged: not dirty again
  expect(setLoopProof(m, 'nobody', proof)).toBe(false)
  const snap = JSON.parse(JSON.stringify(snapshot(m, NOW + 2)))
  const back = newModel(NOW)
  expect(restore(back, snap)).toBe(true)
  expect(back.loops.get('ab12')?.proof).toEqual(proof)
  const input: Pick<BoardInput, 'lanes' | 'loops' | 'events' | 'now' | 'task' | 'router'> = { lanes: [], loops: [...m.loops.values()], events: [], now: NOW + 3, task: null, router: undefined }
  const rows = agentRowsOf(input).agents
  expect(rows.map(r => r.loop)).toEqual(expect.arrayContaining(['ab12']))
  expect(rows.find(r => r.loop === 'ab12')?.proof).toEqual(proof)
  expect(rows.find(r => r.isMain)?.proof).toBeNull()
})
