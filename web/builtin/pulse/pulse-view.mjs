// The Pulse scene's moving parts between polls: where the nodes are, how full each lane arc is, how busy each loop
// looks. Everything eases toward what the last snapshot says, so a poll never makes anything jump. No DOM here.
import { activityOf, agentColor, angDiff, clamp, easeCount, groupLanes, loopOpacity } from './pulse-logic.mjs'

const TAU = Math.PI * 2
const MAIN = 'main'
/** First node sits up and to the right; the rest follow clockwise. */
const FIRST_ANGLE = (-38 * Math.PI) / 180
/** One turn of the orbit in this many seconds: calm. */
const ORBIT_SECONDS = 220
const ANGLE_TAU_MS = 520
const ACT_EASE_MS = 260
const LANE_EASE_MS = 420
const APPEAR_MS = 800
// With more nodes than this, they alternate between two orbits so their labels have room.
const SINGLE_TRACK_MAX = 5
const OUTER_TRACK = 1.14
const INNER_TRACK = 0.74

export function makeGeom(w, h) {
  const u = clamp(Math.min(w / 960, h / 540), 0.7, 2.4)
  const headerH = 62 * u
  const footH = 78 * u
  const areaH = Math.max(140, h - headerH - footH)
  const cy = headerH + areaH / 2
  const ry = areaH * 0.46
  const rx = Math.min(w * 0.36, ry * 2.1)
  return {
    w, h, u, cx: w / 2, cy, rx, ry,
    ox: rx * 0.5, oy: ry * 0.5,
    coreR: 27 * u, gap: 9 * u, tagH: 15 * u, headerH, footH,
    tl: { x0: 30 * u, x1: w - 30 * u, yBase: h - 26 * u, hMax: 34 * u },
  }
}

export function newView(w, h) {
  return {
    geom: makeGeom(w, h),
    data: null,
    nodes: new Map(),
    laneShown: new Map(),
    main: { act: 0, lanes: [] },
    free: [],
    counts: { calls: 0, files: 0, agents: 0 },
    shown: { calls: 0, files: 0, agents: 0 },
    tlScale: 4,
    isReduced: false,
    isQuiet: false,
  }
}

/** The label a node shows: its lane's label when it has one, else the agent's description. */
export function nodeLabel(node) {
  const lane = node.lanes[0]
  return (lane !== undefined && lane.label !== '' ? lane.label : node.loop.name || node.loop.label || node.id) || node.id
}

/** What the node says under its label: the lane's step, else what the loop did last. */
export function nodeLine(node) {
  const lane = node.lanes[0]
  if (lane !== undefined) {
    const lead = lane.state === 'working' ? '' : `${lane.state}${lane.step !== '' ? ' · ' : ''}`
    return `${lead}${lane.step}`
  }
  const loop = node.loop
  if (loop.status === 'done') return 'done'
  return loop.lastTool === '' ? loop.status : `${loop.lastTool}${loop.lastTarget !== '' ? ` ${loop.lastTarget}` : ''}`
}

/** Take a new snapshot into the view: targets only; what is drawn eases toward them in `stepView`. */
export function applySnapshot(view, data, perfNow, isInitial) {
  view.data = data
  const t = data.totals ?? {}
  view.counts = { calls: t.calls ?? 0, files: t.files ?? 0, agents: t.agents ?? 0 }
  for (const loop of data.loops ?? []) {
    if (loop.id === MAIN) continue
    const held = view.nodes.get(loop.id)
    if (held === undefined) {
      view.nodes.set(loop.id, {
        id: loop.id, loop, color: agentColor(loop.id), a: null, x: view.geom.cx, y: view.geom.cy,
        act: 0, r: 0, vis: 1, lanes: [], bornAt: isInitial ? -Infinity : perfNow, track: 1,
      })
    } else held.loop = loop
  }
}

/** Advance everything by dtMs. `T` is the display clock, `now` the page clock (ms). */
export function stepView(view, dtMs, now, T, list) {
  const g = view.geom
  const data = view.data
  const loops = data === null ? [] : data.loops ?? []
  const ids = new Set(loops.map((l) => l.id))
  for (const id of view.nodes.keys()) if (!ids.has(id)) view.nodes.delete(id)

  const shown = [...view.nodes.values()].filter((n) => loopOpacity(n.loop, T) > 0).sort((a, b) => a.loop.startedAt - b.loop.startedAt)
  const shownIds = new Set([MAIN, ...shown.map((n) => n.id)])
  const { byLoop, free } = groupLanes(data === null ? [] : data.lanes, shownIds)
  view.free = free
  view.main.lanes = byLoop.get(MAIN) ?? []
  view.main.act += (activityOf(list, MAIN, T) - view.main.act) * (1 - Math.exp(-dtMs / ACT_EASE_MS))

  const rot = view.isReduced ? 0 : (now / 1000 / ORBIT_SECONDS) * TAU
  const n = shown.length
  shown.forEach((node, i) => {
    node.lanes = byLoop.get(node.id) ?? []
    node.track = n <= SINGLE_TRACK_MAX ? 1 : i % 2 === 0 ? OUTER_TRACK : INNER_TRACK
    const target = FIRST_ANGLE + (i * TAU) / Math.max(1, n) + rot
    node.a = node.a === null ? target : node.a + angDiff(node.a, target) * (1 - Math.exp(-dtMs / ANGLE_TAU_MS))
    node.x = g.cx + g.ox * node.track * Math.cos(node.a)
    node.y = g.cy + g.oy * node.track * Math.sin(node.a)
    node.act += (activityOf(list, node.id, T) - node.act) * (1 - Math.exp(-dtMs / ACT_EASE_MS))
    const appear = clamp((now - node.bornAt) / APPEAR_MS, 0, 1)
    const baseR = (8.5 + 7 * node.act) * g.u * (node.loop.status === 'done' ? 0.8 : 1)
    node.r += (baseR * appear - node.r) * (1 - Math.exp(-dtMs / 220))
    node.vis = loopOpacity(node.loop, T)
    node.appear = appear
  })
  view.shownNodes = shown

  const allLanes = data === null ? [] : data.lanes ?? []
  const laneIds = new Set()
  for (const lane of allLanes) {
    laneIds.add(lane.id)
    const goal = lane.state === 'done' ? 1 : lane.pct === null || lane.pct === undefined ? 0 : lane.pct / 100
    const held = view.laneShown.get(lane.id)
    view.laneShown.set(lane.id, held === undefined ? goal : held + (goal - held) * (1 - Math.exp(-dtMs / LANE_EASE_MS)))
  }
  for (const id of view.laneShown.keys()) if (!laneIds.has(id)) view.laneShown.delete(id)

  for (const key of Object.keys(view.shown)) view.shown[key] = view.isReduced ? view.counts[key] : easeCount(view.shown[key], view.counts[key], dtMs)
}
