// Pure logic of the Pulse scene: no DOM, no canvas, no timers. Everything the picture shows is a function of
// (the events seen so far, the display clock T), so the motion never jumps when a poll lands:
//   - events are stored as they arrive and keep their own server time `t`;
//   - T is the server clock minus a small playback delay, so an event is drawn when its time comes, not when it arrived;
//   - sparks, ripples and tags are positions along (T - t), not objects with timers.
// Tested by web/pulse-logic.test.mjs.

export const POLL_MS = 700
/** The display clock runs this far behind the server clock: a snapshot written at t is fetched well before t + this. */
export const DELAY_MS = 1300
export const QUIET_AFTER_MS = 30_000
export const QUIET_FRAME_MS = 500
export const SPARK_MS = 850
export const RIPPLE_MS = 900
export const TAG_LIFE_MS = 9000
export const TAG_FADE_IN_MS = 280
export const TAG_FADE_OUT_MS = 2400
export const TIMELINE_MS = 60_000
export const BIN_MS = 1000
export const MAX_EVENTS = 1500
export const ACT_TAU_MS = 2200
export const DONE_LINGER_MS = 40_000
export const DONE_FADE_MS = 4000
export const COUNT_TAU_MS = 240
/** The offset only ever follows a faster estimate; this much per second it may bleed back (clock drift). */
const OFFSET_BLEED_MS_PER_S = 0.5
/** A snapshot this close to the page's wall clock (in the future by 5 s at most, in the past by 30 days) is on the same epoch clock. */
const WALL_SKEW_BACK_MS = 5000
const WALL_SKEW_FWD_MS = 30 * 24 * 3600 * 1000
const TAU = Math.PI * 2
const TAG_ANGLE_STEP = (4 * Math.PI) / 180
const TAG_ANGLE_TRIES = 45
/** Width kept free beside a tag for its "×n" count, which grows after the tag is placed. */
const TAG_COUNT_RESERVE = ' ×9'
const TAG_PAD = 4

/** What a tool is for, which picks its colour. */
const KINDS = {
  Read: 'read', Grep: 'read', Glob: 'read', LS: 'read', NotebookRead: 'read',
  Edit: 'edit', Write: 'edit', MultiEdit: 'edit', NotebookEdit: 'edit',
  Bash: 'shell', WebFetch: 'web', WebSearch: 'web',
  Task: 'agent', Agent: 'agent', panel: 'agent', scene: 'agent',
  spawn: 'spawn', lane: 'lane',
}
export function toolKind(tool) {
  if (Object.hasOwn(KINDS, tool)) return KINDS[tool]
  return typeof tool === 'string' && tool.startsWith('Bash') ? 'shell' : 'other'
}

export const KIND_COLORS = {
  read: '#22d3ee', edit: '#fbbf24', shell: '#c084fc', web: '#f472b6', agent: '#7aa2ff', spawn: '#7aa2ff', lane: '#4ade80', other: '#a19d95',
}
export const KIND_LEGEND = [
  ['read', 'read / search'], ['edit', 'edit'], ['shell', 'shell'], ['web', 'web'], ['agent', 'agent / other'],
]
export const ERROR_COLOR = '#f87171'
export const AGENT_COLORS = ['#4ade80', '#fb923c', '#f472b6', '#a3e635', '#2dd4bf', '#f87171', '#e879f9', '#facc15']
export const MAIN_COLOR = '#7aa2ff'
export const STATE_COLORS = { testing: '#22d3ee', waiting: '#fbbf24', blocked: '#f87171', done: '#4ade80' }

export function hashStr(s) {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0
  return h
}
export const agentColor = (id) => AGENT_COLORS[hashStr(String(id)) % AGENT_COLORS.length]

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
export const easeInOut = (u) => 0.5 - 0.5 * Math.cos(Math.PI * clamp(u, 0, 1))
export const easeOut = (u) => 1 - (1 - clamp(u, 0, 1)) ** 3
/** The shortest signed way round from angle a to angle b. */
export const angDiff = (a, b) => ((((b - a) % TAU) + 3 * Math.PI) % TAU) - Math.PI

export function shortName(s, max) {
  if (s.length <= max) return s
  const dot = s.lastIndexOf('.')
  const ext = dot > 0 && s.length - dot <= 6 ? s.slice(dot) : ''
  return s.slice(0, Math.max(1, max - ext.length - 1)) + '…' + ext
}

export function fmtInt(n) {
  const v = Math.round(n)
  return v >= 10_000 ? String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ' ') : String(v)
}

export function fmtDur(ms) {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

// ---- the clock ----------------------------------------------------------------------------------------------

/**
 * Server time. The mod and the browser run on the same machine, so when a snapshot's `now` is within reach of the
 * page's wall clock the wall clock IS the server clock (and a file that stopped changing an hour ago is seen as an
 * hour old, which the quiet mode needs). A mod clock that is not epoch time falls back to an offset from the page's
 * own timer: a snapshot's `now` is when it was WRITTEN, so `now - perf` underestimates by the write-to-fetch delay,
 * and the best estimate is the largest one seen. Only a changed file carries a new `now`.
 */
export function createClock(wall = Date.now) {
  const box = { mode: null, offset: 0, lastNow: -Infinity, last: -Infinity, at: 0 }
  return {
    /** A snapshot arrived. Returns true when it was new. */
    sync(dataNow, perfNow) {
      if (typeof dataNow !== 'number' || !Number.isFinite(dataNow) || dataNow === box.lastNow) return false
      box.lastNow = dataNow
      if (box.mode === null) box.mode = wall() - dataNow >= -WALL_SKEW_BACK_MS && wall() - dataNow <= WALL_SKEW_FWD_MS ? 'wall' : 'relative'
      if (box.mode === 'relative') {
        const estimate = dataNow - perfNow
        box.offset = box.at === 0 ? estimate : Math.max(estimate, box.offset - ((perfNow - box.at) / 1000) * OFFSET_BLEED_MS_PER_S)
        box.at = perfNow || 1
      }
      return true
    },
    isReady: () => box.mode !== null,
    /** Server time now; never goes backwards. */
    server(perfNow) {
      const t = box.mode === 'wall' ? wall() : perfNow + box.offset
      box.last = Math.max(box.last, t)
      return box.last
    },
    /** The display clock: what is drawn is the world as of this server time. */
    display(perfNow) {
      return this.server(perfNow) - DELAY_MS
    },
  }
}

// ---- events -------------------------------------------------------------------------------------------------

/** Keep the events seen so far, once each. `ingest` returns only the new ones. */
export function createStore() {
  const byKey = new Map()
  const list = []
  return {
    list,
    ingest(events) {
      const fresh = []
      const seen = new Map()
      for (const raw of Array.isArray(events) ? events : []) {
        if (raw === null || typeof raw !== 'object' || typeof raw.t !== 'number' || typeof raw.loop !== 'string') continue
        const base = `${raw.t}|${raw.loop}|${raw.tool}|${raw.target}`
        const n = seen.get(base) ?? 0
        seen.set(base, n + 1)
        const key = `${base}#${n}`
        const held = byKey.get(key)
        if (held !== undefined) {
          if (raw.err === true) held.err = true
          continue
        }
        const ev = { t: raw.t, loop: raw.loop, tool: String(raw.tool ?? ''), target: String(raw.target ?? ''), err: raw.err === true, kind: toolKind(raw.tool), a: null, key }
        byKey.set(key, ev)
        list.push(ev)
        fresh.push(ev)
      }
      list.sort((x, y) => x.t - y.t)
      while (list.length > MAX_EVENTS) byKey.delete(list.shift().key)
      return fresh
    },
    lastT: () => (list.length === 0 ? -Infinity : list[list.length - 1].t),
  }
}

/** How busy a loop is at display time T, 0..1: recent calls, each fading with ACT_TAU_MS. */
export function activityOf(list, loopId, T) {
  let sum = 0
  for (let i = list.length - 1; i >= 0; i--) {
    const ev = list[i]
    const age = T - ev.t
    if (age > ACT_TAU_MS * 5) break
    if (age < 0 || ev.loop !== loopId) continue
    sum += Math.exp(-age / ACT_TAU_MS)
  }
  return 1 - Math.exp(-0.6 * sum)
}

/** Tags wait on the workbench from when the spark lands until they fade. */
export const arrivalOf = (ev) => ev.t + SPARK_MS
export const hasTag = (ev) => ev.target !== '' && ev.kind !== 'spawn' && ev.kind !== 'lane'
export function tagAlpha(ev, T) {
  const age = T - arrivalOf(ev)
  if (age < 0 || age > TAG_LIFE_MS) return 0
  return Math.min(clamp(age / TAG_FADE_IN_MS, 0, 1), clamp((TAG_LIFE_MS - age) / TAG_FADE_OUT_MS, 0, 1))
}

/** The point of the workbench ellipse at angle a. */
export const ringPoint = (geom, a) => ({ x: geom.cx + geom.rx * Math.cos(a), y: geom.cy + geom.ry * Math.sin(a) })

/** The rectangle a tag at angle `a` covers (text of width w, height h), clipped inside the canvas. */
export function tagRect(geom, a, w, h) {
  const p = ringPoint(geom, a)
  const cos = Math.cos(a)
  const gap = geom.gap
  let x = cos > 0.3 ? p.x + gap : cos < -0.3 ? p.x - gap - w : p.x - w / 2
  const y = p.y + (Math.sin(a) > 0.3 ? gap * 0.4 : Math.sin(a) < -0.3 ? -gap * 0.4 - h : -h / 2)
  x = clamp(x, 6, Math.max(6, geom.w - 6 - w))
  return { x, y, w, h, anchor: cos > 0.3 ? 'left' : cos < -0.3 ? 'right' : 'center', px: p.x, py: p.y }
}

const overlaps = (a, b) => a.x < b.x + b.w + TAG_PAD && b.x < a.x + a.w + TAG_PAD && a.y < b.y + b.h + TAG_PAD && b.y < a.y + a.h + TAG_PAD

/**
 * Give a new event its place on the workbench: a stable angle from its target, nudged to the nearest spot where its
 * tag overlaps no tag that is alive at the same time. The same target while still shown keeps its spot.
 * `measure(text)` gives the text width in px; `label(ev)` the text to draw.
 */
export function placeTag(ev, list, geom, measure, label) {
  if (ev.kind === 'spawn' || ev.kind === 'lane') {
    ev.a = null
    return
  }
  if (!hasTag(ev)) {
    // No target (a Task, an MCP call): the spark still lands on the workbench, at a place of its tool's own.
    ev.a = ((hashStr(ev.tool) % 3600) / 3600) * TAU
    return
  }
  const start = arrivalOf(ev)
  const alive = list.filter((o) => o !== ev && o.a !== null && hasTag(o) && arrivalOf(o) < start + TAG_LIFE_MS && arrivalOf(o) + TAG_LIFE_MS > start)
  const same = alive.find((o) => o.target === ev.target)
  if (same !== undefined) {
    ev.a = same.a
    return
  }
  const base = ((hashStr(ev.target) % 3600) / 3600) * TAU
  const w = measure(label(ev) + TAG_COUNT_RESERVE)
  const rects = alive.map((o) => tagRect(geom, o.a, measure(label(o) + TAG_COUNT_RESERVE), geom.tagH))
  for (let k = 0; k < TAG_ANGLE_TRIES; k++) {
    const a = base + (k % 2 === 0 ? 1 : -1) * Math.ceil(k / 2) * TAG_ANGLE_STEP
    const r = tagRect(geom, a, w, geom.tagH)
    if (!rects.some((o) => overlaps(r, o))) {
      ev.a = a
      return
    }
  }
  ev.a = base
}

/** Tags to draw at display time T: one per distinct text (the newest event), with how many times it was touched. */
export function liveTags(list, T, label) {
  const byText = new Map()
  for (let i = list.length - 1; i >= 0; i--) {
    const ev = list[i]
    if (T - arrivalOf(ev) > TAG_LIFE_MS + 1000) break
    if (ev.a === null || !hasTag(ev)) continue
    const alpha = tagAlpha(ev, T)
    if (alpha <= 0) continue
    const text = label(ev)
    const held = byText.get(text)
    if (held === undefined) byText.set(text, { ev, alpha, n: 1, text })
    else {
      held.n++
      if (alpha > held.alpha) {
        held.alpha = alpha
        held.ev = ev
      }
    }
  }
  return [...byText.values()]
}

// ---- the timeline --------------------------------------------------------------------------------------------

/** Calls per second per kind over the last minute, as bars keyed by their start time. */
export function timelineBins(list, T) {
  const from = T - TIMELINE_MS
  const bins = new Map()
  for (let i = list.length - 1; i >= 0; i--) {
    const ev = list[i]
    if (ev.t < from) break
    if (ev.t > T) continue
    const b = Math.floor(ev.t / BIN_MS)
    let bin = bins.get(b)
    if (bin === undefined) bins.set(b, (bin = { start: b * BIN_MS, total: 0, kinds: {} }))
    bin.total++
    bin.kinds[ev.err ? 'error' : ev.kind] = (bin.kinds[ev.err ? 'error' : ev.kind] ?? 0) + 1
  }
  return [...bins.values()].sort((a, b) => a.start - b.start)
}

// ---- smooth numbers ------------------------------------------------------------------------------------------

/** Move `shown` toward `target` without a jump: exponential, snapping once within half a unit. */
export function easeCount(shown, target, dtMs) {
  if (Math.abs(target - shown) < 0.5) return target
  return shown + (target - shown) * (1 - Math.exp(-Math.max(0, dtMs) / COUNT_TAU_MS))
}

// ---- loops and lanes ------------------------------------------------------------------------------------------

/** Is a loop on the stage at display time T? A finished one lingers, then fades out. Returns its opacity 0..1. */
export function loopOpacity(loop, T) {
  if (loop.id === 'main' || loop.status !== 'done') return 1
  const quiet = T - (loop.lastAt || 0)
  if (quiet < DONE_LINGER_MS) return quiet < 0 ? 1 : 0.55
  return Math.max(0, 0.55 * (1 - (quiet - DONE_LINGER_MS) / DONE_FADE_MS))
}

/** The lanes of one loop, the free-standing ones (null loop, or a loop that is not on stage), in post order. */
export function groupLanes(lanes, shownIds) {
  const byLoop = new Map()
  const free = []
  for (const lane of Array.isArray(lanes) ? lanes : []) {
    if (lane === null || typeof lane !== 'object' || typeof lane.id !== 'string') continue
    if (typeof lane.loop === 'string' && shownIds.has(lane.loop)) {
      if (!byLoop.has(lane.loop)) byLoop.set(lane.loop, [])
      byLoop.get(lane.loop).push(lane)
    } else free.push(lane)
  }
  return { byLoop, free }
}

/** Where the quiet mode starts: nothing happened for QUIET_AFTER_MS of server time. */
export const isQuiet = (serverNow, lastEventT, lastChangeAt) => serverNow - Math.max(lastEventT, lastChangeAt) > QUIET_AFTER_MS
