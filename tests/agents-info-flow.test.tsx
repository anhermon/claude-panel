// The Agents tile through the engine: it appears by itself when an agent shows up (never in a plain chat), its live/data.json
// carries the events of the transitions, the model can remove it and it then stays away, and without its source nothing happens.
import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { COOLDOWN_MS, LEAD_MS } from '../hooks/pulse-flush'
import { resetAgentsInfo } from '../hooks/agents-info-host'
import { boot, SCENE_TOOL, STATE_FILE, TOOL } from './boot'
import type { BootOptions } from './boot'

const SCENE_ID = 'agents-info'
const SCENE_DIR = '/tmp/t/claude-panel/agents-info/sess-1'
const DATA_TEMP = `${SCENE_DIR}/live/.data.json.tmp`
const SOURCE_MARK = '/web/builtin/agents-info'
const SOURCE_FILES = ['index.html', 'agents-info.js', 'agents-info.css']
/** The board's own source: the event stream is fed by the board's flusher, so the board must be installed too. */
const BOARD_MARK = '/web/builtin/board'
const BOARD_FILES = ['index.html', 'board.js', 'board.css']
const listing = (names: string[]) => names.map(name => ({ name, kind: 'file' as const, size: 1, mtimeMs: 1, isLink: false }))

type Json = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

async function crewBoot($: Engine, on: On, hasSource = true, opts: BootOptions = {}) {
  resetAgentsInfo()
  const b = await boot($, on, {
    ...opts,
    setup: o => {
      opts.setup?.(o)
      o('fs.list', (_, e) => ({
        value: e.path.endsWith(BOARD_MARK) ? listing(BOARD_FILES) : hasSource && e.path.endsWith(SOURCE_MARK) ? listing(SOURCE_FILES) : [],
      }))
    },
    texts: new Proxy(opts.texts ?? {}, { get: (t, k) => (typeof k === 'string' && (k.includes(`${SOURCE_MARK}/`) || k.includes(`${BOARD_MARK}/`)) ? `// ${k.split('/').pop()}\n` : t[k as string]) }),
  })
  const state = (): Json => JSON.parse(b.writes.filter(w => w.path === STATE_FILE).at(-1)?.text ?? 'null') as Json
  const sceneIds = (): string[] => (state()?.scenes ?? []).map((s: Json) => s.id)
  const data = (): Json | null => {
    const w = b.writes.filter(x => x.path === DATA_TEMP).at(-1)
    return w === undefined ? null : (JSON.parse(w.text) as Json)
  }
  const settle = () => b.clock.advance(LEAD_MS + COOLDOWN_MS)
  const lane = async (id: string, extra: object = {}) => {
    await $.tool.call({ tool: TOOL, lane: { id, state: 'working', pct: 10, ...extra } })
    await settle()
  }
  return { ...b, state, sceneIds, data, settle, lane }
}

test('a plain chat has no Agents tile', async ($, on) => {
  const b = await crewBoot($, on)
  await $.tool.call({ tool: TOOL, task: { title: 'Chat', why: 'w' } })
  await b.settle()
  expect(b.sceneIds()).not.toContain(SCENE_ID)
  expect(b.data()).toBeNull()
})

test('the first agent registers the tile, installs its files and starts the event stream', async ($, on) => {
  const b = await crewBoot($, on)
  await b.lane('t43', { label: 'T43 Classifier' })
  expect(b.sceneIds()).toContain(SCENE_ID)
  const scene = (b.state().scenes as Json[]).find(s => s.id === SCENE_ID)!
  expect(scene).toMatchObject({ builtin: true, layout: 'stage', dir: SCENE_DIR, entry: 'index.html' })
  for (const name of SOURCE_FILES) expect(b.writes.some(w => w.path === `${SCENE_DIR}/${name}`)).toBe(true)
  await b.lane('t43', { state: 'testing', pct: 60 })
  const data = b.data()!
  expect(data.agents.map((a: Json) => a.id)).toContain('t43')
  expect(data.agents.find((a: Json) => a.id === 't43')).toMatchObject({ state: 'testing', pct: 60 })
  const texts = (data.events as Json[]).map(e => e.text)
  expect(texts).toContain('main → T43')
  expect(texts).toContain('T43 started')
  expect(texts).toContain('T43 testing')
  const ids = (data.events as Json[]).map(e => e.id)
  expect(ids).toEqual([...ids].sort((a, c) => a - c))
  expect(new Set(ids).size).toBe(ids.length)
})

test('the model can remove the tile; a later agent does not bring it back', async ($, on) => {
  const b = await crewBoot($, on)
  await b.lane('t43')
  expect(b.sceneIds()).toContain(SCENE_ID)
  const r = await $.tool.call({ tool: SCENE_TOOL, remove: SCENE_ID })
  expect(String(r.result)).toContain(`scene ${SCENE_ID} removed`)
  expect(b.sceneIds()).not.toContain(SCENE_ID)
  const writes = b.writes.filter(w => w.path === DATA_TEMP).length
  await b.lane('t44')
  expect(b.sceneIds()).not.toContain(SCENE_ID)
  expect(b.writes.filter(w => w.path === DATA_TEMP).length).toBe(writes)
})

test('without its source folder the tile is not registered (quietly)', async ($, on) => {
  const b = await crewBoot($, on, false)
  await b.lane('t43')
  expect(b.sceneIds()).not.toContain(SCENE_ID)
})

test('a click on an agent row (and the close) is the tile talking to the mod: it never reaches Claude, other events still do', async ($, on) => {
  const texts: Record<string, string> = {}
  const b = await crewBoot($, on, true, { texts })
  const events = '/tmp/t/claude-panel/panel-sess-1.events.jsonl'
  const line = (n: number, scene: string, name: string) => JSON.stringify({ n, t: 1000 + n, scene, name, data: { id: 't43' } })
  texts[events] = [line(1, SCENE_ID, 'agent'), line(2, 'viz', 'pick'), line(3, SCENE_ID, 'agent-close')].join('\n') + '\n'
  const r = await $.tool.call({ tool: TOOL })
  const out = String(r.result)
  expect(out).toContain('"name":"pick"')
  expect(out).not.toContain('"name":"agent"')
  expect(out).not.toContain('agent-close')
  expect(b.sceneIds()).not.toContain(SCENE_ID) // (nothing about the tile changed)
})
