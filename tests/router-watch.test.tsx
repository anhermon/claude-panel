// `/panel watch <folder>`: the board follows a run in another folder than the session cwd; `off` returns to the cwd.
import { expect, test } from 'claude-code/testing'

import { COOLDOWN_MS, LEAD_MS } from '../hooks/pulse-flush'
import { ROUTER_IO } from '../hooks/router-io'
import { WATCH_STORE_KEY, WATCH_USAGE, parseWatchArgs } from '../hooks/watch'
import { boot, dir, file, RUN } from './boot'
import { EVENT_LINES, TICKET_FILES } from './router-fixture'

const BOARD_DIR = '/tmp/t/claude-panel/board/sess-1'
const DATA_TEMP = `${BOARD_DIR}/live/.data.json.tmp`
const SOURCE_MARK = '/web/builtin/board'
const REPO = '/other/repo'
const ROOT = `${REPO}/.router`
const TICKETS = `${ROOT}/tickets`
const NAMES = Object.keys(TICKET_FILES)

type Json = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

test('parseWatchArgs: absolute, trailing /.router and slashes, off/clear, relative, none', () => {
  expect(parseWatchArgs('live on')).toBeUndefined()
  expect(parseWatchArgs('watch')).toEqual({ verb: 'show' })
  expect(parseWatchArgs('watch /a/b')).toEqual({ verb: 'set', folder: '/a/b' })
  expect(parseWatchArgs('watch /a/b/')).toEqual({ verb: 'set', folder: '/a/b' })
  expect(parseWatchArgs('watch /a/b/.router')).toEqual({ verb: 'set', folder: '/a/b' })
  expect(parseWatchArgs('watch  /a/b/.router/ ')).toEqual({ verb: 'set', folder: '/a/b' })
  expect(parseWatchArgs('watch off')).toEqual({ verb: 'off' })
  expect(parseWatchArgs('watch clear')).toEqual({ verb: 'off' })
  expect(parseWatchArgs('watch b/c')).toEqual({ usage: WATCH_USAGE })
  expect(parseWatchArgs('watch ./b')).toEqual({ usage: WATCH_USAGE })
})

test('watch: the board gets the run of another folder; off returns to the session folder', async ($, on) => {
  const texts: Record<string, string> = { [`${ROOT}/events.jsonl`]: EVENT_LINES.join('\n') + '\n' }
  const files: Record<string, ReturnType<typeof dir>> = { [ROOT]: dir(), [TICKETS]: dir(), [`${ROOT}/events.jsonl`]: file(texts[`${ROOT}/events.jsonl`]!.length) }
  for (const n of NAMES) {
    texts[`${TICKETS}/${n}/ticket.json`] = JSON.stringify(TICKET_FILES[n])
    files[`${TICKETS}/${n}`] = dir()
    files[`${TICKETS}/${n}/ticket.json`] = file(texts[`${TICKETS}/${n}/ticket.json`]!.length)
  }
  const b = await boot($, on, {
    files,
    setup: o => {
      o('fs.list', (_, e) => {
        if (e.path.endsWith(SOURCE_MARK)) return { value: ['index.html', 'board.js', 'board.css'].map(name => ({ name, kind: 'file' as const, size: 1, mtimeMs: 1, isLink: false })) }
        if (e.path === TICKETS) return { value: NAMES.map(name => ({ name, kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false })) }
        throw new Error(`ENOENT: ${e.path}`)
      })
    },
    texts: new Proxy(texts, { get: (t, k) => (typeof k !== 'string' ? undefined : k.includes(`${SOURCE_MARK}/`) ? `// ${k.split('/').pop()}\n` : t[k]) }),
  })
  const frames = (): Json[] => (JSON.parse(b.writes.filter(w => w.path === DATA_TEMP).at(-1)?.text ?? 'null') as Json).frames
  const run = async (args: string) => (await $.command.run({ command: 'panel', args, ...RUN })).text
  await b.clock.advance(LEAD_MS + COOLDOWN_MS)
  expect(frames()).toEqual([])
  expect(await run('watch')).toMatch(/^following the session folder /)
  expect(await run('watch relative/dir')).toBe(WATCH_USAGE)
  expect(b.stored.has(WATCH_STORE_KEY)).toBe(false)

  expect(await run(`watch ${ROOT}/`)).toBe(`watching ${REPO}: ${NAMES.length} tickets`)
  expect(b.stored.get(WATCH_STORE_KEY)).toBe(REPO)
  await b.clock.advance(ROUTER_IO.POLL_MS + LEAD_MS + COOLDOWN_MS)
  expect(frames().map(f => f.id)).toEqual(['tickets', 'router-events'])

  expect(await run('watch /nowhere')).toBe('watching /nowhere: no .router/tickets yet')
  await b.clock.advance(ROUTER_IO.POLL_MS + LEAD_MS + COOLDOWN_MS)
  expect(frames()).toEqual([])

  await run(`watch ${REPO}`)
  await b.clock.advance(ROUTER_IO.POLL_MS + LEAD_MS + COOLDOWN_MS)
  expect(frames()).toHaveLength(2)
  expect(await run('watch off')).toMatch(/^following the session folder /)
  expect(b.stored.has(WATCH_STORE_KEY)).toBe(false)
  await b.clock.advance(ROUTER_IO.POLL_MS + LEAD_MS + COOLDOWN_MS)
  expect(frames()).toEqual([])
})
