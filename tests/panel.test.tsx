import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { paneTree } from '../hooks/pane'
import { FIRST_PORT, STORE_PORTS_KEY, STORE_TOKEN_KEY } from '../hooks/server'
import { BASELINE_TEXT } from '../hooks/spec'
import { boot, CWD, HOME, pane, paneRows, PORT, RUN, SCENE_TOOL, seen, STATE_FILE, TOOL } from './boot'
import { FIXTURE } from './fixture-state'

// A pane is Box and Text only; two surfaces show it does not lean on one (each mount costs ~1s).
const SURFACES = ['terminal', 'desktop'] as const
const FULL_STATE_TEXTS = [
  /working/, /Add retry/, /503s/, /Claude needs you/, /Ship it\?/, /^Known$/,
  /uploads go through/, /✓ Wrote the test/, /→ 1\. Backoff/, /┃ Plan/, /◐ Backoff/,
  /Options/, /Client retry\s+S/, /retry\(fn\)/, /mind idempotency/, /^rev 2/,
]
const TEST_TIMEOUT_MS = 60_000
const TOKEN_FORMAT = /^[0-9a-f]{32}$/
const FIXTURE_PANE = 'fixture'

test('a tool call merges into the state, mirrors it to the file and opens the pane once', async ($, on) => {
  const { writes, opened, registered, spawned, ran, last, token, url, stored } = await boot($, on)
  expect(registered).toEqual([TOOL, SCENE_TOOL])
  // The interface to web/server.mjs:
  //   node <plugin root>/web/server.mjs <state file> --token T --port P --root DIR ...  (P: the folder's last port, else FIRST_PORT)
  expect(spawned).toHaveLength(1)
  expect(spawned[0]?.[0]).toBe('node')
  expect(spawned[0]?.[1]).toMatch(/\/web\/server\.mjs$/)
  expect(spawned[0]?.[2]).toBe(STATE_FILE)
  expect(spawned[0]?.slice(3, 7)).toEqual(['--token', token(), '--port', String(FIRST_PORT)])
  expect(token()).toMatch(TOKEN_FORMAT)
  // The link is reusable: the token and this folder's port are kept between sessions, so a restart opens the same url.
  expect(stored.get(STORE_TOKEN_KEY)).toBe(token())
  expect(stored.get(STORE_PORTS_KEY)).toEqual({ [CWD]: PORT })
  // The roots are real paths (/tmp is /private/tmp here), each its own --root.
  const roots = (spawned[0] ?? []).flatMap((a, i, all) => (a === '--root' ? [all[i + 1]] : []))
  expect(roots).toEqual([CWD, '/private/tmp', `${HOME}/.claude`])
  // crypto answered, so openssl was never asked for the token.
  expect(ran).toEqual([])

  // The url came from the PORT line (and the token); the first file holds it.
  expect(writes[0]?.path).toBe(STATE_FILE)
  expect(last().url).toBe(url())
  expect(last().url).toBe(`http://127.0.0.1:${PORT}/${token()}/`)

  const r = await $.tool.call({
    tool: TOOL,
    task: { title: 'Add retry', why: 'Failures cluster on 503s.' },
    next: ['Backoff'],
    done_add: ['Reproduced'],
  })
  expect(r.deny).toBeUndefined()
  expect(r.result).toBe(`panel rev 2 · ${url()}`)
  expect(last().task.title).toBe('Add retry')
  expect(last().done).toEqual(['Reproduced'])
  expect(last().rev).toBe(2)
  expect(opened).toEqual(['panel'])

  await $.tool.call({ tool: TOOL, status: 'waiting' })
  expect(last().status).toBe('waiting')
  expect(last().next).toEqual(['Backoff'])
  expect(opened).toEqual(['panel'])
})

test('invalid input is refused, naming the field, and changes nothing', async ($, on) => {
  const { writes, last } = await boot($, on)
  const before = writes.length
  const r = await $.tool.call({ tool: TOOL, status: 'busy' })
  expect(r.deny).toMatch(/status must be one of/)
  expect(writes).toHaveLength(before)
  expect(last().rev).toBe(1)
})

test('the url survives a PORT line split over pieces, and clears when the server exits', async ($, on) => {
  const { last, clock, stopServer, url } = await boot($, on, { portPieces: ['PO', 'RT 47', '18\n'] })
  expect(last().url).toBe(url(4718))
  stopServer()
  await clock.settle()
  expect(last().url).toBeNull()
})

test('prompt.compose adds exactly one session section naming both tools', async ($, on) => {
  await boot($, on, {
    setup: on =>
      on('prompt.compose', () => ({
        sections: [{ id: 'intro', text: 'base', scope: 'shared' as const }],
      })),
  })
  const { sections } = await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] })
  expect(sections).toHaveLength(2)
  const added = sections[1]
  expect(added?.scope).toBe('session')
  expect(added?.text).toContain(`\`${TOOL}\``)
  expect(added?.text).toContain(`\`${SCENE_TOOL}\``)
  expect(added?.text).toBe(BASELINE_TEXT)
})

test('/panel opens the pane and answers the url; /panel open also asks the OS to open it', async ($, on) => {
  const { opened, ran, url } = await boot($, on, { run: { uname: 'Darwin\n' } })
  const a = await $.command.run({ command: 'panel', args: '', ...RUN })
  expect(a.text).toBe(url())
  expect(opened).toEqual(['panel'])
  expect(ran).toEqual([])
  const b = await $.command.run({ command: 'panel', args: 'open', ...RUN })
  expect(b.text).toBe(url())
  expect(ran).toContainEqual(['open', url()])
})

test('the pane: empty state, full state, and a redraw when the rev changes', { timeoutMs: TEST_TIMEOUT_MS }, async ($, on) => {
  await boot($, on, { isServerDown: true })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...pane(), surface })
    await seen(ui, /Waiting for Claude/)
    await seen(ui, /^rev 1/)
    await ui.unmount()
  }

  await $.tool.call({
    tool: TOOL,
    task: { title: 'Add retry', why: 'Failures cluster on 503s.' },
    ask: 'Ship it?',
    context: ['uploads go through upload.ts'],
    done: ['Reproduced the flake', 'Wrote the test'],
    next: ['Backoff', 'Fake timers'],
    labels: { context: 'Known' },
    cards: [
      { id: 'plan', title: 'Plan', pin: true, tone: 'info', blocks: [{ kind: 'steps', items: [{ text: 'Backoff', state: 'doing' }] }] },
      {
        id: 'options',
        title: 'Options',
        blocks: [
          { kind: 'table', head: ['Option', 'Cost'], rows: [['Client retry', 'S'], ['Queue', 'L']] },
          { kind: 'code', text: 'retry(fn)' },
          { kind: 'callout', tone: 'warn', text: 'mind idempotency' },
        ],
      },
    ],
  })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...pane(), surface })
    for (const part of FULL_STATE_TEXTS) await seen(ui, part)
    expect(await ui.find({ type: 'Text', text: /Waiting for Claude/ })).toBeUndefined()
    await ui.unmount()
  }

  // A new rev redraws a pane that is already mounted, without anyone asking.
  const ui = await $.ui.mount({ ...pane(), surface: 'terminal' })
  await seen(ui, /Add retry/)
  await $.tool.call({ tool: TOOL, task: { title: 'Renamed' } })
  await seen(ui, /Renamed/)
  await seen(ui, /^rev 3/)
  expect(await ui.find({ type: 'Text', text: /Add retry/ })).toBeUndefined()
  await ui.unmount()
})

// A pane hook of the test's own draws the fixture, so these do not depend on
// the tool's validator: they check the Pane element alone.
const fixtureHook = (on: On): void => {
  on('ui.render', { component: 'Pane', requestId: FIXTURE_PANE }, ($, e) => paneTree($, e, FIXTURE))
}

test('a tree taller than the body: the footer is pinned on the last row of the window, with a hint', async ($, on) => {
  await boot($, on, { isServerDown: true, setup: fixtureHook })
  const body = 20
  const tops = new Map<number, string[]>()
  for (const offset of [0, 40, 9999]) {
    const ui = await $.ui.mount({ ...pane(body, 45, offset, FIXTURE_PANE), surface: 'terminal' })
    tops.set(offset, await paneRows(ui))
    await ui.unmount()
  }
  const total = (tops.get(0) ?? []).length
  expect(total).toBeGreaterThan(body)

  const top = tops.get(0) ?? []
  expect(top[0]).toBe('● working')
  expect(top[body - 1]).toMatch(/^↓ \d+ more · rev 7 · http/)
  expect(top.slice(0, body - 1).some(r => r.includes('Claude needs you'))).toBe(true)

  const mid = tops.get(40) ?? []
  expect(mid).toHaveLength(total)
  expect(mid[40 + body - 1]).toMatch(/^↑ 40 · ↓ \d+ more · rev 7/)
  // Content row 40 sits one row further on in the top tree: its footer row came first.
  expect(mid[40]).toBe(top[41])

  const end = tops.get(9999) ?? []
  const last = total - body
  expect(end[last + body - 1]).toBe(end.at(-1))
  expect(end.at(-1)).toMatch(/^↑ \d+ above · rev 7/)
})

test('a tree that fits the body is drawn whole, with the plain footer last and no hint', async ($, on) => {
  await boot($, on, { isServerDown: true, setup: fixtureHook })
  const ui = await $.ui.mount({ ...pane(500, 100, 0, FIXTURE_PANE), surface: 'terminal' })
  const rows = await paneRows(ui)
  expect(rows.at(-1)).toBe('rev 7 · http://127.0.0.1:4717/')
  expect(rows.some(r => /more$|above$/.test(r))).toBe(false)
  expect(Math.max(...rows.map(r => Array.from(r).length))).toBeLessThanOrEqual(100)
  await ui.unmount()
})

test('with no scroll window reported the pane still draws, sized from the viewport', async ($, on) => {
  await boot($, on, { isServerDown: true })
  const bare = { ...pane(), props: { ...pane().props, scroll: undefined } }
  const ui = await $.ui.mount({ ...bare, surface: 'terminal' } as never)
  await seen(ui, /Waiting for Claude/)
  await ui.unmount()
})

test('a value an earlier version stored is declined, not drawn', async ($, on) => {
  // What older code wrote under another shape tag stays through a reload.
  on('state.get', () => ({ value: { value: { rev: 'garbage' }, version: 1 } }))
  const ui = await $.ui.mount({ ...pane(), surface: 'terminal' })
  await seen(ui, /Waiting for Claude/)
  await ui.unmount()
})
