// The auto diagrams: Mermaid text built from loops and lanes. Ids and labels stay structure-safe, the highlight map follows the states.
import { expect, test } from 'claude-code/testing'

import { GRAPH_CAPS, delegation, delegationFrame, idMaker, pipeline, pipelineFrame, safeLabel } from '../hooks/agent-graph'
import { validateFrame } from '../hooks/board-frames'
import type { PulseEvent, PulseLoop } from '../hooks/pulse-model'
import { buildRun, parseEvents, parseTicket } from '../hooks/router-state'
import type { BoardLane } from '../types'

const loop = (id: string, over: Partial<PulseLoop> = {}): PulseLoop => ({
  id, label: id, kind: 'subagent', status: 'running', lastTool: '', lastTarget: '', calls: 0, busy: 0, counts: {}, files: [], startedAt: 1000, lastAt: 1000, ...over,
})
const main = loop('main', { kind: 'main', name: 'main' })
const lane = (id: string, over: Partial<BoardLane> = {}): BoardLane => ({
  id, label: id, state: 'working', pct: null, step: '', note: '', goal: '', dod: [], at: null, startedAt: 0, updatedAt: 0, by: id, loop: id, ...over,
})

test('safeLabel strips what Mermaid reads as structure and never returns empty', () => {
  expect(safeLabel('a"b[c](d);e:f#g|h<i>\nj', 40)).toBe('a b c d e f g h i j')
  expect(safeLabel('"""', 10)).toBe('x')
  expect(safeLabel('x'.repeat(30), 10)).toHaveLength(10)
  expect(safeLabel('réseau 2/3', 20)).toBe('réseau 2/3')
})

test('idMaker gives letters-and-digits ids, stable per raw id and distinct on collisions', () => {
  const id = idMaker()
  const a = id('agent-1/x')
  expect(a).toBe('nagent1x')
  expect(id('agent-1/x')).toBe(a)
  expect(id('agent.1.x')).toBe('nagent1x2')
  expect(id('!!!')).toBe('nx')
  expect(id('A'.repeat(40))).toBe(`n${'a'.repeat(GRAPH_CAPS.ID_CHARS)}`)
  expect(idMaker('l')('end')).toBe('lend')
})

test('delegation: nothing below two agents; spawn and done/failed in time order; highlight by state', () => {
  expect(delegation([main, loop('a')])).toBeUndefined()
  const loops = [
    main,
    loop('a', { name: 'research (sonnet/high)', startedAt: 1000, lastAt: 3000, status: 'done' }),
    loop('b', { name: 'writer', startedAt: 2000, lastAt: 5000, status: 'done' }),
    loop('c', { name: 'tester', startedAt: 4000, lastAt: 4500, status: 'running' }),
  ]
  const events: PulseEvent[] = [{ t: 4900, loop: 'b', tool: 'Bash', target: '', err: true }]
  const g = delegation(loops, events)
  expect(g?.code).toBe([
    'sequenceDiagram',
    '  participant main as Main session',
    '  participant na as research',
    '  participant nb as writer',
    '  participant nc as tester',
    '  main->>na: spawn research',
    '  main->>nb: spawn writer',
    '  na-->>main: done',
    '  main->>nc: spawn tester',
    '  nb--xmain: failed',
  ].join('\n'))
  expect(g?.highlight).toEqual({ na: 'done', nb: 'blocked', nc: 'active' })
})

test('delegation keeps the last GRAPH_CAPS.DELEGATION_STEPS steps and at most GRAPH_CAPS.PARTICIPANTS participants, and the title says how many agents are left out', () => {
  const loops = [main, ...Array.from({ length: 9 }, (_, i) => loop(`w${i}`, { startedAt: 1000 + i, lastAt: 1000 + i, status: 'running' }))]
  const g = delegation(loops)
  const messages = g?.code.split('\n').filter(l => l.includes('->>')) ?? []
  expect(messages).toHaveLength(GRAPH_CAPS.PARTICIPANTS)
  expect(messages[0]).toContain(`nw${9 - GRAPH_CAPS.PARTICIPANTS}`)
  expect(messages.at(-1)).toContain('nw8')
  expect(g?.code.split('\n').filter(l => l.includes('participant n'))).toHaveLength(GRAPH_CAPS.PARTICIPANTS)
  expect(Object.keys(g?.highlight ?? {})).toHaveLength(GRAPH_CAPS.PARTICIPANTS)
  expect(delegationFrame(loops)?.title).toBe(`Handoffs · latest ${GRAPH_CAPS.PARTICIPANTS} of 9`)
})

test('delegation: hostile names cannot add structure', () => {
  const g = delegation([main, loop('a', { name: 'x\nmain->>main: pwn;' }), loop('b')])
  expect(g?.code.split('\n').every(l => !l.startsWith('main->>main'))).toBe(true)
  expect(g?.code).not.toContain(';')
})

test('pipeline: tracks from checklists and single nodes, classes and highlight by state', () => {
  const loops = [main, loop('a'), loop('b')]
  const rows = [
    lane('main', { loop: 'main' }),
    lane('a', { label: 'builder', dod: [{ t: 'Write code', state: 'done' }, { t: 'Run tests', state: 'todo' }, { t: 'Ship', state: 'todo' }], at: 1 }),
    lane('b', { label: 'reviewer', state: 'blocked' }),
  ]
  const g = pipeline(rows, loops)
  expect(g?.code).toBe([
    'flowchart LR',
    '  subgraph s0["builder"]',
    '    direction LR',
    '    lai0["Write code"]',
    '    lai1["Run tests"]',
    '    lai2["Ship"]',
    '    lai0 --> lai1 --> lai2',
    '  end',
    '  lb["reviewer"]',
    '  classDef active stroke:#38bdf8,stroke-width:2px',
    '  classDef done stroke:#4ade80,stroke-width:2px',
    '  classDef blocked stroke:#f87171,stroke-width:2px',
    '  classDef todo stroke:#64748b,stroke-width:2px',
    '  class lai1 active',
    '  class lai0 done',
    '  class lb blocked',
    '  class lai2 todo',
  ].join('\n'))
  expect(g?.highlight).toEqual({ lai0: 'done', lai1: 'active', lai2: 'todo', lb: 'blocked' })
})

test('pipeline: nothing below two agents or with only the main row; at most 4 tracks of 6 items', () => {
  expect(pipeline([lane('a')], [main, loop('a')])).toBeUndefined()
  expect(pipeline([lane('main', { loop: 'main' })], [main, loop('a'), loop('b')])).toBeUndefined()
  const many = Array.from({ length: 6 }, (_, i) => lane(`t${i}`, { dod: Array.from({ length: 6 }, (_, k) => ({ t: `s${k}`, state: 'todo' as const })) }))
  const g = pipeline(many, [main, loop('a'), loop('b')])
  expect(g?.code.split('\n').filter(l => l.includes('subgraph'))).toHaveLength(GRAPH_CAPS.PIPELINE_TRACKS)
  expect(Object.keys(g?.highlight ?? {})).toHaveLength(GRAPH_CAPS.PIPELINE_TRACKS * GRAPH_CAPS.DOD_ITEMS)
})

test('the frames are valid uml frames and absent below two agents', () => {
  const loops = [main, loop('a', { status: 'done', lastAt: 2000 }), loop('b')]
  const d = delegationFrame(loops)
  const p = pipelineFrame([lane('a'), lane('b')], loops)
  for (const f of [d, p]) expect(validateFrame(f)).toEqual(f)
  expect(d?.id).toBe('delegation')
  expect(p?.id).toBe('pipeline')
  expect(delegationFrame([main])).toBeUndefined()
  expect(pipelineFrame([], [main])).toBeUndefined()
})

// ---- router-kit roles ----------------------------------------------------------------------------------------------------

const routerRun = (events: Record<string, string>[] = []) =>
  buildRun(['01-slugify', '02-is-palindrome'].map(id => parseTicket({ id, status: 'in_progress' }, id)), parseEvents(events.map(e => JSON.stringify(e)).join('\n')))
const verdict = (type: string, ticket: string) => ({ ts: '2026-11-09T10:00:00Z', type, ticket, detail: '' })

test('delegation in a router run: the main box is the router, agent boxes carry role and ticket number, ordinary agents keep their name', () => {
  const loops = [
    main,
    loop('w1', { type: 'worker', label: 'Worker 01-slugify', startedAt: 1000, lastAt: 2000, status: 'done' }),
    loop('v1', { type: 'verifier', label: 'verify 01-slugify', startedAt: 3000, lastAt: 4000, status: 'running' }),
    loop('x', { type: 'Explore', label: 'Survey docs', startedAt: 3500, lastAt: 3500, status: 'running' }),
    loop('c1', { type: 'codex-worker', label: 'codex 02-is-palindrome', startedAt: 3600, lastAt: 3600, status: 'running' }),
  ]
  const g = delegation(loops, [], routerRun())
  expect(g?.code).toContain('participant main as router')
  expect(g?.code).toContain('as worker 01')
  expect(g?.code).toContain('as verifier 01')
  expect(g?.code).toContain('as Survey docs')
  expect(g?.code).toContain('as codex 02')
  expect(g?.code).toContain('main->>nv1: spawn verifier 01')
})

test('delegation without a run: the main box stays main, an agent of a role type shows its role, no ticket or verdict is invented', () => {
  const loops = [
    main,
    loop('w1', { type: 'worker', label: 'Worker 01-slugify', startedAt: 1000, lastAt: 2000, status: 'done' }),
    loop('x', { label: 'Worker pool survey', startedAt: 1500, lastAt: 1500 }),
  ]
  const g = delegation(loops, [])
  expect(g?.code).toContain('participant main as Main session')
  expect(g?.code).toContain('as worker\n')
  expect(g?.code).toContain('as Worker pool s')
  expect(g?.code).toContain('nw1-->>main: done')
})

test('a role without a ticket is just the role word', () => {
  const g = delegation([main, loop('w', { type: 'worker', label: 'do the thing' }), loop('v', { type: 'verifier', label: 'check it' })], [], routerRun())
  expect(g?.code).toContain('as worker\n')
  expect(g?.code).toContain('as verifier\n')
})

test('verifier replies to the router read PASS / FAIL from the router events, newest verifier with the newest verdict', () => {
  const loops = [
    main,
    loop('v1', { type: 'verifier', label: 'verify 01-slugify', startedAt: 1000, lastAt: 2000, status: 'done' }),
    loop('v2', { type: 'verifier', label: 'verify 01-slugify', startedAt: 3000, lastAt: 4000, status: 'done' }),
    loop('v3', { type: 'verifier', label: 'verify 02-is-palindrome', startedAt: 3500, lastAt: 5000, status: 'done' }),
  ]
  const events = [verdict('verify_fail', '01-slugify'), verdict('verify_pass', '02-is-palindrome'), verdict('verify_pass', '01-slugify')]
  const code = delegation(loops, [], routerRun(events))?.code ?? ''
  expect(code).toContain('nv1-->>main: FAIL')
  expect(code).toContain('nv2-->>main: PASS')
  expect(code).toContain('nv3-->>main: PASS')
})

test('a verifier with no verdict event yet, and a failed verifier, keep done / failed', () => {
  const loops = [
    main,
    loop('v1', { type: 'verifier', label: 'verify 01-slugify', startedAt: 1000, lastAt: 2000, status: 'done' }),
    loop('v2', { type: 'verifier', label: 'verify 02-is-palindrome', startedAt: 1500, lastAt: 3000, status: 'done' }),
  ]
  const code = delegation(loops, [{ t: 2900, loop: 'v2', tool: 'Bash', target: '', err: true }], routerRun())?.code ?? ''
  expect(code).toContain('nv1-->>main: done')
  expect(code).toContain('nv2--xmain: failed')
  const only = delegation(loops, [], routerRun([verdict('verify_pass', '01-slugify')]))?.code ?? ''
  expect(only).toContain('nv1-->>main: PASS')
  expect(only).toContain('nv2-->>main: done')
})

test('role labels stay inside the Mermaid-safe set and the box cap', () => {
  const g = delegation([main, loop('a', { type: 'codex-worker', label: 'x 03-reverse-words' }), loop('b', { type: 'verifier', label: 'verify 05-x' })], [], buildRun([parseTicket({ id: '03-reverse-words' }, 'a'), parseTicket({ id: '05-x' }, 'b')], []))
  for (const line of (g?.code ?? '').split('\n').filter(l => l.includes('participant'))) expect((line.split(' as ')[1] ?? '').replaceAll('<br/>', ' ').length).toBeLessThanOrEqual(GRAPH_CAPS.NAME_CHARS)
})

test('delegationFrame passes the run through', () => {
  const f = delegationFrame([main, loop('a', { type: 'worker', label: 'w 01-slugify' }), loop('b')], [], routerRun())
  expect(f?.type === 'uml' && f.code).toContain('worker 01')
})

test('a long agent title wraps on two lines at a word boundary; a placeholder title is no hash', () => {
  const g = delegation([main, loop('e99c1234', { name: 'Board layout and spacing review pass', label: 'x' }), loop('b', { name: 'Agent · read', label: 'x' })])
  expect(g?.code).toContain('as Board layout and<br/>spacing review pass')
  expect(g?.code).toContain('spawn Board layout and spacing')
  expect(g?.code).not.toMatch(/agent [0-9a-f]{4}/i)
})
