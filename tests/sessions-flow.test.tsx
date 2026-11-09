// The board through the engine with other Claude Code sessions on the machine: the `sessions` frame reaches live/data.json with no
// panel call and frame_remove silences it.
import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { COOLDOWN_MS, LEAD_MS } from '../hooks/pulse-flush'
import { boot, file, HOME, TOOL } from './boot'
import type { Entry } from './boot'
import { ID_A, ID_B, LSTART, registryFile, transcript, user } from './sessions-fixture'

const BOARD_DIR = '/tmp/t/claude-panel/board/sess-1'
const DATA_TEMP = `${BOARD_DIR}/live/.data.json.tmp`
const SOURCE_MARK = '/web/builtin/board'
const SESSIONS = `${HOME}/.claude/sessions`
const PROJECTS = `${HOME}/.claude/projects`
const SLUG = `${PROJECTS}/-work-alpha`

type Json = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

async function sessionsBoot($: Engine, on: On) {
  const texts: Record<string, string> = {
    [`${SESSIONS}/101.json`]: registryFile(101, ID_A, { name: 'alpha work', status: 'busy' }),
    [`${SESSIONS}/102.json`]: registryFile(102, ID_B, { name: 'beta', cwd: '/work/beta' }),
    [`${SLUG}/${ID_A}.jsonl`]: transcript(user('wire the sessions frame')),
    [`${SLUG}/${ID_B}.jsonl`]: transcript(user('write the docs', { cwd: '/work/beta' })),
  }
  const files: Record<string, Entry> = Object.fromEntries(Object.entries(texts).map(([p, t]) => [p, file(t.length)]))
  const b = await boot($, on, {
    files,
    onRun: argv => {
      if (argv[0] === 'ps') return { stdout: [101, 102].map(p => `${p} 1 ${LSTART} claude`).join('\n') }
      if (argv[0] === 'tail') return { stdout: texts[argv.at(-1)!] ?? '' }
      return undefined
    },
    setup: o => {
      o('fs.list', (_, e) => {
        const f = (name: string, kind: 'file' | 'dir') => ({ name, kind, size: 1, mtimeMs: 1, isLink: false })
        if (e.path.endsWith(SOURCE_MARK)) return { value: ['index.html', 'board.js', 'board.css'].map(n => f(n, 'file')) }
        if (e.path === SESSIONS) return { value: ['101.json', '102.json', '101.key'].map(n => f(n, 'file')) }
        if (e.path === PROJECTS) return { value: [f('-work-alpha', 'dir')] }
        if (e.path === SLUG) return { value: [`${ID_A}.jsonl`, `${ID_B}.jsonl`].map(n => f(n, 'file')) }
        throw new Error(`ENOENT: ${e.path}`)
      })
    },
    texts: new Proxy(texts, { get: (t, k) => (typeof k === 'string' && k.includes(`${SOURCE_MARK}/`) ? `// ${k.split('/').pop()}\n` : typeof k === 'string' ? t[k] : undefined) }),
  })
  const data = (): Json => JSON.parse(b.writes.filter(w => w.path === DATA_TEMP).at(-1)?.text ?? 'null') as Json
  const settle = () => b.clock.advance(LEAD_MS + COOLDOWN_MS)
  return { ...b, data, settle }
}

const LATER_MS = 90_000

test('other live sessions are on the board with no panel call: busy first, with project and current task', async ($, on) => {
  const b = await sessionsBoot($, on)
  await b.clock.advance(LATER_MS) // the pretend transcripts were written at 1 ms: a minute later only the registry's busy session is busy
  await b.settle()
  const frames: Json[] = b.data().frames
  expect(frames.map(f => [f.id, f.type, f.kind])).toEqual([['sessions', 'viz', 'statusboard']])
  const columns: Json[] = frames[0]!.data.columns
  expect(columns.map(c => c.id)).toEqual(['busy', 'idle'])
  expect(columns[0]!.items[0]).toMatchObject({ title: 'alpha work', sub: 'wire the sessions frame' })
  expect(columns[1]!.items[0]).toMatchObject({ title: 'beta', sub: 'write the docs', tags: ['beta', 'feature/x', '1m'] })
})

test('frame_remove silences the sessions frame', async ($, on) => {
  const b = await sessionsBoot($, on)
  await b.settle()
  expect((await $.tool.call({ tool: TOOL, frame_remove: 'sessions' })).result).toBe('frame sessions removed (auto; frames_clear brings it back) · 0 on board')
  await b.settle()
  expect(b.data().frames).toEqual([])
})
