import { expect, test } from 'claude-code/testing'
import { plainTitle as canonical } from '../hooks/agent-names'
import { dropTicketNumber, plainTitle } from '../hooks/agent-roles'
import { agentBars, agentLanes, dodFrames, nameOf } from '../hooks/board-agents'
import { diffAgents, shortNameOf } from '../hooks/agents-info-data'
import type { AgentRow } from '../hooks/agents-info-data'
import { nowFrame } from '../hooks/now-frame'
import { titleOf } from '../hooks/run-records'
import { buildRun, parseTicket } from '../hooks/router-state'
import { routerFrames } from '../hooks/router-frames'
import type { BoardLane } from '../types'
import type { PulseLoop } from '../hooks/pulse-model'

const RAW = 'T50: workflow-insight frame T65'
const SLUG = '01-slug-name'
const NOW = 1_767_000_000_000
const TICKET_TOKEN = /\bT\d+\b/i
const SLUG_TOKEN = /^\d{2}-[a-z]/i
const lane: BoardLane = { id: 'lane', label: RAW, goal: RAW, step: RAW, note: RAW, state: 'working', pct: null, dod: [{ t: RAW, state: 'todo' }], at: null, startedAt: NOW, updatedAt: NOW, by: 'worker' }
const loop: PulseLoop = { id: 'worker', label: RAW, name: RAW, kind: 'subagent', status: 'running', lastTool: '', lastTarget: '', calls: 0, busy: 0, counts: {}, files: [], startedAt: NOW, lastAt: NOW }
const clean = (text: string): void => {
  expect(text).not.toMatch(TICKET_TOKEN)
  expect(text).not.toMatch(SLUG_TOKEN)
}

test('roles re-export the canonical function and keep the compatibility export', () => {
  expect(plainTitle).toBe(canonical)
  clean(dropTicketNumber(RAW))
  clean(dropTicketNumber('T63'))
})

test('board names, posted and orphan lanes, goals, steps and checklists are plain', () => {
  clean(nameOf(loop))
  for (const row of agentLanes([lane, { ...lane, id: 'orphan', label: SLUG }], [loop], RAW, NOW)) {
    for (const text of [row.label, row.goal, row.step, row.note, ...row.dod.map(d => d.t)]) clean(text)
  }
  const frame = dodFrames([lane])[0]?.frame
  if (frame?.type !== 'steps') throw new Error('Missing checklist')
  for (const text of [frame.title ?? '', frame.owner ?? '', ...frame.items.map(i => i.t)]) clean(text)
  const bars = agentBars([loop, { ...loop, id: 'other', label: SLUG, name: SLUG }], NOW)
  if (bars?.type !== 'bars') throw new Error('Missing bars')
  for (const item of bars.items) clean(item.label)
})

test('Now cleans the session title, agent activity, goal and last finished text', () => {
  for (const rows of [[], [lane, { ...lane, id: 'last', state: 'done' as const }]]) {
    const frame = nowFrame({ rows, task: RAW, status: 'working', now: NOW })
    clean(JSON.stringify(frame))
  }
})

test('run descriptions and brief-derived titles strip ids before clipping', () => {
  for (const title of [RAW, SLUG, 'T63', '']) clean(titleOf(title, 'codex', `Ticket: T7\n${RAW}`))
})

test('router titles, agent labels, notes and event details hide ticket ids', () => {
  const tickets = [RAW, SLUG].map((title, i) => parseTicket({ id: `work-${i}`, title, status: 'blocked', agent: RAW, lastEvidence: RAW }, `work-${i}`))
  const run = buildRun(tickets, [{ ts: NOW, type: 'blocked', ticket: tickets[0]!.id, detail: RAW }])
  for (const frame of routerFrames(run, NOW)) {
    clean(frame.title ?? '')
    if (frame.type === 'tickets') for (const item of frame.items) for (const text of [item.title, item.agent ?? '', item.note ?? '']) clean(text)
    if (frame.type === 'timeline') for (const item of frame.items) clean(item.text)
  }
})

test('ticker short names and all emitted event texts use titles, including old id-bearing rows', () => {
  for (const raw of [RAW, SLUG, 'T63']) clean(shortNameOf(raw))
  const row = { id: 'worker', name: RAW, short: 'T50', isMain: false, state: 'working', startedAt: NOW, endedAt: null, kind: 'logic', pct: null } as AgentRow
  for (const event of [...diffAgents([], [row], NOW, 0), ...diffAgents([row], [{ ...row, state: 'done', endedAt: NOW }], NOW, 0)]) clean(event.text)
})
