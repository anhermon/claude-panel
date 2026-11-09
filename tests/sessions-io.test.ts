// The `$` reader of the sessions frame over a pretend ~/.claude: registry + `ps` decide who is alive, only tails are read, only when
// something changed, and the `*.key` tokens are never opened. Nothing touches the real home folder.
import { expect, test } from 'claude-code/testing'
import type { EngineInterface } from 'claude-code'

import { DISCOVER_EVERY_MS, PS_EVERY_MS } from '../hooks/sessions-state'
import { newSessionsCache, readSessions, SESSIONS_IO } from '../hooks/sessions-io'
import { ID_A, ID_B, ID_DEAD, MIN, NOW, psText, registryFile, SELF, toolUse, transcript, user } from './sessions-fixture'

const CLAUDE = '/Users/a/.claude'
type Disk = Map<string, { text: string; mtimeMs: number }>

/** A pretend `$` over a map of path -> { text, mtime } (a folder exists when a path starts with it); counts reads and runs. */
function pretend(disk: Disk, ps: () => string) {
  const reads: string[] = []
  const runs: string[][] = []
  const names = (p: string) => new Set([...disk.keys()].filter(k => k.startsWith(`${p}/`)).map(k => k.slice(p.length + 1).split('/')[0]!))
  const $ = {
    env: { get: async (name: string) => (name === 'HOME' ? '/Users/a' : undefined) },
    fs: {
      list: async (p: string) => {
        if (names(p).size === 0) throw new Error('ENOENT')
        return [...names(p)].map(name => ({ name, kind: disk.has(`${p}/${name}`) ? 'file' : 'dir', size: 0, mtimeMs: disk.get(`${p}/${name}`)?.mtimeMs ?? 0, isLink: false }))
      },
      stat: async (p: string) => {
        const f = disk.get(p)
        if (f === undefined) throw new Error('ENOENT')
        return { kind: 'file', size: f.text.length, mtimeMs: f.mtimeMs, isLink: false }
      },
      read: async (p: string) => {
        reads.push(p)
        const f = disk.get(p)
        if (f === undefined) throw new Error('ENOENT')
        return f.text
      },
    },
    process: {
      run: async (argv: string[]) => {
        runs.push(argv)
        if (argv[0] === 'ps') return { exitCode: 0, stdout: ps(), stderr: '' }
        return { exitCode: 0, stdout: disk.get(argv.at(-1)!)?.text.slice(-SESSIONS_IO.TAIL_BYTES) ?? '', stderr: '' }
      },
    },
  } as unknown as EngineInterface
  return { $, reads, runs }
}

const file = (text: string, mtimeMs = NOW - 10 * MIN) => ({ text, mtimeMs })
function world(): Disk {
  return new Map([
    [`${CLAUDE}/sessions/101.json`, file(registryFile(101, ID_A, { name: 'alpha work', status: 'busy' }))],
    [`${CLAUDE}/sessions/102.json`, file(registryFile(102, ID_B, { name: 'beta', cwd: '/work/beta' }))],
    [`${CLAUDE}/sessions/103.json`, file(registryFile(103, SELF, { name: 'this one' }))],
    [`${CLAUDE}/sessions/104.json`, file(registryFile(104, ID_DEAD, { name: 'dead' }))], // pid 104 is not in ps
    [`${CLAUDE}/sessions/101.key`, file('SECRET-PEER-TOKEN')],
    [`${CLAUDE}/projects/-work-alpha/${ID_A}.jsonl`, file(transcript(user('first'), user('wire the sessions frame'), toolUse('t1')), NOW - 40_000)],
    [`${CLAUDE}/projects/-work-beta/${ID_B}.jsonl`, file(transcript(user('write the docs', { cwd: '/work/beta' })), NOW - 30 * MIN)],
    [`${CLAUDE}/projects/-work-alpha/${SELF}.jsonl`, file(transcript(user('me')), NOW)],
    [`${CLAUDE}/projects/-work-alpha/${ID_DEAD}.jsonl`, file(transcript(user('dead')), NOW - MIN)],
  ])
}

test('only live sessions other than this one: the dead pid and the current session are left out, state and task come from the registry and the tail', async () => {
  const { $ } = pretend(world(), () => psText([101, 102, 103]))
  const rows = await readSessions($, newSessionsCache(), SELF, NOW)
  expect(rows).toEqual([
    { id: ID_A, title: 'alpha work', state: 'waiting', project: 'alpha', branch: 'feature/x', age: 'now', task: 'wire the sessions frame' },
    { id: ID_B, title: 'beta', state: 'idle', project: 'beta', branch: 'feature/x', age: '30m', task: 'write the docs' },
  ])
})

test('the `*.key` peer tokens are never opened, and only the sessions that can reach the frame get a tail read', async () => {
  const disk = world()
  const { $, reads, runs } = pretend(disk, () => psText([101, 102, 103]))
  await readSessions($, newSessionsCache(), SELF, NOW)
  expect(reads.some(r => r.endsWith('.key'))).toBe(false)
  expect(reads.every(r => /\/sessions\/\d+\.json$/.test(r))).toBe(true)
  expect(runs.filter(r => r[0] === 'tail').map(r => r.at(-1))).toEqual([`${CLAUDE}/projects/-work-alpha/${ID_A}.jsonl`, `${CLAUDE}/projects/-work-beta/${ID_B}.jsonl`])
})

test('nothing changed: the next poll reads no file again and runs no tail; ps and the transcript listing wait for their interval', async () => {
  const { $, reads, runs } = pretend(world(), () => psText([101, 102, 103]))
  const cache = newSessionsCache()
  await readSessions($, cache, SELF, NOW)
  const [r0, p0] = [reads.length, runs.length]
  await readSessions($, cache, SELF, NOW + 3000)
  expect(reads).toHaveLength(r0)
  expect(runs).toHaveLength(p0)
  await readSessions($, cache, SELF, NOW + Math.max(PS_EVERY_MS, DISCOVER_EVERY_MS) + 1)
  expect(runs.filter(r => r[0] === 'ps')).toHaveLength(2)
  expect(runs.filter(r => r[0] === 'tail')).toHaveLength(2) // still the same two tails: their files did not change
})

test('a session that ended is gone at the next ps; ps that never answers draws nothing', async () => {
  let alive = [101, 102, 103]
  const { $ } = pretend(world(), () => psText(alive))
  const cache = newSessionsCache()
  expect((await readSessions($, cache, SELF, NOW)).map(r => r.id)).toEqual([ID_A, ID_B])
  alive = [102, 103]
  expect((await readSessions($, cache, SELF, NOW + PS_EVERY_MS + 1)).map(r => r.id)).toEqual([ID_B])
  const broken = pretend(world(), () => '')
  broken.$.process.run = async () => { throw new Error('no ps') } // eslint-disable-line @typescript-eslint/require-await
  expect(await readSessions(broken.$, newSessionsCache(), SELF, NOW)).toEqual([])
})

test('no other session at all: no rows', async () => {
  const { $ } = pretend(world(), () => psText([103]))
  expect(await readSessions($, newSessionsCache(), SELF, NOW)).toEqual([])
})

test('setting off: no rows and not one read, listing, stat or process run', async () => {
  const { $, reads, runs } = pretend(world(), () => psText([101, 102]))
  const touched: string[] = []
  const spy = new Proxy($.fs, { get: (t, k) => { touched.push(String(k)); return Reflect.get(t, k) } })
  expect(await readSessions({ ...$, fs: spy } as EngineInterface, newSessionsCache(), SELF, NOW, false)).toEqual([])
  expect([reads, runs, touched]).toEqual([[], [], []])
})
