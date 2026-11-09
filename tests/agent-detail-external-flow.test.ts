// The host half for a codex run, end to end with a stand-in `$`: the poll reads the run's record and rollout, the page asks for the agent, and
// detail.json carries the rollout's transcript and the run's facts; a run with no rollout says so; an outside path is never read.
import { expect, test } from 'claude-code/testing'
import type { EngineInterface } from 'claude-code'

import { DETAIL_FILE_NAME, detailTick, resetDetail } from '../hooks/agent-detail-host'
import type { DetailBind, DetailSource } from '../hooks/agent-detail-host'
import { AGENT_EVENT, AGENTS_INFO_SCENE_ID } from '../hooks/agents-info-scene'
import { agentRowsOf } from '../hooks/agents-info-data'
import { runLoopId } from '../hooks/pulse-ingest'
import { newModel } from '../hooks/pulse-model'
import { pollRunsNow, startRunsPoll, stopRunsPoll } from '../hooks/pulse-runs-host'
import { ROLLOUT_SMOKE } from './fixtures/codex/fixtures'

const SESSION = '00000000-0000-4000-8000-000000000001'
const RUN = '20261109T115103-codex-9b79ba'
const THREAD = '01a1c025-c93d-7852-9a66-31be9623cf40'
const HOME = '/home/u'
const CWD = '/work/demo'
const ROLLOUT = `${HOME}/.codex/sessions/2026/11/09/rollout-2026-11-09T13-51-08-${THREAD}.jsonl`
const OUTSIDE = '/etc/rollout-secret.jsonl'
const EVENTS = '/tmp/t/panel.events.jsonl'
const DIR = '/tmp/t/agents-info'
const NOW = Date.parse('2026-11-09T11:52:00.000Z')

type Disk = Map<string, string>
const record = (path: string | undefined): string =>
  JSON.stringify({ v: 1, runId: RUN, harness: 'codex', sessionId: SESSION, startedAt: '2026-11-09T11:51:03.613Z', endedAt: '2026-11-09T11:51:21.917Z', status: 'ok', title: 'Codex smoke test', workdir: CWD, model: 'gpt-6.1-sol', effort: 'low', durationS: 18.304, ...(path === undefined ? {} : { transcript: { format: 'codex-rollout', path, threadId: THREAD } }) })

function world(disk: Disk): { $: EngineInterface; written: Map<string, string>; reads: string[] } {
  const written = new Map<string, string>()
  const reads: string[] = []
  const $ = {
    env: { get: async (k: string) => (k === 'HOME' ? HOME : undefined) },
    clock: { now: async () => NOW, every: () => ({ cancel: () => undefined }) },
    session: { id: async () => SESSION, cwd: async () => CWD },
    fs: {
      list: async (p: string) => {
        const names = new Set([...disk.keys()].filter(k => k.startsWith(`${p}/`)).map(k => k.slice(p.length + 1).split('/')[0]!))
        if (names.size === 0) throw new Error('ENOENT')
        return [...names].map(name => ({ name, kind: disk.has(`${p}/${name}`) ? 'file' : 'dir', size: disk.get(`${p}/${name}`)?.length ?? 0, mtimeMs: NOW - 60_000, isLink: false }))
      },
      stat: async (p: string) => {
        const text = disk.get(p)
        if (text === undefined) throw new Error('ENOENT')
        return { kind: 'file', size: text.length, mtimeMs: NOW - 60_000, isLink: false }
      },
      read: async (p: string) => {
        reads.push(p)
        const text = disk.get(p)
        if (text === undefined) throw new Error('ENOENT')
        return text
      },
      write: async (p: string, body: string) => {
        written.set(p, body)
      },
    },
    process: {
      run: async (argv: string[]) => {
        const [program, flag, bytes, path] = argv
        if (program === 'mv') {
          written.set(argv.at(-1) ?? '', written.get(argv.at(-2) ?? '') ?? '')
          return { exitCode: 0, stdout: '', stderr: '' }
        }
        const text = disk.get(path ?? '')
        reads.push(path ?? '')
        if (text === undefined || flag !== '-c') return { exitCode: 1, stdout: '', stderr: '' }
        return { exitCode: 0, stdout: program === 'head' ? text.slice(0, Number(bytes)) : text.slice(-Number(bytes)), stderr: '' }
      },
    },
  } as unknown as EngineInterface
  return { $, written, reads }
}

/** Poll the run, ask for its detail, and give what detail.json holds. */
async function detailOf(disk: Disk): Promise<{ json: Record<string, any> | undefined; reads: string[] }> {
  resetDetail()
  const w = world(disk)
  const model = newModel(NOW)
  const target = { model: () => model, touch: () => undefined }
  startRunsPoll(w.$, target)
  await pollRunsNow(w.$, target)
  const loops = [...model.loops.values()]
  // a board shows a finished run only beside a lane somebody posted (the session's own)
  const own = { id: 'own', label: 'Own lane', state: 'working' as const, pct: null, step: '', note: '', goal: '', dod: [], at: null, startedAt: NOW, updatedAt: NOW, by: 'main' }
  const agents = agentRowsOf({ lanes: [own], loops, events: [], now: NOW, task: null, router: undefined }).agents
  const row = agents.find(a => a.loop === runLoopId(RUN))
  disk.set(EVENTS, `${JSON.stringify({ n: 1, t: NOW, scene: AGENTS_INFO_SCENE_ID, name: AGENT_EVENT, data: { id: row?.id, pages: 1 } })}\n`)
  const source: DetailSource = { dir: () => DIR, rows: () => agents, pulse: () => ({ loops, events: [] }) }
  const bind: DetailBind = { eventsFile: EVENTS, isCurrent: async () => true }
  await detailTick(w.$, source, bind)
  stopRunsPoll()
  const text = [...w.written.entries()].find(([p]) => p.endsWith(DETAIL_FILE_NAME))?.[1]
  return { json: text === undefined ? undefined : JSON.parse(text), reads: w.reads }
}

test('a codex run: detail.json has its rollout\'s transcript and its own facts, not a Claude "kept no transcript" notice', async () => {
  const { json } = await detailOf(new Map([[`${CWD}/.router/runs/${RUN}.json`, record(ROLLOUT)], [ROLLOUT, ROLLOUT_SMOKE]]))
  expect(json?.transcript).toMatchObject({ isAvailable: true, reason: '' })
  expect(json?.transcript.entries.map((e: { kind: string }) => e.kind)).toEqual(['say', 'tool', 'say'])
  expect(json?.metrics).toMatchObject({ elapsedMs: 18_304, calls: 1, errors: 0 })
  expect(json?.external).toMatchObject({ source: 'rollout', model: 'gpt-6.1-sol', effort: 'low', tokens: { fresh: 21_224, cached: 20_864 }, proof: { result: 'pass' } })
  expect(JSON.stringify(json)).not.toContain('Claude Code')
})

test('a run whose rollout is not there says so and still shows what its record holds', async () => {
  const { json } = await detailOf(new Map([[`${CWD}/.router/runs/${RUN}.json`, record(undefined)]]))
  expect(json?.transcript).toMatchObject({ isAvailable: false, reason: 'no rollout found for this run (codex thread unknown)' })
  expect(json?.external).toMatchObject({ source: 'record', runMs: 18_304, model: 'gpt-6.1-sol', failed: null })
  expect(json?.run).toMatchObject({ harness: 'codex', status: 'Finished' })
})

test('a rollout path outside the codex sessions folder is never read', async () => {
  const { json, reads } = await detailOf(new Map([[`${CWD}/.router/runs/${RUN}.json`, record(OUTSIDE)], [OUTSIDE, ROLLOUT_SMOKE]]))
  expect(reads).not.toContain(OUTSIDE)
  expect(json?.transcript?.isAvailable).toBe(false)
})
