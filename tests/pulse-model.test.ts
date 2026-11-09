// The Pulse's pure parts: what may be remembered about a tool call (privacy), the model with its event ring, the
// snapshot file and reading it back, the lane rules, the writer's rhythm. (The built-in scene contract: board-scene.test.ts.)
import { expect, test } from 'claude-code/testing'

import { applyLanePlan, hasLanePart, laneLine, LANE_CAPS, matchLane, planLanes, slug } from '../hooks/pulse-lanes'
import type { Lane, LanePlan } from '../hooks/pulse-lanes'
import { COOLDOWN_MS, createFlusher, LEAD_MS, writeAtomic } from '../hooks/pulse-flush'
import {
  beginCall,
  endCall,
  loopFor,
  MAIN_LOOP,
  newModel,
  PULSE_CAPS,
  restore,
  restoreLanes,
  snapshot,
  spawnLoop,
  syncAgents,
  turnEnd,
  turnStart,
} from '../hooks/pulse-model'
import { applyOptions } from '../hooks/panel-config'
import { baseName, firstWord, hostName, INTENT_CHARS, intentOf, isFileTouch, targetOf, TARGET_CHARS } from '../hooks/pulse-redact'
import { parsePulseArgs, PULSE_USAGE } from '../hooks/pulse-host'

const NOW = 1_767_000_000_000
const SETTLE_TICKS = 8 // microtask turns a rejected write needs to reach onError

// ---- privacy -------------------------------------------------------------------------------------------------

test('privacy table: only a tool name and a short target survive', () => {
  const table: [string, Record<string, unknown>, string][] = [
    ['Bash', { command: 'git push --force origin main' }, 'git'],
    ['Bash', { command: 'API_KEY=hunter2 /usr/local/bin/curl -H "Authorization: Bearer abc" https://x.io/a?token=1' }, 'curl'],
    ['Bash', { command: '  (cd /secret && rm -rf .)' }, 'cd'],
    ['Bash', { command: '"$(cat ~/.ssh/id_rsa)"' }, ''],
    ['Bash', { command: '' }, ''],
    ['Bash', { command: 42 }, ''],
    ['Read', { file_path: '/Users/x/secret/key.pem' }, 'key.pem'],
    ['Edit', { file_path: '/Users/x/proj/src/app.ts', old_string: 'password = "hunter2"', new_string: 'x' }, 'app.ts'],
    ['Write', { file_path: 'C:\\Users\\x\\notes.txt', content: 'SECRET' }, 'notes.txt'],
    ['NotebookEdit', { notebook_path: '/n/analysis.ipynb', new_source: 'SECRET' }, 'analysis.ipynb'],
    ['Grep', { pattern: 'AKIA[0-9A-Z]{16}', path: '/Users/x/proj/src' }, 'src'],
    ['Glob', { pattern: '**/*.env' }, ''],
    ['Read', { file_path: '/Users/x/secret/' }, 'secret'],
    ['WebFetch', { url: 'https://user:pw@docs.example.com:8443/private/page?token=abc#frag', prompt: 'SECRET' }, 'docs.example.com'],
    ['WebFetch', { url: 'http://[::1]:3000/admin' }, '[::1]'],
    ['WebFetch', { url: 'not a url' }, ''],
    ['WebSearch', { query: 'how do I hide my api key' }, '24 chars'],
    ['WebSearch', { query: '' }, '0 chars'],
    ['Task', { prompt: 'SECRET', description: 'SECRET' }, ''],
    ['mcp__x__y', { anything: '/Users/x/secret' }, ''],
  ]
  for (const [tool, input, target] of table) expect(targetOf(tool, input)).toBe(target)
  expect(baseName('/a/b/c.txt')).toBe('c.txt')
  expect(baseName(undefined)).toBe('')
  expect(firstWord('FOO=1 BAR=2 ls -la')).toBe('ls')
  // workers write `cd <dir> && real-command`: the target is the first word of the real command, never an argument
  const bash: [string, string][] = [
    ['cd /a/b && node x.mjs', 'node'],
    ['cd /a; git push --force', 'git'],
    ['cd /a || claude plugin test .', 'claude'],
    ['cd "/a b/c" && python3 run.py --token SECRET', 'python3'],
    ['cd /a && cd /b && pkill -f server', 'pkill'],
    ['FOO=1 bun test', 'bun'],
    ['cd /a && FOO=secret /usr/bin/env-tool x', 'env-tool'],
    ['cd /a', 'cd'],
    ['cd', 'cd'],
    ['cd /a &&', 'cd'],
    ['cd /a&&node x.mjs', 'node'],
  ]
  for (const [command, word] of bash) expect(firstWord(command), command).toBe(word)
  expect(hostName('HTTPS://Example.COM/x')).toBe('example.com')
  expect(isFileTouch('Edit')).toBe(true)
  expect(isFileTouch('Grep')).toBe(false)
})

test('a target is short and has no control characters', () => {
  const long = `/p/${'x'.repeat(200)}.ts`
  expect(targetOf('Read', { file_path: long }).length).toBeLessThanOrEqual(TARGET_CHARS)
  expect(targetOf('Read', { file_path: '/p/a\nb\u0007c.ts' })).toBe('abc.ts')
})

test('what reaches the snapshot never holds a prompt, an output, a path, a command line or a url', () => {
  const m = newModel(NOW)
  const calls: [string, Record<string, unknown>][] = [
    ['Bash', { command: 'git push --force origin main', description: 'SECRET-PROMPT' }],
    ['Read', { file_path: '/Users/x/secret/key.pem' }],
    ['WebFetch', { url: 'https://docs.example.com/private?token=SECRET-QUERY' }],
    ['WebSearch', { query: 'SECRET-SEARCH' }],
    ['Edit', { file_path: '/Users/x/secret/app.ts', old_string: 'SECRET-CONTENT', new_string: 'SECRET-CONTENT' }],
  ]
  calls.forEach(([tool, input], i) => beginCall(m, NOW + i, MAIN_LOOP, tool, targetOf(tool, input)))
  spawnLoop(m, NOW + 9, { id: 'a1', label: 'T25 pulse', parent: MAIN_LOOP })
  const text = JSON.stringify(snapshot(m, NOW + 10))
  for (const secret of ['SECRET', '/Users', 'push', '--force', 'token', '/private', 'origin']) expect(text).not.toContain(secret)
  expect(text).toContain('key.pem')
  expect(text).toContain('docs.example.com')
  expect(text).toContain('13 chars')
})

// ---- the model -----------------------------------------------------------------------------------------------

test('the ring keeps the last 200 events; the file carries the last 60', () => {
  const m = newModel(NOW)
  for (let i = 0; i < PULSE_CAPS.RING_EVENTS + 50; i++) beginCall(m, NOW + i, MAIN_LOOP, 'Read', `f${i}.ts`)
  expect(m.ring).toHaveLength(PULSE_CAPS.RING_EVENTS)
  expect(m.ring[0]?.target).toBe('f50.ts')
  const snap = snapshot(m, NOW + 1000)
  expect(snap.events).toHaveLength(PULSE_CAPS.OUT_EVENTS)
  expect(snap.events.at(-1)?.target).toBe(`f${PULSE_CAPS.RING_EVENTS + 49}.ts`)
  expect(snap.totals.calls).toBe(PULSE_CAPS.RING_EVENTS + 50)
})

test('a loop keeps its tool counts, last tool and target, and up to 12 touched file basenames, newest first', () => {
  const m = newModel(NOW)
  for (let i = 0; i < 20; i++) beginCall(m, NOW + i, MAIN_LOOP, 'Read', `f${i}.ts`)
  beginCall(m, NOW + 30, MAIN_LOOP, 'Edit', 'f5.ts')
  beginCall(m, NOW + 31, MAIN_LOOP, 'Bash', 'git')
  const main = m.loops.get(MAIN_LOOP)
  expect(main?.files).toHaveLength(PULSE_CAPS.RECENT_FILES)
  expect(main?.files[0]).toBe('f5.ts')
  expect(main?.files.filter(f => f === 'f5.ts')).toHaveLength(1)
  expect(main?.counts).toEqual({ Read: 20, Edit: 1, Bash: 1 })
  expect(main?.lastTool).toBe('Bash')
  expect(main?.lastTarget).toBe('git')
  expect(m.files.size).toBe(20)
  expect(snapshot(m, NOW + 40).totals.files).toBe(20)
})

test('a call from an agent that was never seen makes it a loop; the spawn names it; the list refreshes it', () => {
  const m = newModel(NOW)
  beginCall(m, NOW, 'agent-77', 'Read', 'a.ts')
  expect(m.loops.get('agent-77')).toMatchObject({ kind: 'subagent', status: 'running', parent: MAIN_LOOP, label: 'Agent · read' })
  spawnLoop(m, NOW + 1, { id: 'agent-77', label: 'T25 pulse and lanes', parent: MAIN_LOOP })
  expect(m.loops.get('agent-77')?.label).toBe('T25 pulse and lanes')
  expect(m.ring.at(-1)).toMatchObject({ loop: MAIN_LOOP, tool: 'spawn', target: 'agent-77' })
  syncAgents(m, NOW + 2, [
    { id: 'agent-77', description: 'T25 pulse', type: 'general-purpose', status: 'completed' },
    { id: 'agent-88', description: '', name: 'reviewer', type: 'Explore', status: 'running', parentId: 'agent-77' },
  ])
  expect(m.loops.get('agent-77')).toMatchObject({ label: 'T25 pulse', status: 'done' })
  expect(m.loops.get('agent-88')).toMatchObject({ label: 'reviewer', name: 'reviewer', status: 'running', parent: 'agent-77' })
  expect(snapshot(m, NOW + 3).totals).toMatchObject({ agents: 2, active: 1 })
})

test('turns: the main loop goes idle, an agent is done, a teammate waits; a failed call is marked', () => {
  const m = newModel(NOW)
  turnStart(m, NOW + 1, MAIN_LOOP)
  expect(snapshot(m, NOW + 2).session).toMatchObject({ turn: 'running', turnStartedAt: NOW + 1 })
  const ev = beginCall(m, NOW + 3, 'a1', 'Bash', 'npm')
  expect(m.loops.get('a1')?.busy).toBe(1)
  endCall(m, NOW + 4, 'a1', ev, true)
  expect(ev.err).toBe(true)
  expect(m.loops.get('a1')?.busy).toBe(0)
  turnEnd(m, NOW + 5, 'a1')
  expect(m.loops.get('a1')?.status).toBe('done')
  spawnLoop(m, NOW + 6, { id: 'tm', label: 'mate', isTeammate: true })
  turnEnd(m, NOW + 7, 'tm')
  expect(m.loops.get('tm')?.status).toBe('idle')
  turnEnd(m, NOW + 8, MAIN_LOOP)
  expect(snapshot(m, NOW + 9).session.turn).toBe('idle')
  expect(m.loops.get(MAIN_LOOP)?.status).toBe('idle')
})

test('at most 24 loops: a finished one makes room, main never goes', () => {
  const m = newModel(NOW)
  for (let i = 0; i < PULSE_CAPS.LOOPS + 5; i++) {
    beginCall(m, NOW + i, `agent-${i}`, 'Read', 'a.ts')
    turnEnd(m, NOW + i, `agent-${i}`)
  }
  expect(m.loops.size).toBeLessThanOrEqual(PULSE_CAPS.LOOPS + 1)
  expect(m.loops.has(MAIN_LOOP)).toBe(true)
  expect(loopFor(m, 'agent-new', NOW).id).toBe('agent-new')
})

test('the snapshot reads back after a reload, and a file that is not ours is refused', () => {
  const m = newModel(NOW)
  turnStart(m, NOW + 1, MAIN_LOOP)
  beginCall(m, NOW + 2, MAIN_LOOP, 'Edit', 'a.ts')
  spawnLoop(m, NOW + 3, { id: 'a1', label: 'T25', parent: MAIN_LOOP })
  beginCall(m, NOW + 4, 'a1', 'Read', 'b.ts')
  m.lanes = [{ id: 't25', label: 'T25', state: 'working', pct: 40, step: 'x', note: '', goal: '', dod: [], at: null, startedAt: NOW, updatedAt: NOW, by: 'a1' }]
  const text = JSON.stringify(snapshot(m, NOW + 5))
  const again = newModel(NOW + 100)
  expect(restore(again, JSON.parse(text))).toBe(true)
  expect(again.loops.get('a1')).toMatchObject({ label: 'T25', calls: 1, files: ['b.ts'] })
  expect(again.ring.map(e => e.tool)).toEqual(['Edit', 'spawn', 'Read'])
  expect(again.lanes[0]).toMatchObject({ id: 't25', pct: 40 })
  expect(again.turn.state).toBe('running')
  const hostile = JSON.parse(text) as { loops: { files: unknown[]; id: string }[] }
  hostile.loops[0]!.files = ['/etc/passwd'.repeat(50), 7, null]
  hostile.loops.push({ id: 5 } as never, null as never)
  const fresh = newModel(NOW)
  expect(restore(fresh, hostile)).toBe(true)
  expect(fresh.loops.get(MAIN_LOOP)?.files.every(f => f.length <= PULSE_CAPS.NAME_CHARS)).toBe(true)
  for (const junk of [null, 3, 'x', {}, { v: 2, loops: [] }, { v: 1 }]) expect(restore(newModel(NOW), junk)).toBe(false)
})

// ---- lanes ---------------------------------------------------------------------------------------------------

const plan = (lane: unknown, extra: Record<string, unknown> = {}): LanePlan => {
  const planned = planLanes({ ...extra, lane })
  if (!planned.isOk) throw new Error(planned.error)
  return planned.plan
}
const refused = (input: Record<string, unknown>): string => {
  const planned = planLanes(input)
  return planned.isOk ? 'ok' : planned.error
}
const apply = (prev: Lane[], p: LanePlan, now = NOW, by = 'a1') => {
  const r = applyLanePlan(prev, p, now, by)
  if (!r.isOk) throw new Error(r.error)
  return r
}

test('lane session: a Claude Code session id, validated with the field named, kept by later posts, survives a restore', () => {
  const id = '0b1c2d3e-4f50-6789-abcd-ef0123456789'
  const first = apply([], plan({ id: 'sib', session: id })).lanes
  expect(first[0]).toMatchObject({ id: 'sib', session: id })
  expect(apply(first, plan({ id: 'sib', pct: 5 })).lanes[0]).toMatchObject({ session: id })
  expect(apply([], plan({ id: 'plain' })).lanes[0]!.session).toBeUndefined()
  expect(refused({ lane: { id: 'sib', session: '../etc/passwd' } })).toMatch(/lane\.session .* is invalid/)
  expect(refused({ lane: { id: 'sib', session: 5 } })).toMatch(/lane\.session .* is invalid/)
  expect(refused({ lane: { id: 'sib', session: 'a'.repeat(65) } })).toMatch(/lane\.session .* is invalid/)
  expect(restoreLanes(JSON.parse(JSON.stringify(first)))[0]).toMatchObject({ session: id })
  expect(restoreLanes([{ id: 'sib', session: '../x' }])[0]!.session).toBeUndefined()
})

test('lane goal, dod and at: validated with the field named, upsert-only, dod replaces the list, at follows it', () => {
  const dod = [{ t: 'frames', state: 'done' }, { t: 'tests', state: 'todo' }]
  const first = apply([], plan({ id: 't30', goal: 'Board in the mod', dod, at: 1 })).lanes
  expect(first[0]).toMatchObject({ goal: 'Board in the mod', dod, at: 1 })
  const bumped = apply(first, plan({ id: 't30', pct: 50 })).lanes // a later post without them keeps them
  expect(bumped[0]).toMatchObject({ goal: 'Board in the mod', dod, at: 1, pct: 50 })
  expect(apply(bumped, plan({ id: 't30', dod: [{ t: 'one', state: 'doing' }] })).lanes[0]).toMatchObject({ dod: [{ t: 'one', state: 'doing' }], at: null }) // a new list: its own index
  expect(apply(bumped, plan({ id: 't30', dod: [] })).lanes[0]).toMatchObject({ dod: [], at: null })
  expect(refused({ lane: { id: 't30', dod: 'x' } })).toMatch(/lane\.dod must be an array/)
  expect(refused({ lane: { id: 't30', dod: Array.from({ length: 7 }, () => ({ t: 'x', state: 'todo' })) } })).toMatch(/lane\.dod has 7 items; the limit is 6/)
  expect(refused({ lane: { id: 't30', dod: [{ t: 'x', state: 'skipped' }] } })).toMatch(/lane\.dod\[0\]\.state "skipped" must be one of todo, doing, done, failed/)
  expect(refused({ lane: { id: 't30', dod: [{ t: '', state: 'todo' }] } })).toMatch(/lane\.dod\[0\]\.t must not be empty/)
  expect(refused({ lane: { id: 't30', dod: [{ t: 'x', state: 'todo', why: 1 }] } })).toMatch(/lane\.dod\[0\]\.why is not a known field/)
  expect(refused({ lane: { id: 't30', dod, at: 2 } })).toMatch(/lane\.at 2 is past the end of lane\.dod \(2 items\)/)
  expect(refused({ lane: { id: 't30', at: -1 } })).toMatch(/lane\.at -1 must be a whole number/)
  expect(refused({ lane: { id: 't30', goal: 5 } })).toMatch(/lane\.goal must be a string/)
  const long = plan({ id: 't30', goal: 'g'.repeat(100), dod: [{ t: 'x'.repeat(60), state: 'todo' }] })
  expect(long.trimmed).toEqual(['lane.goal to 40 chars', 'lane.dod[0].t to 48 chars'])
})

test('intentOf: the Ticket line and the first sentence of the goal, never the rest of the prompt', () => {
  const table: [unknown, string][] = [
    ['Ticket: T30 (P0)\nGoal: Board in the mod. Then SECRET-BODY.\n\nSECRET-BODY', 'T30 (P0) · Board in the mod.'],
    ['# Brief\n**Ticket:** T30\n\n## Goal\nShip the board.  More text here.', 'T30 · Ship the board.'],
    ['Ticket - T7\nObjective: Fix uploads', 'T7 · Fix uploads'],
    ['Fix the retry storm in upload() without new infra. Then more.', 'Fix the retry storm in upload() without new infra.'],
    ['Ticket: T9', 'T9'],
    ['Priority:\nTicket: T1\nDo the thing', 'T1 · Do the thing'],
    ['', ''],
    [undefined, ''],
    [42, ''],
    // real prompts: a context sentence with a path is never the goal
    ['Ticket: T33\nYou work on the "panel" mod at MOD=/Users/a/.claude/dev-mods/00000000/panel (edit it in place; ok). Read the spec. PROBLEM (user feedback): the terminal pane shows ONE main frame. Fix it.', 'T33 · the terminal pane shows ONE main frame.'],
    ['Ticket: T34\nYou polish the Board scene of the "panel" mod: MOD=/Users/a/x ONLY under web/builtin/board/** and nothing else.\nMake each agent row readable at a glance. More.', 'T34 · Make each agent row readable at a glance.'],
    ['Ticket: T35\nGoal: Show the real goal on the row. Then more.\nYou work on the "panel" mod at MOD=/Users/a/x.', 'T35 · Show the real goal on the row.'],
    ['Ticket: T36\nYou work on the mod at MOD=/Users/a/b/c (in place).', 'T36'],
    ['Goal: Fix the bug in ~/src/app/x.ts and MOD=/Users/a/b now.', 'Fix the bug in and now.'],
  ]
  for (const [prompt, intent] of table) expect(intentOf(prompt), String(prompt)).toBe(intent)
  expect(intentOf(`Ticket: ${'T'.repeat(80)}\nGoal: ${'g'.repeat(300)}`).length).toBeLessThanOrEqual(INTENT_CHARS)
  expect(intentOf('Goal: line one\u0007\nmore')).toBe('line one')
})

test('lane validation names the field and says what is allowed', () => {
  expect(refused({ lane: { id: 'T25' } })).toMatch(/^panel: lane\.id "T25" is invalid: use 1-24 characters from a-z, 0-9 and "-"/)
  expect(refused({ lane: { id: 'x'.repeat(25) } })).toMatch(/lane\.id/)
  expect(refused({ lane: {} })).toMatch(/lane\.id undefined is invalid/)
  expect(refused({ lane: { id: 't25', state: 'busy' } })).toMatch(/lane\.state "busy" must be one of working, testing, waiting, blocked, done/)
  expect(refused({ lane: { id: 't25', pct: 101 } })).toMatch(/lane\.pct 101 must be a number from 0 to 100/)
  expect(refused({ lane: { id: 't25', pct: -1 } })).toMatch(/lane\.pct -1/)
  expect(refused({ lane: { id: 't25', pct: '50' } })).toMatch(/lane\.pct "50"/)
  expect(refused({ lane: { id: 't25', pct: Number.NaN } })).toMatch(/lane\.pct/)
  expect(refused({ lane: { id: 't25', colour: 'red' } })).toMatch(/^panel: lane\.colour is not a known field \(allowed: id, label, state, pct, step, note, goal, dod, at, session\)/)
  expect(refused({ lane: 'nope' })).toMatch(/lane must be an object/)
  expect(refused({ lane: [] })).toMatch(/lane must be an object/)
  expect(refused({ lane_remove: 'Bad Id' })).toMatch(/lane_remove "Bad Id" is invalid/)
  expect(refused({ lane: { id: 't25', label: 7 } })).toMatch(/lane\.label/)
})

test('lane text is trimmed to its limit and reported; the percentage is rounded', () => {
  const p = plan({ id: 't25', label: 'l'.repeat(80), step: 's'.repeat(100), note: 'n'.repeat(150), pct: 33.6 })
  expect(p.upsert?.label).toHaveLength(LANE_CAPS.LABEL_CHARS)
  expect(p.upsert?.step).toHaveLength(LANE_CAPS.STEP_CHARS)
  expect(p.upsert?.note).toHaveLength(LANE_CAPS.NOTE_CHARS)
  expect(p.upsert?.pct).toBe(34)
  expect(p.trimmed).toHaveLength(3)
})

test('a lane call is an upsert: unsent fields keep their value, done fills the bar, a result line says where it stands', () => {
  const first = apply([], plan({ id: 't25', label: 'T25 pulse', state: 'working', pct: 40, step: 'writing' }))
  expect(first.lines).toEqual(['lane t25 · working 40%'])
  const second = apply(first.lanes, plan({ id: 't25', step: 'testing it', state: 'testing' }), NOW + 5)
  expect(second.lanes).toHaveLength(1)
  expect(second.lanes[0]).toMatchObject({ label: 'T25 pulse', pct: 40, state: 'testing', step: 'testing it', startedAt: NOW, updatedAt: NOW + 5 })
  const done = apply(second.lanes, plan({ id: 't25', state: 'done' }), NOW + 9)
  expect(done.lanes[0]).toMatchObject({ pct: 100, state: 'done' })
  expect(done.lines).toEqual(['lane t25 · done 100%'])
  expect(apply([], plan({ id: 'x' })).lines).toEqual(['lane x · working'])
  expect(apply([], plan({ id: 'x' })).lanes[0]?.label).toBe('x')
  expect(laneLine({ ...done.lanes[0]!, pct: null })).toBe('lane t25 · done')
  // other panel parts ride along untouched
  const mixed = plan({ id: 'a' }, { status: 'working', context: ['k'] })
  expect(mixed.rest).toEqual({ status: 'working', context: ['k'] })
  expect(hasLanePart(mixed)).toBe(true)
  expect(hasLanePart(plan(undefined))).toBe(false)
})

test('lane_remove removes; a lane that is not there is said so and nothing breaks', () => {
  const one = apply([], plan({ id: 'a' })).lanes
  const gone = apply(one, planLanes({ lane_remove: 'a' }).isOk ? (planLanes({ lane_remove: 'a' }) as { plan: LanePlan }).plan : ({} as LanePlan))
  expect(gone.lanes).toEqual([])
  expect(gone.lines).toEqual(['lane a removed'])
  const missing = apply(one, (planLanes({ lane_remove: 'zzz' }) as { plan: LanePlan }).plan)
  expect(missing.lanes).toHaveLength(1)
  expect(missing.lines[0]).toBe('no lane "zzz" to remove; lanes: a')
})

test('12 lanes at most: the oldest done lane makes room; with all 12 active the call is refused and names them', () => {
  let lanes: Lane[] = []
  for (let i = 0; i < LANE_CAPS.LANES; i++) lanes = apply(lanes, plan({ id: `l${i}` }), NOW + i).lanes
  expect(lanes).toHaveLength(12)
  const full = applyLanePlan(lanes, plan({ id: 'extra' }), NOW + 50, 'a1')
  expect(full.isOk).toBe(false)
  expect(full.isOk === false && full.error).toMatch(/^panel: lane: already 12 active lanes \(l0, l1, .*l11\): finish one \(state "done"\) or remove it with lane_remove before adding "extra"$/)
  // update of an existing one still works when full
  expect(apply(lanes, plan({ id: 'l3', pct: 5 }), NOW + 60).lanes).toHaveLength(12)
  // two are done: the OLDEST done one goes
  lanes = apply(lanes, plan({ id: 'l7', state: 'done' }), NOW + 70).lanes
  lanes = apply(lanes, plan({ id: 'l2', state: 'done' }), NOW + 80).lanes
  const made = apply(lanes, plan({ id: 'extra' }), NOW + 90)
  expect(made.lanes.map(l => l.id)).not.toContain('l7')
  expect(made.lanes.map(l => l.id)).toContain('l2')
  expect(made.lanes.map(l => l.id)).toContain('extra')
  expect(made.lanes).toHaveLength(12)
})

test('a lane finds its node by id, by name, by label, or by who posted it; else it stands free', () => {
  const lane = (id: string, label: string, by: string): Lane => ({ id, label, state: 'working', pct: null, step: '', note: '', goal: '', dod: [], at: null, startedAt: 0, updatedAt: 0, by })
  const loops = [
    { id: MAIN_LOOP, label: 'main' },
    { id: 'a1', label: 'T25 Ambient pulse' },
    { id: 'a2', label: 'desk research', name: 'Scout' },
  ]
  expect(slug('T25 Ambient pulse!')).toBe('t25-ambient-pulse')
  expect(matchLane(lane('a2', '', MAIN_LOOP), loops, MAIN_LOOP)).toBe('a2')
  expect(matchLane(lane('scout', '', MAIN_LOOP), loops, MAIN_LOOP)).toBe('a2')
  expect(matchLane(lane('desk-research', '', MAIN_LOOP), loops, MAIN_LOOP)).toBe('a2')
  expect(matchLane(lane('t25', 'whatever', MAIN_LOOP), loops, MAIN_LOOP)).toBe('a1')
  expect(matchLane(lane('zzz', 'T25 Ambient pulse', MAIN_LOOP), loops, MAIN_LOOP)).toBe('a1')
  expect(matchLane(lane('zzz', 'other', 'a2'), loops, MAIN_LOOP)).toBe('a2')
  expect(matchLane(lane('zzz', 'other', MAIN_LOOP), loops, MAIN_LOOP)).toBeNull()
})

// ---- the writer ----------------------------------------------------------------------------------------------

/** A clock to drive by hand: `after` timers fire when `advance` passes them. */
function fakeTime() {
  const box = { now: 0, timers: [] as { at: number; fn: () => void; isOff: boolean }[] }
  return {
    after: (ms: number, fn: () => void) => {
      const t = { at: box.now + ms, fn, isOff: false }
      box.timers.push(t)
      return { cancel: () => void (t.isOff = true) }
    },
    advance: async (ms: number) => {
      const end = box.now + ms
      for (;;) {
        const due = box.timers.filter(t => !t.isOff && t.at <= end).sort((a, b) => a.at - b.at)[0]
        if (due === undefined) break
        box.now = due.at
        due.isOff = true
        due.fn()
        for (let i = 0; i < SETTLE_TICKS; i++) await Promise.resolve()
      }
      box.now = end
    },
    pending: () => box.timers.filter(t => !t.isOff).length,
  }
}

test('a burst of events is one write; a steady stream is at most two writes a second; it stops when nothing changed', async () => {
  const time = fakeTime()
  let writes = 0
  const f = createFlusher({ after: time.after, run: async () => void writes++, onError: () => {} })
  for (let i = 0; i < 100; i++) f.touch()
  expect(writes).toBe(0)
  await time.advance(LEAD_MS)
  expect(writes).toBe(1)
  for (let i = 0; i < 100; i++) f.touch()
  await time.advance(COOLDOWN_MS - 1)
  expect(writes).toBe(1)
  await time.advance(1)
  expect(writes).toBe(2)
  // nothing touched: nothing is written, however long we wait
  await time.advance(10_000)
  expect(writes).toBe(2)
  expect(time.pending()).toBe(0)
  // steady stream: a touch every 10 ms for 5 s
  const before = writes
  for (let ms = 0; ms < 5000; ms += 10) {
    f.touch()
    await time.advance(10)
  }
  const perSecond = (writes - before) / 5
  expect(perSecond).toBeLessThanOrEqual(2)
  expect(perSecond).toBeGreaterThan(1.5)
})

test('flushNow writes at once when something changed, and not when nothing did; dispose stops everything', async () => {
  const time = fakeTime()
  let writes = 0
  const f = createFlusher({ after: time.after, run: async () => void writes++, onError: () => {} })
  await f.flushNow()
  expect(writes).toBe(0)
  f.touch()
  await f.flushNow()
  expect(writes).toBe(1)
  f.touch()
  f.dispose()
  await time.advance(5000)
  expect(writes).toBe(1)
  f.touch()
  await f.flushNow()
  expect(writes).toBe(1)
})

test('a failing write is reported, never thrown, and the next one still happens', async () => {
  const time = fakeTime()
  const errors: unknown[] = []
  let calls = 0
  const f = createFlusher({
    after: time.after,
    run: async () => {
      if (++calls === 1) throw new Error('disk full')
    },
    onError: e => errors.push(e),
  })
  f.touch()
  await time.advance(LEAD_MS)
  expect(errors).toHaveLength(1)
  f.touch()
  await time.advance(COOLDOWN_MS)
  expect(calls).toBe(2)
})

test('the file is replaced atomically: temp first, then a move; if the move fails the text still lands', async () => {
  const steps: string[] = []
  await writeAtomic({ write: async (p, t) => void steps.push(`write ${p} ${t}`), move: async (a, b) => (steps.push(`move ${a} ${b}`), true) }, '/d/live/pulse.json', '/d/live/.pulse.json.tmp', '{}')
  expect(steps).toEqual(['write /d/live/.pulse.json.tmp {}', 'move /d/live/.pulse.json.tmp /d/live/pulse.json'])
  const fallback: string[] = []
  await writeAtomic({ write: async (p, t) => void fallback.push(`write ${p} ${t}`), move: async () => false }, '/d/live/pulse.json', '/d/live/.t', '{"a":1}')
  expect(fallback).toEqual(['write /d/live/.t {"a":1}', 'write /d/live/pulse.json {"a":1}'])
})

test('/panel pulse parses on, off, status and refuses other words', () => {
  expect(parsePulseArgs('pulse')).toEqual({ verb: 'status' })
  expect(parsePulseArgs('pulse status')).toEqual({ verb: 'status' })
  expect(parsePulseArgs('  pulse   on ')).toEqual({ verb: 'on' })
  expect(parsePulseArgs('pulse off')).toEqual({ verb: 'off' })
  expect(parsePulseArgs('pulse maybe')).toEqual({ usage: PULSE_USAGE })
  expect(parsePulseArgs('')).toBeUndefined()
  expect(parsePulseArgs('open')).toBeUndefined()
  expect(parsePulseArgs('live on')).toBeUndefined()
})

test('intentOf: goal and ticket labels come from the options; "you polish" is no longer a context opener', () => {
  expect(intentOf('Mission here\nGoal: ship it')).toBe('ship it')
  applyOptions({ goalLabels: 'aim', ticketLabels: 'issue' })
  expect(intentOf('Issue: T9\nAim: ship it. Then more.')).toBe('T9 · ship it.')
  expect(intentOf('Ticket: T9\nGoal: ignored')).not.toContain('ignored')
  applyOptions({})
  expect(intentOf('You polish the board. Then more.')).toBe('You polish the board.')
})

test('the subagent type is kept from the spawn and the list, and read back after a reload', () => {
  const m = newModel(NOW)
  spawnLoop(m, NOW + 1, { id: 'w1', label: 'Worker 01-slugify', type: 'worker', parent: MAIN_LOOP })
  spawnLoop(m, NOW + 1, { id: 'a2', label: 'Plain', parent: MAIN_LOOP })
  expect(m.loops.get('w1')?.type).toBe('worker')
  expect(m.loops.get('a2')?.type).toBeUndefined()
  syncAgents(m, NOW + 2, [{ id: 'a2', description: 'Plain', type: 'Explore', status: 'running' }, { id: 'a3', description: '', type: '', status: 'running' }])
  expect(m.loops.get('a2')?.type).toBe('Explore')
  expect(m.loops.get('a3')?.type).toBeUndefined()
  const again = newModel(NOW + 100)
  expect(restore(again, JSON.parse(JSON.stringify(snapshot(m, NOW + 3))))).toBe(true)
  expect(again.loops.get('w1')?.type).toBe('worker')
  expect(again.loops.get('a3')?.type).toBeUndefined()
})
