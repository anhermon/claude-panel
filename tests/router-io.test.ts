// The `$.fs` reader of `.router/` with a pretend disk: absent folder, bounded reads, and no re-read while nothing changed.
import { expect, test } from 'claude-code/testing'
import type { EngineInterface } from 'claude-code'

import { readRouter, ROUTER_IO } from '../hooks/router-io'
import { EVAL_FILES, EVENT_LINES, TICKET_FILES, VERDICT_FILES } from './router-fixture'

const CWD = '/work/proj'
const ROOT = `${CWD}/.router`

type Disk = Map<string, string>
/** A pretend `$` over a map of path -> text (a folder exists when a path starts with it); counts reads and tail runs. */
function pretend(disk: Disk) {
  const reads: string[] = []
  const runs: string[][] = []
  const hasDir = (p: string): boolean => [...disk.keys()].some(k => k.startsWith(`${p}/`))
  const $ = {
    fs: {
      list: async (p: string) => {
        if (!hasDir(p)) throw new Error('ENOENT')
        const names = new Set([...disk.keys()].filter(k => k.startsWith(`${p}/`)).map(k => k.slice(p.length + 1).split('/')[0]!))
        return [...names].map(name => ({ name, kind: disk.has(`${p}/${name}`) ? 'file' : 'dir', size: 0, mtimeMs: 0, isLink: false }))
      },
      stat: async (p: string) => {
        const text = disk.get(p)
        if (text === undefined) throw new Error('ENOENT')
        return { kind: 'file', size: text.length, mtimeMs: 1, isLink: false }
      },
      read: async (p: string) => {
        reads.push(p)
        const text = disk.get(p)
        if (text === undefined) throw new Error('ENOENT')
        return text
      },
    },
    process: {
      run: async (argv: string[]) => {
        runs.push(argv)
        return { exitCode: 0, stdout: [...disk.entries()].find(([k]) => k === argv.at(-1))?.[1].slice(-ROUTER_IO.TAIL_BYTES) ?? '', stderr: '' }
      },
    },
  } as unknown as EngineInterface
  return { $, reads, runs }
}
const fullDisk = (): Disk => {
  const disk: Disk = new Map(Object.entries(TICKET_FILES).map(([name, raw]) => [`${ROOT}/tickets/${name}/ticket.json`, JSON.stringify(raw)]))
  for (const [name, text] of Object.entries(EVAL_FILES)) disk.set(`${ROOT}/tickets/${name}/eval.md`, text)
  for (const [name, text] of Object.entries(VERDICT_FILES)) disk.set(`${ROOT}/tickets/${name}/verdict.md`, text)
  disk.set(`${ROOT}/events.jsonl`, EVENT_LINES.join('\n') + '\n')
  return disk
}

test('no `.router/` gives undefined: nothing to show, nothing thrown', async () => {
  const { $, reads } = pretend(new Map([['/work/proj/src/a.ts', 'x']]))
  expect((await readRouter($, CWD)).run).toBeUndefined()
  expect(reads).toEqual([])
})

test('a `.router/` folder with no tickets folder is no router run either', async () => {
  const { $ } = pretend(new Map([[`${ROOT}/events.jsonl`, '{"type":"done"}\n']]))
  expect((await readRouter($, CWD)).run).toBeUndefined()
})

test('tickets and events are read: five tickets, the counts, the events', async () => {
  const { $ } = pretend(fullDisk())
  const { run } = await readRouter($, `${CWD}/`)
  expect(run?.counts).toEqual({ total: 5, verified: 1, unproven: 0, unverified: 1, blocked: 1, inflight: 2, queued: 0 })
  expect(run?.events).toHaveLength(EVENT_LINES.length)
})

test('nothing is read again while the listing and the stats are the same; a changed file is', async () => {
  const disk = fullDisk()
  const { $, reads } = pretend(disk)
  const first = await readRouter($, CWD)
  const count = reads.length
  expect(count).toBe(6 + Object.keys(EVAL_FILES).length + Object.keys(VERDICT_FILES).length) // five tickets, the events, the eval.md and verdict.md files there are
  const again = await readRouter($, CWD, first)
  expect(again).toBe(first)
  expect(reads).toHaveLength(count)
  disk.set(`${ROOT}/tickets/02-api/ticket.json`, JSON.stringify({ ...TICKET_FILES['02-api'], status: 'blocked' }))
  const changed = await readRouter($, CWD, first)
  expect(changed).not.toBe(first)
  expect(changed.run?.counts).toMatchObject({ inflight: 1, blocked: 2 })
  // the proof files count as changes too: a new eval.md makes the ticket proven
  disk.set(`${ROOT}/tickets/02-api/eval.md`, '- the endpoints answer')
  expect((await readRouter($, CWD, changed)).run?.tickets.find(t => t.id === '02-api')?.eval).toMatchObject({ present: true, what: 'the endpoints answer' })
  disk.set(`${ROOT}/tickets/06-new/ticket.json`, JSON.stringify({ id: '06-new', status: 'ready' }))
  expect((await readRouter($, CWD, changed)).run?.counts.total).toBe(6)
})

test('garbage files are shown, not dropped: broken JSON is a draft ticket, a folder without ticket.json is no ticket', async () => {
  const disk = fullDisk()
  disk.set(`${ROOT}/tickets/07-broken/ticket.json`, '{"id": "07-broken", ')
  disk.set(`${ROOT}/tickets/08-spec-only/spec.md`, '# spec')
  const { run } = await readRouter(pretend(disk).$, CWD)
  expect(run?.tickets.map(t => t.id)).toEqual(['01-schema', '02-api', '03-ui', '04-auth', '05-deploy', '07-broken'])
  expect(run?.tickets.at(-1)).toMatchObject({ stage: 'draft', title: 'ticket.json could not be read' })
})

test('bounds: an oversized ticket.json is not read, the ticket count is capped, a huge events file is tailed', async () => {
  const disk = fullDisk()
  disk.set(`${ROOT}/tickets/02-api/ticket.json`, ' '.repeat(ROUTER_IO.MAX_FILE_BYTES + 1))
  disk.set(`${ROOT}/events.jsonl`, 'x'.repeat(ROUTER_IO.MAX_EVENTS_BYTES + 1) + '\n' + EVENT_LINES.at(-1))
  const { $, reads, runs } = pretend(disk)
  const { run } = await readRouter($, CWD)
  expect(reads.some(p => p.endsWith('02-api/ticket.json'))).toBe(false)
  expect(reads.some(p => p.endsWith('events.jsonl'))).toBe(false)
  expect(runs).toHaveLength(1)
  expect(runs[0]?.slice(0, 3)).toEqual(['tail', '-c', String(ROUTER_IO.TAIL_BYTES)])
  expect(run?.events.map(e => e.type)).toEqual(['worker_reported'])
  const crowd: Disk = new Map(Array.from({ length: ROUTER_IO.MAX_TICKETS + 20 }, (_, i) => [`${ROOT}/tickets/t${String(i).padStart(3, '0')}/ticket.json`, '{}'] as const))
  expect((await readRouter(pretend(crowd).$, CWD)).run?.tickets).toHaveLength(ROUTER_IO.MAX_TICKETS)
})

test('one ticket with no verdict also reads its eval.md checklist', async () => {
  const disk: Disk = new Map([[`${ROOT}/tickets/01-a/ticket.json`, '{"id":"01-a","status":"in_progress"}'], [`${ROOT}/tickets/01-a/eval.md`, '# Eval\n- [ ] Form validates\n- [ ] Posts to API\n']])
  const { run } = await readRouter(pretend(disk).$, CWD)
  expect(run?.tickets[0]?.evalItems).toEqual(['Form validates', 'Posts to API'])
})
