// The fleet hub end to end through the engine (the disk, `ps` and the other session stood in for): a command file
// becomes one `$.session.send` with the marker in front, a result file and an audit line; every unsafe one is refused
// and nothing is sent. Also `/fleet`.
import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { FLEET_ORIGIN, FLEET_ORIGIN_PREFIX, HUB_POLL_MS, RATE_MAX_PER_TARGET } from '../hooks/fleet-contract'
import { boot, HOME, RUN } from './boot'

const STATE = '/tmp/t/claude-panel/fleet'
const SESSIONS = `${HOME}/.claude/sessions`
const TARGET = '11111111-2222-3333-4444-555555555555'
const PID = 4242
const PROC_START = 'Thu Nov  5 07:34:30 2026'
const SECRET = 'sk-test-0123456789abcdef0123456789abcdef'
const id = (n: number): string => n.toString(16).padStart(32, '0')

type Sent = { to: unknown; text: string }
type Json = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

async function hubBoot($: Engine, on: On, over: { texts?: Record<string, string>; delivered?: boolean; psLines?: Record<number, string> } = {}) {
  const sent: Sent[] = []
  let mockNow = 0
  const commands = new Map<string, string>() // name -> text, the pretend commands folder
  const claimed = new Set<string>()
  const texts: Record<string, string> = { [`${SESSIONS}/${PID}.json`]: JSON.stringify({ pid: PID, sessionId: TARGET, procStart: PROC_START, token: 'never-read' }), ...over.texts }
  const b = await boot($, on, {
    texts,
    setup: o => {
      o('fs.list', (_, e) =>
        e.path === `${STATE}/commands` ? { value: [...commands.keys()].map(name => ({ name, kind: 'file' as const, size: 1, mtimeMs: 1, isLink: false })) } : { value: [] },
      )
      o('session.send', (_, e) => {
        sent.push({ to: e.to, text: e.text })
        return over.delivered === false ? { isDelivered: false, reason: 'nobody by that name' } : { isDelivered: true }
      })
    },
    onRun: argv => {
      const [cmd, ...rest] = argv
      if (cmd === 'mkdir' && rest.at(-1)?.startsWith(`${STATE}/claims/`) === true) {
        const claim = rest.at(-1) as string
        if (claimed.has(claim)) return { exitCode: 1 }
        claimed.add(claim)
      }
      if (cmd === 'ps') return { stdout: over.psLines?.[Number(argv[2])] ?? (Number(argv[2]) === PID ? `${PROC_START}\n` : ''), exitCode: Number(argv[2]) === PID || over.psLines?.[Number(argv[2])] !== undefined ? 0 : 1 }
      if (cmd === 'rm') commands.delete((rest.at(-1) ?? '').split('/').pop() ?? '')
      if (cmd === 'mv') {
        const from = rest.at(-2) as string
        const to = rest.at(-1) as string
        texts[to] = texts[from] ?? ''
        const w = [...b.writes].reverse().find(x => x.path === from)
        if (w !== undefined) texts[to] = w.text
      }
      return undefined
    },
  })
  // The engine's clock is the mock's (it starts at 0 and moves with `tick`): a command is dated by it, never by the real time.
  const put = async (n: number, over2: Record<string, unknown> = {}): Promise<string> => {
    const cid = id(n)
    const body = { id: cid, sessionId: TARGET, pid: PID, procStart: PROC_START, text: 'hello there', ts: mockNow, origin: FLEET_ORIGIN, ...over2 }
    commands.set(`${cid}.json`, JSON.stringify(body))
    texts[`${STATE}/commands/${cid}.json`] = JSON.stringify(body)
    return cid
  }
  const tick = async (n = 1): Promise<void> => {
    for (let i = 0; i < n; i++) {
      await b.clock.advance(HUB_POLL_MS)
      mockNow += HUB_POLL_MS
    }
    await b.clock.settle()
  }
  const written = (path: string): Json | undefined => {
    const w = [...b.writes].reverse().find(x => x.path === path || x.path === `${path}.tmp`)
    return w === undefined ? undefined : (JSON.parse(w.text) as Json)
  }
  const result = (cid: string): Json | undefined => written(`${STATE}/results/${cid}.json`)
  const audit = (): Json[] => {
    const w = [...b.writes].reverse().find(x => x.path === `${STATE}/audit.jsonl.tmp`)
    return (w?.text ?? '').split('\n').filter(l => l !== '').map(l => JSON.parse(l) as Json)
  }
  return { ...b, sent, commands, claimed, put, tick, result, audit, written, texts }
}

test('a good command is sent once with the marker in front, answered, audited and removed', async ($, on) => {
  const h = await hubBoot($, on, { texts: { [`${STATE}/hub-config.json`]: '{}' } })
  const cid = await h.put(1, { text: `check the build ${SECRET}` })
  await h.tick()
  expect(h.sent).toEqual([{ to: TARGET, text: `${FLEET_ORIGIN_PREFIX}\ncheck the build ${SECRET}` }])
  expect(h.result(cid)).toMatchObject({ id: cid, status: 'queued', reason: null })
  const [line] = h.audit()
  expect(line).toMatchObject({ id: cid, sessionId: TARGET, pid: PID, status: 'queued', hub: 'sess-1' })
  expect(JSON.stringify(line)).not.toContain(SECRET) // the audit keeps a masked preview, never the secret
  expect(h.commands.size).toBe(0)
  expect(h.written(`${STATE}/hub.json`)).toMatchObject({ schema: 1, sessionId: 'sess-1' })
})

test('the registry is read by pid only: the peer token files beside it are never opened', async ($, on) => {
  const h = await hubBoot($, on)
  await h.put(2)
  await h.tick()
  expect(h.sent).toHaveLength(1)
  expect(h.ran.flat().some(a => a.endsWith('.key'))).toBe(false)
})

test('unsafe commands are refused and nothing is sent', async ($, on) => {
  const h = await hubBoot($, on)
  const cases: [string, Record<string, unknown>, RegExp][] = [
    [id(10), { pid: 999 }, /no registry entry/],
    [id(11), { procStart: 'Fri Nov  6 01:00:00 2026' }, /restarted/],
    [id(12), { origin: 'cli' }, /does not come from the fleet page/],
    [id(13), { ts: -10 * 60_000 }, /expired/],
    [id(14), { text: FLEET_ORIGIN_PREFIX }, /fleet marker/],
    [id(15), { sessionId: 'sess-1' }, /not a session id/],
  ]
  for (const [cid, over] of cases) await h.put(Number.parseInt(cid, 16), over)
  await h.tick(2)
  expect(h.sent).toEqual([])
  for (const [cid] of cases) expect(h.result(cid)).toMatchObject({ status: 'refused' })
  for (const [cid, , reason] of cases) expect(h.result(cid)?.reason).toMatch(reason)
  expect(h.audit().length).toBe(cases.length)
})

test('a process that is gone, or another process on the pid, is not messaged', async ($, on) => {
  const h = await hubBoot($, on, { psLines: { [PID]: 'Mon Jan  1 00:00:00 2024\n' } })
  const cid = await h.put(20)
  await h.tick()
  expect(h.sent).toEqual([])
  expect(h.result(cid)?.reason).toMatch(/another process/)
})

test('two hubs: the one that loses the claim does nothing', async ($, on) => {
  const h = await hubBoot($, on)
  const cid = await h.put(40)
  h.claimed.add(`${STATE}/claims/${cid}`)
  await h.tick()
  expect(h.sent).toEqual([])
  expect(h.result(cid)).toBeUndefined()
  expect(h.commands.size).toBe(1)
})

test(`rate limit: ${RATE_MAX_PER_TARGET} messages a minute to one session, the next is refused`, async ($, on) => {
  const h = await hubBoot($, on)
  const ids: string[] = []
  for (let n = 0; n <= RATE_MAX_PER_TARGET; n++) ids.push(await h.put(50 + n))
  await h.tick(1)
  expect(h.sent).toHaveLength(RATE_MAX_PER_TARGET)
  expect(h.result(ids.at(-1) as string)).toMatchObject({ status: 'refused' })
  expect(h.result(ids.at(-1) as string)?.reason).toMatch(/rate limit/)
})

test('a send the engine does not deliver is reported as failed with its reason', async ($, on) => {
  const h = await hubBoot($, on, { delivered: false })
  const cid = await h.put(60)
  await h.tick()
  expect(h.result(cid)).toMatchObject({ status: 'failed', reason: 'nobody by that name' })
})

test('/fleet answers the launcher\'s words; status never shows a url; bad words get the usage line', async ($, on) => {
  const h = await hubBoot($, on, { texts: {} })
  const run = async (args: string) => (await $.command.run({ command: 'fleet', args, ...RUN })).text
  expect(await run('bogus')).toBe('usage: /fleet [start|stop|status|url]')
  const calls = h.calls.length
  await run('status')
  const last = h.calls.at(-1)
  expect(h.calls.length).toBeGreaterThan(calls)
  expect(last?.argv[1]).toMatch(/\/scripts\/fleet\.mjs$/)
  expect(last?.argv[2]).toBe('status')
  await run('')
  expect(h.calls.at(-1)?.argv.slice(-2)).toEqual(['start', '--print-url'])
})
