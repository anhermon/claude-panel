// Task titles are cleaned at the hooks source, before frame caps or collision suffixes.
import { expect, test } from 'claude-code/testing'

import { clipTitle, plainTitle, uniqueTitles } from '../hooks/agent-names'
import { FRAME_CAPS, validateFrame } from '../hooks/board-frames'
import { insightFrames, INSIGHT_FRAME_IDS } from '../hooks/insight-frames'
import { REPEAT_FRAME_ID } from '../hooks/insight-repeats'
import { subjectsOf, TIME_FRAME_IDS } from '../hooks/insight-time'
import { applyOptions } from '../hooks/panel-config'
import type { PulseLoop } from '../hooks/pulse-model'
import { routerFrames, ROUTER_FRAME } from '../hooks/router-frames'
import { buildRun, parseTicket } from '../hooks/router-state'

const NOW = 1_767_000_000_000
const RUN_MS = 200_000
const SPAN_MS = 100_000
const CALLS = 4
const TOKENS = 12_000
const TICKET_TOKEN = /\bT\d+\b/i
const SLUG_TOKEN = /\b\d+[-_][a-z]/i
const ROUTING_NOTE = /\(sonnet\/high\)/
const FILE_KEY = 'read:board.css'
const CASES = [
  { raw: 'T47 Fleet view (sonnet/high)', title: 'Fleet view' },
  { raw: '01-slugify the title', title: 'Slugify the title' },
  { raw: 'T48 · Fleet view', title: 'Fleet view 2' },
  { raw: 'Plain task title', title: 'Plain task title' },
] as const
const LONG_TITLE = 'Fleet view activity across all workers'
const OTHER_LONG_TITLE = 'Fleet view activity across all sessions'
const EXPECTED_CLIP = 'Fleet view activity across…'
const CLIPPED_DUPLICATE = 'Fleet view activity… 2'
const DUPLICATE_COUNT = 2
const WORK_KIND = 'tests'

const loop = (name: string, index: number): PulseLoop => ({
  id: `worker-${index}`, label: name, name, kind: 'subagent', status: 'done',
  lastTool: '', lastTarget: '', calls: CALLS, busy: 0, counts: {}, files: [],
  startedAt: NOW - RUN_MS, lastAt: NOW, tokens: TOKENS,
  spans: [{ k: WORK_KIND, t: NOW - RUN_MS, e: NOW - RUN_MS + SPAN_MS, n: CALLS }],
  tally: { [FILE_KEY]: { n: CALLS, err: 0, retry: 0, ms: 0 } },
})

const assertNoIds = (value: unknown): void => {
  const text = JSON.stringify(value)
  expect(text).not.toMatch(TICKET_TOKEN)
  expect(text).not.toMatch(SLUG_TOKEN)
  expect(text).not.toMatch(ROUTING_NOTE)
}

test('insight frames use full plain titles, distinguish duplicates, and contain no ticket tokens', () => {
  applyOptions({})
  const loops = CASES.map((c, i) => loop(c.raw, i))
  expect(subjectsOf(loops, [], NOW).map(s => s.name)).toEqual(CASES.map(c => c.title))
  const frames = insightFrames(loops, [], NOW)
  expect(frames.map(f => f.id)).toEqual([...INSIGHT_FRAME_IDS])
  const time = frames.find(f => f.id === TIME_FRAME_IDS.BY_KIND)
  const repeats = frames.find(f => f.id === REPEAT_FRAME_ID)
  if (time?.type !== 'kindstack' || repeats?.type !== 'repeats') throw new Error('Missing insight frames')
  expect(time.items.map(i => i.label)).toEqual(CASES.map(c => c.title))
  expect(repeats.cols).toEqual(CASES.map(c => c.title))
  for (const frame of frames) expect(validateFrame(frame)).toEqual(frame)
  assertNoIds(frames)
})

test('frame labels use available space and word boundaries, including collisions caused by the cap', () => {
  const loops = [LONG_TITLE, OTHER_LONG_TITLE].map(loop)
  const frames = insightFrames(loops, [], NOW)
  const time = frames.find(f => f.id === TIME_FRAME_IDS.BY_KIND)
  const repeats = frames.find(f => f.id === REPEAT_FRAME_ID)
  if (time?.type !== 'kindstack' || repeats?.type !== 'repeats') throw new Error('Missing insight frames')
  const labels = time.items.map(i => i.label)
  expect(labels).toEqual([EXPECTED_CLIP, CLIPPED_DUPLICATE])
  expect(repeats.cols).toEqual(labels)
  expect(new Set(labels).size).toBe(DUPLICATE_COUNT)
  for (const label of labels) expect(label.length).toBeLessThanOrEqual(FRAME_CAPS.INSIGHT_LABEL_CHARS)
  expect(clipTitle(CASES[0].title, FRAME_CAPS.INSIGHT_LABEL_CHARS)).toBe(CASES[0].title)
  assertNoIds(frames)
})

test('plain title helper handles ids and preserves titles without an id', () => {
  expect(plainTitle(CASES[0].raw)).toBe(CASES[0].title)
  expect(plainTitle(CASES[1].raw)).toBe(CASES[1].title)
  expect(plainTitle(CASES[3].raw)).toBe(CASES[3].title)
  const naturallyNumbered = `${CASES[0].title} 2`
  const titles = uniqueTitles([CASES[0].title, CASES[0].title, naturallyNumbered], FRAME_CAPS.INSIGHT_LABEL_CHARS)
  expect(new Set(titles).size).toBe(titles.length)
})

test('repeat labels are clean even for loops with no measurable spans', () => {
  const loops = CASES.map((c, i) => ({ ...loop(c.raw, i), spans: [] }))
  const frames = insightFrames(loops, [], NOW)
  const repeats = frames.find(f => f.id === REPEAT_FRAME_ID)
  if (repeats?.type !== 'repeats') throw new Error('Missing repeats frame')
  expect(repeats.cols).toEqual(CASES.map(c => c.title))
  assertNoIds(frames)
})

test('router task labels also reuse plain titles, with distinguishable collisions', () => {
  const tickets = CASES.map((c, i) => parseTicket({ id: `work-${i}`, title: c.raw, status: 'ready' }, `work-${i}`))
  const frames = routerFrames(buildRun(tickets, []), NOW)
  const frame = frames.find(f => f.id === ROUTER_FRAME.TICKETS_ID)
  if (frame?.type !== 'tickets') throw new Error('Missing tickets frame')
  expect(frame.items.map(i => i.title)).toEqual(CASES.map(c => c.title))
  for (const built of frames) expect(validateFrame(built)).toEqual(built)
  assertNoIds(frames)
})
