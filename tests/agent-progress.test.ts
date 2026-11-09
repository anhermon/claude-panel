// The Progress of an agent: now, plan (posted or derived, evidence-based), done, decisions in its own words, issues, and the phases over
// its real time. Hand-built stories plus two real (trimmed, scrubbed) finished sub-agent transcripts.
import { expect, test } from 'claude-code/testing'

import { phasesOf, progressOf } from '../hooks/agent-progress'
import { forbiddenOf } from '../hooks/agent-plan'
import { isToolEntry } from '../hooks/agent-evidence'
import { parseTranscript } from '../hooks/transcript-parse'
import { AGENTS_TILE_DRILLDOWN, METRICS_STRUGGLES_REDESIGN } from './fixtures/transcripts/fixtures'
import { bash, edit, nowAfter, parsedOf, read, said, SEC, T0, write } from './transcript-script'
import type { Step } from './transcript-script'

const BRIEF = [
  'You are a worker on T9.',
  '',
  'TASK:',
  '1. Edit hooks/alpha.ts so it exports the ladder.',
  '2. Edit hooks/beta.ts to use it.',
  '3. Run `tsc -p .` and keep it clean.',
  '4. Update the README with notes.',
  '5. Edit hooks/gamma.ts too.',
  '',
  'Do not touch hooks/forbidden.ts.',
].join('\n')

const progress = (steps: Step[], brief = BRIEF, over: { lane?: Parameters<typeof progressOf>[0]['lane']; state?: string } = {}) => {
  const p = parsedOf(brief, steps)
  const now = nowAfter(steps)
  return progressOf({ entries: p.entries, brief: p.briefFull ?? '', lane: over.lane, state: over.state ?? 'working', endedAt: over.state === 'done' ? now : null, now })
}

test('the derived checklist marks only evidence-backed items done; the rest is "not shown yet", at most one is in progress', () => {
  const r = progress([
    edit(10, '/p/hooks/alpha.ts'),
    read(20, '/p/hooks/beta.ts'),
    bash(30, 'tsc -p .', 'error TS2304: Cannot find name x', { fail: true }),
    edit(40, '/p/hooks/gamma.ts'),
    bash(50, 'tsc -p .', ''),
  ])
  expect(r.plan.source).toBe('brief')
  const byText = (s: string) => r.plan.items.find(i => i.text.includes(s))
  expect(byText('alpha.ts')?.state).toBe('done')
  expect(byText('alpha.ts')?.evidence).toContain('alpha.ts')
  expect(byText('beta.ts')?.state).not.toBe('done')
  expect(byText('tsc')?.state).toBe('done') // it failed once, then ran clean
  expect(byText('README')?.state).toBe('todo')
  expect(byText('gamma.ts')?.state).toBe('done')
  expect(r.plan.items.filter(i => i.state === 'doing').length).toBeLessThanOrEqual(1)
  expect(r.plan.items).toHaveLength(5)
})

test('a command item is done only when the command ran and exited 0, failed when its last run failed', () => {
  const failed = progress([bash(10, 'tsc -p .', 'error TS2304: Cannot find name x', { fail: true })])
  expect(failed.plan.items.find(i => i.text.includes('tsc'))?.state).toBe('failed')
  const passed = progress([bash(10, 'tsc -p .', 'error TS2304: x', { fail: true }), bash(20, 'tsc -p .', '')])
  expect(passed.plan.items.find(i => i.text.includes('tsc'))?.state).toBe('done')
})

test('a posted lane wins: its dod is shown as posted, with the label saying so', () => {
  const lane = { step: 'editing beta', note: 'waiting on T73', goal: 'ladder', at: 1, dod: [{ t: 'alpha', state: 'done' as const }, { t: 'beta', state: 'todo' as const }] }
  const r = progress([edit(10, '/p/hooks/alpha.ts')], BRIEF, { lane })
  expect(r.plan.source).toBe('lane')
  expect(r.plan.label).toBe('posted by the agent')
  expect(r.plan.items.map(i => i.state)).toEqual(['done', 'doing'])
  expect(r.now.laneStep).toBe('editing beta')
  expect(r.now.laneNote).toBe('waiting on T73')
})

test('no brief items and no lane: no plan is invented', () => {
  expect(progress([read(10, '/p/a.ts')], 'Just have a look around.').plan).toMatchObject({ source: 'none', items: [] })
})

test('a decision is a sentence in the agent\'s own words that states a choice; questions and plain narration are not', () => {
  const r = progress([
    said(10, 'Reading the files first.'),
    said(20, "I'll use the glob instead because the directory argument fails on this node. Then I will run the tests."),
    said(30, 'Should I use the glob?'),
  ])
  expect(r.decisions.map(d => d.quote)).toEqual(["I'll use the glob instead because the directory argument fails on this node."])
  expect(r.decisions[0]?.t).toBe(T0 + 20 * SEC)
})

test('decisions on the real transcripts are real quotes from the agent', () => {
  for (const [text, expected] of [[METRICS_STRUGGLES_REDESIGN, "Directory arg doesn't work on this node; use the glob."], [AGENTS_TILE_DRILLDOWN, 'Sed failed on macOS; use Edit.']] as const) {
    const p = parseTranscript(text, true)
    const last = p.entries.at(-1)?.t ?? 0
    const r = progressOf({ entries: p.entries, brief: p.briefFull ?? '', lane: undefined, state: 'done', endedAt: last, now: last + 1000 })
    expect(r.decisions.length).toBeGreaterThan(0)
    expect(r.decisions.length).toBeLessThanOrEqual(5)
    expect(r.decisions.map(d => d.quote)).toContain(expected)
    const said = p.entries.flatMap(e => (e.kind === 'say' ? [e.text] : [])).join('\n')
    for (const d of r.decisions) expect(said.replace(/[*`]/g, '')).toContain(d.quote.replace(/…$/, '').slice(0, 30))
  }
})

test('done so far: files grouped by folder, the last result of each check, images read', () => {
  const r = progress([
    write(5, '/p/web/new.js'),
    edit(10, '/p/hooks/alpha.ts'),
    edit(15, '/p/hooks/alpha.ts'),
    read(18, '/p/shots/a.png'),
    bash(20, 'tsc -p .', 'error TS2304: x', { fail: true }),
    bash(30, 'tsc -p .', ''),
    bash(40, 'node --test web/x.test.mjs', '# tests 9\n# pass 9\n# fail 0'),
  ])
  expect(r.done.files).toBe(2)
  expect(r.done.folders.map(f => [f.dir, f.created, f.edited])).toEqual([['hooks', 0, 2], ['web', 1, 0]])
  const tsc = r.done.checks.find(c => c.label.toLowerCase().includes('type'))
  expect(tsc).toMatchObject({ outcome: 'pass', runs: 2 })
  expect(r.done.checks.find(c => c.result.includes('9 pass'))?.outcome).toBe('pass')
  expect(r.done.images).toEqual(['a.png'])
})

test('issues: an open failure, a deviation from the brief and a waiting question come first; a clean run says "no failures so far"', () => {
  const r = progress([
    bash(10, 'node --test x', 'not ok 1 - a\n  expected 1, got 2', { fail: true }),
    edit(20, '/p/hooks/forbidden.ts'),
    said(30, 'The test still fails. Which fixture should I use?'),
  ])
  expect(r.issues.openCount).toBe(3)
  expect(r.issues.list.map(i => i.kind).sort()).toEqual(['deviation', 'failure', 'question'])
  expect(r.issues.list.find(i => i.kind === 'failure')?.evidence).toContain('expected 1, got 2')
  expect(r.issues.list.find(i => i.kind === 'deviation')?.title).toContain('forbidden.ts')
  const clean = progress([read(10, '/p/a.ts'), said(15, 'Looking at the code now.')])
  expect(clean.issues.openCount).toBe(0)
  expect(clean.issues.summary).toContain('No failures so far')
})

test('forbiddenOf reads "do not touch" sentences, globs and "those"', () => {
  expect(forbiddenOf('Do not touch avatar-*.js or mascot-grid.*. Other work.')).toEqual(['avatar-*.js', 'mascot-grid.*'])
  expect(forbiddenOf('T69 edits (gantt-a.js, list-view.js - do NOT edit those)')).toEqual(['gantt-a.js', 'list-view.js'])
  expect(forbiddenOf('Edit everything you like.')).toEqual([])
})

test('now: the call in flight with how long, and silence says so', () => {
  const steps: Step[] = [read(10, '/p/a.ts'), { sec: 20, tool: 'Bash', input: { command: 'npm run build' } }]
  const p = parsedOf('b', steps)
  const running = progressOf({ entries: p.entries, brief: '', lane: undefined, state: 'working', endedAt: null, now: T0 + 20 * SEC + 90 * SEC })
  expect(running.now.call?.text).toContain('npm run build')
  expect(running.now.call?.runningMs).toBe(90 * SEC)
  expect(running.now.pace).toContain('Waiting 1 min 30 s')
  const quiet = progressOf({ entries: parsedOf('b', [read(10, '/p/a.ts')]).entries, brief: '', lane: undefined, state: 'working', endedAt: null, now: T0 + 10 * SEC + 4 * 60 * SEC })
  expect(quiet.now.pace).toContain('No activity for 4 min')
  expect(quiet.now.pace).toContain('read a.ts')
})

test('phases: consecutive calls of one kind are one labelled stretch over real time; the first starts at the first call and they do not overlap', () => {
  const steps: Step[] = [read(10, '/p/a.ts'), read(40, '/p/b.ts'), edit(90, '/p/hooks/crew-view.js'), edit(150, '/p/hooks/crew-view.js'), bash(200, 'node --test x', '# pass 3\n# fail 0', { took: 60 })]
  const tools = parsedOf('b', steps).entries.filter(isToolEntry)
  const phases = phasesOf(tools, { from: T0 + 10 * SEC, now: T0 + 300 * SEC, isRunning: false })
  expect(phases.map(p => p.label)).toEqual(['read files', 'edit crew-view.js', 'tests'])
  expect(phases.map(p => p.kind)).toEqual(['read', 'edit', 'tests'])
  phases.forEach((p, i) => {
    expect(p.b).toBeGreaterThan(p.a)
    if (i > 0) expect(p.a).toBe((phases[i - 1] as { b: number }).b)
  })
  expect(phases[2]?.ms).toBe(260 * SEC - 151 * SEC) // from the end of the last edit to the end of the test run
  expect(phases.some(p => p.isCurrent)).toBe(false)
  expect(phasesOf(tools, { from: T0 + 10 * SEC, now: T0 + 300 * SEC, isRunning: true }).at(-1)?.isCurrent).toBe(true)
})

test('phases on the real transcripts: labelled, ordered, covering the run; no calls at all says why instead', () => {
  for (const text of [AGENTS_TILE_DRILLDOWN, METRICS_STRUGGLES_REDESIGN]) {
    const p = parseTranscript(text, true)
    const last = p.entries.at(-1)?.t ?? 0
    const r = progressOf({ entries: p.entries, brief: p.briefFull ?? '', lane: undefined, state: 'done', endedAt: last, now: last + 1000 })
    expect(r.phases.length).toBeGreaterThan(2)
    expect(r.phases.length).toBeLessThanOrEqual(14)
    expect(r.phaseNote).toBe('')
    expect(r.phases.every(ph => ph.label !== '' && ph.ms > 0)).toBe(true)
    r.phases.forEach((ph, i) => { if (i > 0) expect(ph.a).toBe((r.phases[i - 1] as { b: number }).b) })
    expect(new Set(r.phases.map(ph => ph.kind)).size).toBeGreaterThan(1)
  }
  const none = progress([said(10, 'Thinking about it for a while.')])
  expect(none.phases).toEqual([])
  expect(none.phaseNote).toContain('no phases can be shown')
})
