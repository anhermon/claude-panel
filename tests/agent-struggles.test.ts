// The Struggles report: what went wrong, with the quote of the error, not counts. Hand-built stories plus two real (trimmed, scrubbed)
// finished sub-agent transcripts.
import { expect, test } from 'claude-code/testing'

import { SLOW_CALL_MS, STALL_MS, struggleReportOf } from '../hooks/agent-struggles'
import { parseTranscript } from '../hooks/transcript-parse'
import { AGENTS_TILE_DRILLDOWN, METRICS_STRUGGLES_REDESIGN } from './fixtures/transcripts/fixtures'
import { bash, edit, nowAfter, parsedOf, read, SEC, said, T0 } from './transcript-script'
import type { Step } from './transcript-script'

const TEST_CMD = 'node --test agents-info'
const FAIL_OUT = 'not ok 3 - agents list\n  expected T43, got Fix lanes\n# tests 12\n# pass 11\n# fail 1'
const PASS_OUT = '# tests 12\n# pass 12\n# fail 0'
const report = (steps: Step[], isRunning = false) => struggleReportOf(parsedOf('brief', steps).entries, { now: nowAfter(steps), isRunning })

test('a failing command that later passes is resolved; one that never passes is open', () => {
  const fixed = report([bash(10, TEST_CMD, FAIL_OUT, { fail: true }), edit(20, '/p/a.js'), bash(30, TEST_CMD, PASS_OUT)])
  expect(fixed.items).toHaveLength(1)
  expect(fixed.items[0]).toMatchObject({ outcome: 'resolved' })
  expect(fixed.items[0]?.evidence).toContain('expected T43, got Fix lanes')
  expect(fixed.open).toBe(0)
  const stuck = report([bash(10, TEST_CMD, FAIL_OUT, { fail: true }), edit(20, '/p/a.js'), bash(30, TEST_CMD, FAIL_OUT, { fail: true })])
  expect(stuck.open).toBe(1)
  expect(stuck.items[0]).toMatchObject({ outcome: 'open', n: 2 })
  expect(stuck.headline).toContain('still open')
})

test('11 edits of one file with no failure: a neutral calm line, no struggle, badge 0', () => {
  const steps = Array.from({ length: 11 }, (_, i) => edit(10 + i * 5, '/p/web/list-view.js'))
  const r = report(steps, true)
  expect(r.items).toEqual([])
  expect(r.badge).toBe(0)
  expect(r.calm[0]).toMatchObject({ title: 'Iterating on list-view.js (11 edits, no failures)', n: 11 })
  expect(r.headline).toContain('No failures')
})

test('11 edits while the tests fail 4 times: one edit-test cycle that quotes the failing message', () => {
  const steps: Step[] = []
  for (let i = 0; i < 11; i++) {
    steps.push(edit(10 + i * 10, '/p/web/list-view.js'))
    if (i % 3 === 2 && steps.filter(s => s.fail).length < 4) steps.push(bash(14 + i * 10, TEST_CMD, FAIL_OUT, { fail: true }))
  }
  expect(steps.filter(s => s.fail)).toHaveLength(3)
  steps.push(bash(130, TEST_CMD, FAIL_OUT, { fail: true }))
  const r = report(steps)
  const cycles = r.items.filter(i => i.kind === 'edit-test-cycle')
  expect(cycles).toHaveLength(1)
  expect(cycles[0]?.title).toContain('list-view.js')
  expect(cycles[0]?.title).toContain('11')
  expect(cycles[0]?.evidence).toContain('expected T43, got Fix lanes')
  expect(cycles[0]?.n).toBe(4)
  expect(cycles[0]?.outcome).toBe('open')
  expect(r.calm).toEqual([])
})

test('a slow call and a long idle gap are named with how long; a quiet run has neither', () => {
  const slow = report([bash(10, 'npm run build', 'ok', { took: SLOW_CALL_MS / SEC + 30 }), said(10 + SLOW_CALL_MS / SEC + 40, 'built')])
  expect(slow.items.map(i => i.kind)).toEqual(['slow-call'])
  expect(slow.items[0]?.title).toMatch(/^Waited on build: /)
  expect(slow.items[0]?.evidence).toBe('npm run build')
  const gap = report([read(10, '/p/a.ts'), said(10 + STALL_MS / SEC + 60, 'back')])
  expect(gap.items.map(i => i.kind)).toEqual(['idle-gap'])
  expect(report([read(10, '/p/a.ts'), said(20, 'ok')]).items).toEqual([])
})

test('a refused tool is a wrong turn with the refusal quoted', () => {
  const steps: Step[] = [{ sec: 10, tool: 'Bash', input: { command: 'sleep 60' }, took: 1, fail: true, out: '<tool_use_error>Blocked: sleep 60 is not allowed</tool_use_error>' }]
  const r = report(steps)
  expect(r.items[0]).toMatchObject({ kind: 'wrong-turn' })
  expect(r.items[0]?.evidence).toContain('Blocked')
})

test('real transcripts: every struggle has a quote and a time; nothing is a bare count', () => {
  for (const text of [AGENTS_TILE_DRILLDOWN, METRICS_STRUGGLES_REDESIGN]) {
    const p = parseTranscript(text, true)
    const r = struggleReportOf(p.entries, { now: (p.entries.at(-1)?.t ?? 0) + 1000, isRunning: false })
    expect(r.items.length).toBeGreaterThan(0)
    for (const i of r.items) {
      expect(i.title.length).toBeGreaterThan(5)
      expect(i.evidence.length).toBeGreaterThan(0)
      expect(i.t).toBeGreaterThan(T0)
    }
    expect(r.badge).toBe(0)
    expect(r.headline.length).toBeGreaterThan(0)
  }
})
