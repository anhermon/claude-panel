// The Pulse scene: polls live/pulse.json (written by the panel mod), keeps the events it has seen, and paints the
// world as of a display clock that runs a little behind the mod's, so motion is continuous between polls.
// Quiet for 30 s -> about 2 frames a second. prefers-reduced-motion -> no flight, no drift, a still picture that updates.
import {
  KIND_COLORS, KIND_LEGEND, POLL_MS, QUIET_FRAME_MS,
  createClock, createStore, fmtDur, fmtInt, isQuiet, placeTag,
} from './pulse-logic.mjs'
import { drawFrame, tagFont, tagLabel } from './pulse-draw.mjs'
import { applySnapshot, makeGeom, newView, stepView } from './pulse-view.mjs'

const DATA_URL = 'live/pulse.json'
const MAX_FRAME_DT_MS = 600
const DPR_MAX = 2
const SR_EVERY_MS = 5000
const FETCH_TIMEOUT_MS = 4000
// `?debug` logs one line a second (frames drawn, quiet or not): how web/pulse-scene.test.mjs reads the frame rate.
const IS_DEBUG = location.search.includes('debug')
const DEBUG_EVERY_MS = 1000
const $ = (id) => document.getElementById(id)

const canvas = $('stage')
const ctx = canvas.getContext('2d')
const clock = createClock()
const store = createStore()
const view = newView(innerWidth, innerHeight)
view.store = store
const box = { last: 0, timer: 0, raf: 0, lastChange: 0, hud: {}, srAt: -Infinity, isFirst: true, fails: 0, frames: 0, debugAt: 0 }

const reduce = matchMedia('(prefers-reduced-motion: reduce)')
const syncReduce = () => {
  view.isReduced = reduce.matches
}
syncReduce()
reduce.addEventListener?.('change', () => {
  syncReduce()
  wake()
})

// ---- size -------------------------------------------------------------------------------------------------------

function resize() {
  const dpr = Math.min(DPR_MAX, devicePixelRatio || 1)
  const w = Math.max(1, innerWidth)
  const h = Math.max(1, innerHeight)
  canvas.width = Math.round(w * dpr)
  canvas.height = Math.round(h * dpr)
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  view.geom = makeGeom(w, h)
  wake()
}
new ResizeObserver(resize).observe(document.documentElement)

const measure = (s) => {
  ctx.font = tagFont(view.geom)
  return ctx.measureText(s).width
}

// ---- legend -----------------------------------------------------------------------------------------------------

$('legend').innerHTML = KIND_LEGEND.map(([kind, name]) => `<li style="color:${KIND_COLORS[kind]}"><i></i><span style="color:var(--muted)">${name}</span></li>`).join('')

// ---- data -------------------------------------------------------------------------------------------------------

function take(data) {
  if (data === null || typeof data !== 'object' || !Array.isArray(data.loops)) return
  const perf = performance.now()
  const isNew = clock.sync(data.now, perf)
  if (!isNew && !box.isFirst) return
  applySnapshot(view, data, perf, box.isFirst)
  for (const ev of store.ingest(data.events)) placeTag(ev, store.list, view.geom, measure, tagLabel)
  box.isFirst = false
  box.lastChange = data.now
  wake()
}

async function poll() {
  try {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS)
    const res = await fetch(`${DATA_URL}?t=${Date.now()}`, { cache: 'no-store', signal: ctl.signal })
    clearTimeout(timer)
    if (res.ok) {
      take(await res.json())
      box.fails = 0
    } else box.fails++
  } catch {
    box.fails++
  }
  setTimeout(poll, document.hidden ? POLL_MS * 3 : POLL_MS)
}

// ---- the header and the screen-reader line ----------------------------------------------------------------------------

function setText(id, value) {
  if (box.hud[id] !== value) {
    box.hud[id] = value
    $(id).textContent = value
  }
}

function stateLine(T, server) {
  const data = view.data
  if (data === null) return ['Waiting for the first pulse', false]
  const turn = data.session?.turn === 'running'
  if (turn) {
    const quiet = fmtDur(server - Math.max(store.lastT(), box.lastChange))
    const length = fmtDur(server - (data.session.turnStartedAt || data.session.startedAt))
    return [view.isQuiet ? `Turn running · ${length} · quiet for ${quiet}` : `Turn running · ${length}`, !view.isQuiet]
  }
  const active = view.shownNodes?.filter((n) => n.loop.status === 'running').length ?? 0
  if (active > 0) return [`${active} agent${active === 1 ? '' : 's'} working`, true]
  const since = server - Math.max(store.lastT(), box.lastChange)
  return [store.list.length === 0 ? 'Idle' : `Idle · last activity ${fmtDur(since)} ago`, false]
}

function updateHud(T, server, perf) {
  const [line, on] = stateLine(T, server)
  setText('state', line)
  if (box.hud.on !== on) {
    box.hud.on = on
    $('mark').classList.toggle('on', on)
  }
  setText('n-calls', fmtInt(view.shown.calls))
  setText('n-files', fmtInt(view.shown.files))
  setText('n-agents', fmtInt(view.shown.agents))
  view.mainLine = view.data === null ? '' : view.data.session?.turn === 'running' ? 'working' : 'idle'
  if (perf - box.srAt > SR_EVERY_MS) {
    box.srAt = perf
    const n = view.shownNodes?.length ?? 0
    $('sr').textContent = `Pulse: ${line}. ${view.counts.calls} tool calls, ${view.counts.files} files, ${view.counts.agents} agents started, ${n} on stage, ${view.free.length + view.main.lanes.length + (view.shownNodes ?? []).reduce((s, x) => s + x.lanes.length, 0)} lanes.`
  }
}

// ---- the frame loop ---------------------------------------------------------------------------------------------------

const isQuietNow = (server) => view.data !== null && isQuiet(server, store.lastT(), box.lastChange)

function frame(perf) {
  box.raf = 0
  const dt = Math.min(MAX_FRAME_DT_MS, box.last === 0 ? 16 : perf - box.last)
  box.last = perf
  const T = clock.display(perf)
  const server = clock.server(perf)
  view.isQuiet = isQuietNow(server)
  stepView(view, dt, perf, T, store.list)
  updateHud(T, server, perf)
  drawFrame(ctx, view, T, perf)
  box.frames++
  if (IS_DEBUG && perf - box.debugAt >= DEBUG_EVERY_MS) {
    box.debugAt = perf
    console.warn(`pulse frames=${box.frames} quiet=${view.isQuiet}`) // warn: the only non-error level web/shot.mjs reports
    box.frames = 0
  }
  schedule()
}

function schedule() {
  if (box.raf !== 0 || box.timer !== 0) return
  const slow = view.isQuiet || view.isReduced || document.hidden
  if (!slow) box.raf = requestAnimationFrame(frame)
  else
    box.timer = setTimeout(() => {
      box.timer = 0
      box.raf = requestAnimationFrame(frame)
    }, document.hidden ? QUIET_FRAME_MS * 2 : QUIET_FRAME_MS)
}

/** Something changed (a snapshot, the size, the motion setting): leave the slow mode now. */
function wake() {
  view.isQuiet = false
  if (box.timer !== 0) {
    clearTimeout(box.timer)
    box.timer = 0
  }
  if (box.raf === 0) box.raf = requestAnimationFrame(frame)
}

document.addEventListener('visibilitychange', wake)
resize()
poll()
