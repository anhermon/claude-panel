// The board through the engine with a `.router/` folder in the session's directory: the frames reach live/data.json, the
// poll picks the state up with no panel call, and a session without `.router/` shows nothing of it.
import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { COOLDOWN_MS, LEAD_MS } from '../hooks/pulse-flush'
import { ROUTER_IO } from '../hooks/router-io'
import { boot, CWD, dir, file, TOOL } from './boot'
import type { BootOptions, Entry } from './boot'
import { EVAL_FILES, EVENT_LINES, TICKET_FILES, VERDICT_FILES } from './router-fixture'

const BOARD_DIR = '/tmp/t/claude-panel/board/sess-1'
const DATA_TEMP = `${BOARD_DIR}/live/.data.json.tmp`
const SOURCE_MARK = '/web/builtin/board'
const ROOT = `${CWD}/.router`
const TICKETS = `${ROOT}/tickets`

type Json = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

function diskOf(names: string[]): Record<string, Entry> {
  const out: Record<string, Entry> = { [ROOT]: dir(), [TICKETS]: dir(), [`${ROOT}/events.jsonl`]: file(EVENT_LINES.join('\n').length) }
  for (const n of names) {
    out[`${TICKETS}/${n}`] = dir()
    out[`${TICKETS}/${n}/ticket.json`] = file(JSON.stringify(TICKET_FILES[n]).length)
    for (const [name, texts] of [['eval.md', EVAL_FILES], ['verdict.md', VERDICT_FILES]] as const) if (texts[n] !== undefined) out[`${TICKETS}/${n}/${name}`] = file(texts[n]!.length)
  }
  return out
}

async function routerBoot($: Engine, on: On, names: string[] | null, opts: BootOptions = {}) {
  const reads: string[] = []
  const texts: Record<string, string> = { [`${ROOT}/events.jsonl`]: EVENT_LINES.join('\n') + '\n' }
  for (const n of names ?? []) {
    texts[`${TICKETS}/${n}/ticket.json`] = JSON.stringify(TICKET_FILES[n])
    if (EVAL_FILES[n] !== undefined) texts[`${TICKETS}/${n}/eval.md`] = EVAL_FILES[n]!
    if (VERDICT_FILES[n] !== undefined) texts[`${TICKETS}/${n}/verdict.md`] = VERDICT_FILES[n]!
  }
  const b = await boot($, on, {
    files: names === null ? {} : diskOf(names),
    ...opts,
    setup: o => {
      o('fs.list', (_, e) => {
        if (e.path.endsWith(SOURCE_MARK)) return { value: ['index.html', 'board.js', 'board.css'].map(name => ({ name, kind: 'file' as const, size: 1, mtimeMs: 1, isLink: false })) }
        if (names !== null && e.path === TICKETS) return { value: names.map(name => ({ name, kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false })) }
        throw new Error(`ENOENT: ${e.path}`)
      })
    },
    texts: new Proxy(texts, {
      get: (t, k) => {
        if (typeof k !== 'string') return undefined
        if (k.startsWith(ROOT)) reads.push(k)
        return k.includes(`${SOURCE_MARK}/`) ? `// ${k.split('/').pop()}\n` : t[k]
      },
    }),
  })
  const data = (): Json => JSON.parse(b.writes.filter(w => w.path === DATA_TEMP).at(-1)?.text ?? 'null') as Json
  const settle = () => b.clock.advance(LEAD_MS + COOLDOWN_MS)
  return { ...b, data, settle, reads }
}

test('a session with a `.router/` folder: the tickets and events frames are on the board with no panel call', async ($, on) => {
  const b = await routerBoot($, on, Object.keys(TICKET_FILES))
  await b.settle()
  const frames: Json[] = b.data().frames
  expect(frames.map(f => f.id)).toEqual(['tickets', 'router-events'])
  expect(frames[0]).toMatchObject({ type: 'tickets', title: 'Tickets · 1 of 5 verified, 1 unverified', summary: { total: 5, verified: 1, unverified: 1, blocked: 1, inflight: 2 } })
  expect(frames[0]!.items.map((i: Json) => i.stage)).toEqual(['fixing', 'verifying', 'unverified', 'blocked', 'done'])
})

test('one ticket: the checks frame, not the tickets frame', async ($, on) => {
  const b = await routerBoot($, on, ['03-ui'])
  await b.settle()
  expect(b.data().frames.map((f: Json) => f.id)).toEqual(['checks', 'router-events'])
})

test('no `.router/`: nothing of it on the board, and the poll keeps looking without drawing anything', async ($, on) => {
  const b = await routerBoot($, on, null)
  await b.settle()
  expect(b.data().frames).toEqual([])
  await b.clock.advance(ROUTER_IO.POLL_MS * 3)
  expect(b.data().frames).toEqual([])
  expect(b.reads).toEqual([])
})

test('the poll does not re-read unchanged files', async ($, on) => {
  const b = await routerBoot($, on, Object.keys(TICKET_FILES))
  await b.settle()
  const first = b.reads.length
  expect(first).toBe(Object.keys(TICKET_FILES).length + Object.keys(EVAL_FILES).length + Object.keys(VERDICT_FILES).length + 1) // ticket.json + eval.md + verdict.md where present, + events
  await b.clock.advance(ROUTER_IO.POLL_MS * 4)
  expect(b.reads).toHaveLength(first)
})

test('frame_remove silences a router frame, a posted frame with its id replaces it, frames_clear brings it back', async ($, on) => {
  const b = await routerBoot($, on, Object.keys(TICKET_FILES))
  const call = (input: object) => $.tool.call({ tool: TOOL, ...input })
  expect((await call({ frame_remove: 'tickets' })).result).toBe('frame tickets removed (auto; frames_clear brings it back) · 1 on board')
  await b.settle()
  expect(b.data().frames.map((f: Json) => f.id)).toEqual(['router-events'])
  await call({ frames_clear: true })
  await b.settle()
  expect(b.data().frames.map((f: Json) => f.id)).toEqual(['tickets', 'router-events'])
  await call({ frame: { id: 'tickets', type: 'text', text: 'my own words' } })
  await b.settle()
  expect(b.data().frames.map((f: Json) => [f.id, f.type])).toEqual([['tickets', 'text'], ['router-events', 'timeline']])
})
