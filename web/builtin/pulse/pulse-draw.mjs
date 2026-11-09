// Paints one frame of the Pulse on a 2D canvas. Pure drawing: it reads the view (pulse-view.mjs) and the events
// (pulse-logic.mjs) and draws the world as of the display clock T. Nothing here keeps state between frames but the
// dust field and a few cached gradients.
import {
  ERROR_COLOR, KIND_COLORS, MAIN_COLOR, RIPPLE_MS, SPARK_MS, STATE_COLORS, TIMELINE_MS, BIN_MS,
  clamp, easeInOut, easeOut, hashStr, liveTags, ringPoint, shortName, timelineBins,
} from './pulse-logic.mjs'
import { nodeLabel, nodeLine } from './pulse-view.mjs'

const TAU = Math.PI * 2
const MAIN = 'main'
const FONT_UI = 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif'
const FONT_MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace'
const BG_INNER = '#1b1b21'
const BG_OUTER = '#0b0b0d'
const FG = '#ecebe8'
const MUTED = '#a19d95'
const TAG_CHARS = 24
const LABEL_CHARS = 28
const LINE_CHARS = 40
const DUST = 54
const TRAIL_STEPS = 14
const TRAIL_SPAN = 0.26
/** Stack order of the timeline bars, bottom up. */
const BAR_ORDER = ['read', 'edit', 'shell', 'web', 'agent', 'other', 'spawn', 'lane', 'error']
const RAILS_MAX = 5

// ---- small helpers --------------------------------------------------------------------------------------------

const hexCache = new Map()
export function rgba(hex, a) {
  let c = hexCache.get(hex)
  if (c === undefined) {
    const n = parseInt(hex.slice(1), 16)
    c = [(n >> 16) & 255, (n >> 8) & 255, n & 255]
    hexCache.set(hex, c)
  }
  return `rgba(${c[0]},${c[1]},${c[2]},${clamp(a, 0, 1).toFixed(3)})`
}

function mulberry(seed) {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const rand = mulberry(0x9e3779b9)
const dust = Array.from({ length: DUST }, () => ({ x: rand(), y: rand(), s: 0.4 + rand() * 1.2, p: rand() * TAU, v: 0.2 + rand() * 0.8 }))

export const tagFont = (g) => `${Math.round(11 * g.u)}px ${FONT_MONO}`
export const tagLabel = (ev) => shortName(ev.target, TAG_CHARS)

function glow(ctx, x, y, r, color, alpha) {
  if (r <= 0 || alpha <= 0) return
  const grad = ctx.createRadialGradient(x, y, 0, x, y, r)
  grad.addColorStop(0, rgba(color, alpha))
  grad.addColorStop(0.35, rgba(color, alpha * 0.38))
  grad.addColorStop(1, rgba(color, 0))
  ctx.fillStyle = grad
  ctx.beginPath()
  ctx.arc(x, y, r, 0, TAU)
  ctx.fill()
}

function text(ctx, str, x, y, { font, color = FG, align = 'left', alpha = 1, base = 'alphabetic' }) {
  ctx.font = font
  ctx.textAlign = align
  ctx.textBaseline = base
  ctx.fillStyle = rgba(color, alpha)
  ctx.fillText(str, x, y)
}

// ---- the stage --------------------------------------------------------------------------------------------------

function drawBackdrop(ctx, view, now) {
  const g = view.geom
  const grad = ctx.createRadialGradient(g.cx, g.cy, 0, g.cx, g.cy, Math.max(g.w, g.h) * 0.72)
  grad.addColorStop(0, BG_INNER)
  grad.addColorStop(1, BG_OUTER)
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, g.w, g.h)
  const drift = view.isReduced ? 0 : now / 1000
  for (const d of dust) {
    const x = (d.x * g.w + drift * 3 * d.v) % g.w
    const y = (d.y * g.h - drift * 2 * d.v + g.h * 10) % g.h
    const tw = view.isReduced ? 0.6 : 0.55 + 0.45 * Math.sin(drift * d.v * 0.9 + d.p)
    ctx.fillStyle = rgba('#c9d6ff', 0.05 + 0.13 * tw * d.s * 0.7)
    ctx.beginPath()
    ctx.arc(x, y, d.s * g.u * 0.9, 0, TAU)
    ctx.fill()
  }
}

function drawWorkbench(ctx, view, T, now) {
  const g = view.geom
  ctx.save()
  // the ring itself: a dotted track that slowly marches
  ctx.strokeStyle = rgba(FG, 0.2)
  ctx.lineWidth = 1.3 * g.u
  ctx.setLineDash([1.5 * g.u, 6.5 * g.u])
  ctx.lineCap = 'round'
  ctx.lineDashOffset = view.isReduced ? 0 : -now / 90
  ctx.beginPath()
  ctx.ellipse(g.cx, g.cy, g.rx, g.ry, 0, 0, TAU)
  ctx.stroke()
  ctx.setLineDash([])
  // ticks every 6 degrees, longer every 30, pointing inward
  for (let i = 0; i < 60; i++) {
    const a = (i / 60) * TAU
    const long = i % 5 === 0
    const o = ringPoint(g, a)
    const k = (long ? 9 : 5) * g.u
    ctx.strokeStyle = rgba(FG, long ? 0.22 : 0.1)
    ctx.lineWidth = g.u
    ctx.beginPath()
    ctx.moveTo(o.x, o.y)
    ctx.lineTo(g.cx + (g.rx - k) * Math.cos(a), g.cy + (g.ry - k) * Math.sin(a))
    ctx.stroke()
  }
  // the orbit the agents travel on
  ctx.strokeStyle = rgba(FG, 0.05)
  ctx.lineWidth = g.u
  ctx.beginPath()
  ctx.ellipse(g.cx, g.cy, g.ox, g.oy, 0, 0, TAU)
  ctx.stroke()
  ctx.restore()
  text(ctx, 'WORKBENCH', g.cx, g.cy + g.ry - 11 * g.u, { font: `600 ${Math.round(9 * g.u)}px ${FONT_UI}`, color: MUTED, align: 'center', alpha: 0.4 })
}

// ---- tags, sparks, ripples --------------------------------------------------------------------------------------

function drawTags(ctx, view, T) {
  const g = view.geom
  ctx.font = tagFont(g)
  for (const tag of liveTags(view.store.list, T, tagLabel)) {
    const ev = tag.ev
    const color = ev.err ? ERROR_COLOR : KIND_COLORS[ev.kind] ?? KIND_COLORS.other
    const label = tag.n > 1 ? `${tag.text} ×${tag.n}` : tag.text
    const w = ctx.measureText(label).width
    const a = ev.a
    const p = ringPoint(g, a)
    const cos = Math.cos(a)
    const sin = Math.sin(a)
    const align = cos > 0.3 ? 'left' : cos < -0.3 ? 'right' : 'center'
    let x = cos > 0.3 ? p.x + g.gap : cos < -0.3 ? p.x - g.gap : p.x
    const ty = p.y + (sin > 0.3 ? g.gap * 1.25 : sin < -0.3 ? -g.gap * 0.55 : g.tagH * 0.3)
    const left = align === 'left' ? x : align === 'right' ? x - w : x - w / 2
    if (left < 6) x += 6 - left
    else if (left + w > g.w - 6) x -= left + w - (g.w - 6)
    // a bead on the ring and the name beside it
    glow(ctx, p.x, p.y, 7 * g.u, color, 0.55 * tag.alpha)
    ctx.fillStyle = rgba(color, 0.95 * tag.alpha)
    ctx.beginPath()
    ctx.arc(p.x, p.y, 2.2 * g.u, 0, TAU)
    ctx.fill()
    text(ctx, label, x, ty, { font: tagFont(g), color: FG, align, alpha: 0.92 * tag.alpha })
  }
}

function pointOnCurve(p0, p1, p2, u) {
  const k = 1 - u
  return { x: k * k * p0.x + 2 * k * u * p1.x + u * u * p2.x, y: k * k * p0.y + 2 * k * u * p1.y + u * u * p2.y }
}

function drawSparks(ctx, view, T) {
  const g = view.geom
  const list = view.store.list
  for (let i = list.length - 1; i >= 0; i--) {
    const ev = list[i]
    const age = T - ev.t
    if (age > SPARK_MS + RIPPLE_MS + 200) break
    if (age < 0) continue
    const from = ev.loop === MAIN ? { x: g.cx, y: g.cy } : view.nodes.get(ev.loop)
    if (from === undefined) continue
    const color = ev.err ? ERROR_COLOR : KIND_COLORS[ev.kind] ?? KIND_COLORS.other
    if (ev.kind === 'lane') {
      const k = age / RIPPLE_MS
      if (k <= 1) {
        ctx.strokeStyle = rgba(color, (1 - k) * 0.7)
        ctx.lineWidth = 1.6 * g.u
        ctx.beginPath()
        ctx.arc(from.x, from.y, (ev.loop === MAIN ? g.coreR : from.r) + (6 + 20 * easeOut(k)) * g.u, 0, TAU)
        ctx.stroke()
      }
      continue
    }
    let to
    if (ev.kind === 'spawn') {
      const child = view.nodes.get(ev.target)
      if (child === undefined) continue
      to = child
    } else if (ev.a !== null) to = ringPoint(g, ev.a)
    else continue
    if (view.isReduced) continue
    const flying = age <= SPARK_MS
    const d = Math.hypot(to.x - from.x, to.y - from.y)
    const sign = hashStr(ev.key) % 2 === 0 ? 1 : -1
    const nx = (-(to.y - from.y) / (d || 1)) * d * 0.17 * sign
    const ny = ((to.x - from.x) / (d || 1)) * d * 0.17 * sign
    const p1 = { x: (from.x + to.x) / 2 + nx, y: (from.y + to.y) / 2 + ny }
    if (flying) {
      const u = easeInOut(age / SPARK_MS)
      ctx.lineCap = 'round'
      for (let s = 0; s < TRAIL_STEPS; s++) {
        const u0 = Math.max(0, u - TRAIL_SPAN * ((s + 1) / TRAIL_STEPS))
        const u1 = Math.max(0, u - TRAIL_SPAN * (s / TRAIL_STEPS))
        const a = pointOnCurve(from, p1, to, u0)
        const b = pointOnCurve(from, p1, to, u1)
        const fade = 1 - s / TRAIL_STEPS
        ctx.strokeStyle = rgba(color, 0.7 * fade * fade)
        ctx.lineWidth = (0.6 + 2.4 * fade) * g.u
        ctx.beginPath()
        ctx.moveTo(a.x, a.y)
        ctx.lineTo(b.x, b.y)
        ctx.stroke()
      }
      const head = pointOnCurve(from, p1, to, u)
      glow(ctx, head.x, head.y, 11 * g.u, color, 0.85)
      ctx.fillStyle = rgba('#ffffff', 0.95)
      ctx.beginPath()
      ctx.arc(head.x, head.y, 1.7 * g.u, 0, TAU)
      ctx.fill()
    } else if (ev.kind !== 'spawn') {
      // landed: a ripple on the ring and a brighter stretch of the track
      const k = (age - SPARK_MS) / RIPPLE_MS
      if (k > 1) continue
      ctx.strokeStyle = rgba(color, (1 - k) * 0.75)
      ctx.lineWidth = 1.5 * g.u
      ctx.beginPath()
      ctx.arc(to.x, to.y, (3 + 24 * easeOut(k)) * g.u, 0, TAU)
      ctx.stroke()
      ctx.strokeStyle = rgba(color, (1 - k) * 0.85)
      ctx.lineWidth = 2.6 * g.u
      ctx.beginPath()
      ctx.ellipse(g.cx, g.cy, g.rx, g.ry, 0, ev.a - 0.075, ev.a + 0.075)
      ctx.stroke()
    } else {
      const k = (age - SPARK_MS) / RIPPLE_MS
      if (k > 1) continue
      ctx.strokeStyle = rgba(color, (1 - k) * 0.8)
      ctx.lineWidth = 2 * g.u
      ctx.beginPath()
      ctx.arc(to.x, to.y, to.r + (4 + 28 * easeOut(k)) * g.u, 0, TAU)
      ctx.stroke()
    }
  }
}

// ---- nodes ------------------------------------------------------------------------------------------------------

function laneColor(lane, base) {
  return lane.state === 'working' ? base : STATE_COLORS[lane.state] ?? base
}

/** Lane rails around a node: one concentric arc per lane, filled by its percentage. */
function drawArcs(ctx, view, x, y, r0, lanes, base, alpha, now) {
  const g = view.geom
  lanes.forEach((lane, k) => {
    const r = r0 + (7 + k * 6.5) * g.u
    const color = laneColor(lane, base)
    const pct = view.laneShown.get(lane.id) ?? 0
    ctx.lineCap = 'round'
    ctx.strokeStyle = rgba(FG, 0.12 * alpha)
    ctx.lineWidth = 2.2 * g.u
    ctx.beginPath()
    ctx.arc(x, y, r, 0, TAU)
    ctx.stroke()
    let start = -Math.PI / 2
    let end = start + TAU * clamp(pct, 0, 1)
    const isOpen = (lane.pct === null || lane.pct === undefined) && lane.state !== 'done'
    if (isOpen) {
      start = view.isReduced ? start : start + (now / 1000) * 2.2
      end = start + 1.25
    }
    let pulse = 1
    if (lane.state === 'blocked' && !view.isReduced) pulse = 0.6 + 0.4 * Math.sin(now / 160)
    if (lane.state === 'waiting' && !view.isReduced) pulse = 0.65 + 0.35 * Math.sin(now / 520)
    if (end - start < 0.02) return
    for (const pass of [0, 1]) {
      ctx.setLineDash(lane.state === 'waiting' ? [3 * g.u, 4 * g.u] : [])
      ctx.strokeStyle = rgba(color, (pass === 0 ? 0.22 : 0.95) * alpha * pulse)
      ctx.lineWidth = (pass === 0 ? 5.5 : 2.4) * g.u
      ctx.beginPath()
      ctx.arc(x, y, r, start, end)
      ctx.stroke()
    }
    ctx.setLineDash([])
    if (lane.state !== 'done') {
      const hx = x + Math.cos(end) * r
      const hy = y + Math.sin(end) * r
      glow(ctx, hx, hy, 7 * g.u, color, 0.7 * alpha * pulse)
    }
  })
}

function nodeText(ctx, view, node) {
  const g = view.geom
  const ux = Math.cos(node.a)
  const uy = Math.sin(node.a)
  const lanes = node.lanes.length
  const out = node.r + (7 + lanes * 6.5 + 7) * g.u
  const align = Math.abs(ux) < 0.3 ? 'center' : ux > 0 ? 'left' : 'right'
  let x = node.x + (Math.abs(ux) < 0.3 ? 0 : Math.sign(ux) * out)
  let y = node.y + (Math.abs(ux) < 0.3 ? Math.sign(uy || 1) * (out + 4 * g.u) : -2 * g.u)
  const alpha = node.vis * node.appear
  const lane = node.lanes[0]
  const name = shortName(nodeLabel(node), LABEL_CHARS)
  const line = shortName(nodeLine(node), LINE_CHARS)
  const fontA = `600 ${Math.round(12.5 * g.u)}px ${FONT_UI}`
  const fontB = `${Math.round(11 * g.u)}px ${FONT_UI}`
  ctx.font = fontA
  const wMax = Math.max(ctx.measureText(name).width, (ctx.font = fontB, ctx.measureText(line).width))
  const left = align === 'left' ? x : align === 'right' ? x - wMax : x - wMax / 2
  if (left < 8) x += 8 - left
  else if (left + wMax > g.w - 8) x -= left + wMax - (g.w - 8)
  if (y < g.headerH) y = g.headerH
  text(ctx, name, x, y, { font: fontA, color: FG, align, alpha: 0.96 * alpha })
  if (lane !== undefined && lane.pct !== null && lane.pct !== undefined) {
    ctx.font = fontA
    const dx = align === 'left' ? ctx.measureText(name).width + 7 * g.u : align === 'right' ? -ctx.measureText(name).width - 7 * g.u : 0
    if (align !== 'center') text(ctx, `${Math.round(lane.pct)}%`, x + dx, y, { font: `${Math.round(11 * g.u)}px ${FONT_MONO}`, color: laneColor(lane, node.color), align, alpha: 0.9 * alpha })
  }
  if (line !== '') text(ctx, line, x, y + 14 * g.u, { font: fontB, color: lane === undefined ? MUTED : laneColor(lane, MUTED), align, alpha: 0.8 * alpha })
}

function drawNode(ctx, view, node, now) {
  const g = view.geom
  const alpha = node.vis * node.appear
  if (alpha <= 0.01 || node.r <= 0.3) return
  const color = node.color
  const running = node.loop.status === 'running'
  // tether to the core
  const mx = (node.x + g.cx) / 2 - (node.y - g.cy) * 0.1
  const my = (node.y + g.cy) / 2 + (node.x - g.cx) * 0.1
  ctx.strokeStyle = rgba(color, (0.07 + 0.3 * node.act) * alpha)
  ctx.lineWidth = (1 + node.act) * g.u
  ctx.beginPath()
  ctx.moveTo(g.cx, g.cy)
  ctx.quadraticCurveTo(mx, my, node.x, node.y)
  ctx.stroke()
  // glow and body
  ctx.globalCompositeOperation = 'lighter'
  glow(ctx, node.x, node.y, node.r * (3.2 + 2.2 * node.act), color, (0.3 + 0.35 * node.act) * alpha)
  ctx.globalCompositeOperation = 'source-over'
  const body = ctx.createRadialGradient(node.x - node.r * 0.3, node.y - node.r * 0.35, node.r * 0.1, node.x, node.y, node.r)
  body.addColorStop(0, rgba('#ffffff', 0.95 * alpha))
  body.addColorStop(0.45, rgba(color, 0.95 * alpha))
  body.addColorStop(1, rgba(color, 0.7 * alpha))
  ctx.fillStyle = body
  ctx.beginPath()
  ctx.arc(node.x, node.y, node.r, 0, TAU)
  ctx.fill()
  // a thin ring: spinning while it works, whole green when done
  ctx.lineWidth = 1.2 * g.u
  if (node.loop.status === 'done') {
    ctx.strokeStyle = rgba(STATE_COLORS.done, 0.8 * alpha)
    ctx.beginPath()
    ctx.arc(node.x, node.y, node.r + 3.2 * g.u, 0, TAU)
    ctx.stroke()
  } else if (running && !view.isReduced) {
    ctx.strokeStyle = rgba(FG, 0.5 * alpha)
    ctx.beginPath()
    const s = (now / 1000) * 3 + node.a
    ctx.arc(node.x, node.y, node.r + 3.2 * g.u, s, s + 1.6)
    ctx.stroke()
  } else {
    ctx.strokeStyle = rgba(FG, 0.22 * alpha)
    ctx.beginPath()
    ctx.arc(node.x, node.y, node.r + 3.2 * g.u, 0, TAU)
    ctx.stroke()
  }
  drawArcs(ctx, view, node.x, node.y, node.r + 3.2 * g.u, node.lanes, color, alpha, now)
  nodeText(ctx, view, node)
}

// ---- the core ---------------------------------------------------------------------------------------------------

function drawCore(ctx, view, now) {
  const g = view.geom
  const data = view.data
  const running = data !== null && data.session !== undefined && data.session.turn === 'running'
  const act = view.main.act
  const breath = view.isReduced ? 0 : Math.sin(((now / 1000) * TAU) / (running ? 1.9 : 5))
  const R = g.coreR * (1 + (running ? 0.07 : 0.045) * breath + 0.12 * act)
  ctx.globalCompositeOperation = 'lighter'
  glow(ctx, g.cx, g.cy, R * 5.5, MAIN_COLOR, 0.17 + 0.2 * act + (running ? 0.07 : 0) + 0.03 * breath)
  glow(ctx, g.cx, g.cy, R * 2.6, MAIN_COLOR, 0.34 + 0.25 * act)
  ctx.globalCompositeOperation = 'source-over'
  // slow instrument ring
  ctx.save()
  ctx.strokeStyle = rgba(FG, 0.16)
  ctx.lineWidth = g.u
  ctx.setLineDash([2 * g.u, 6 * g.u])
  ctx.lineDashOffset = view.isReduced ? 0 : (running ? now / 40 : now / 140)
  ctx.beginPath()
  ctx.arc(g.cx, g.cy, R * 1.5, 0, TAU)
  ctx.stroke()
  ctx.restore()
  const body = ctx.createRadialGradient(g.cx - R * 0.32, g.cy - R * 0.4, R * 0.08, g.cx, g.cy, R)
  body.addColorStop(0, '#f4f8ff')
  body.addColorStop(0.5, '#a9c1ff')
  body.addColorStop(1, '#6a8ef0')
  ctx.fillStyle = body
  ctx.beginPath()
  ctx.arc(g.cx, g.cy, R, 0, TAU)
  ctx.fill()
  ctx.strokeStyle = rgba('#ffffff', 0.55)
  ctx.lineWidth = 1.2 * g.u
  ctx.stroke()
  drawArcs(ctx, view, g.cx, g.cy, R, view.main.lanes, MAIN_COLOR, 1, now)
  const below = g.cy + R + (view.main.lanes.length * 6.5 + 22) * g.u
  const lane = view.main.lanes[0]
  text(ctx, lane !== undefined && lane.label !== '' ? shortName(lane.label, LABEL_CHARS) : 'main', g.cx, below, { font: `600 ${Math.round(12.5 * g.u)}px ${FONT_UI}`, align: 'center', alpha: 0.92 })
  const sub = lane !== undefined && lane.step !== '' ? shortName(lane.step, LINE_CHARS) : view.mainLine ?? ''
  if (sub !== '') text(ctx, sub, g.cx, below + 14 * g.u, { font: `${Math.round(11 * g.u)}px ${FONT_UI}`, color: MUTED, align: 'center', alpha: 0.8 })
}

// ---- foot: free lanes and the last minute ----------------------------------------------------------------------

function drawRails(ctx, view, now) {
  const g = view.geom
  const rows = view.free.slice(-RAILS_MAX)
  const w = Math.min(210 * g.u, g.w * 0.26)
  const rowH = 42 * g.u
  const x = 30 * g.u
  const bottom = g.h - g.footH - 4 * g.u
  rows.forEach((lane, i) => {
    const y = bottom - (rows.length - 1 - i) * rowH
    const color = laneColor(lane, MAIN_COLOR)
    const pct = view.laneShown.get(lane.id) ?? 0
    text(ctx, shortName(lane.label || lane.id, 24), x, y - 9 * g.u, { font: `600 ${Math.round(12 * g.u)}px ${FONT_UI}`, alpha: 0.95 })
    if (lane.pct !== null && lane.pct !== undefined) text(ctx, `${Math.round(lane.pct)}%`, x + w, y - 9 * g.u, { font: `${Math.round(11 * g.u)}px ${FONT_MONO}`, color, align: 'right', alpha: 0.9 })
    ctx.lineCap = 'round'
    ctx.strokeStyle = rgba(FG, 0.12)
    ctx.lineWidth = 2.4 * g.u
    ctx.beginPath()
    ctx.moveTo(x, y)
    ctx.lineTo(x + w, y)
    ctx.stroke()
    const isOpen = (lane.pct === null || lane.pct === undefined) && lane.state !== 'done'
    let a = 0
    let b = pct
    if (isOpen) {
      const k = view.isReduced ? 0.2 : (now / 1700) % 1
      a = k * 1.15 - 0.15
      b = a + 0.25
    }
    a = clamp(a, 0, 1)
    b = clamp(b, 0, 1)
    if (b - a > 0.002) {
      for (const pass of [0, 1]) {
        ctx.strokeStyle = rgba(color, pass === 0 ? 0.25 : 0.95)
        ctx.lineWidth = (pass === 0 ? 6 : 2.4) * g.u
        ctx.beginPath()
        ctx.moveTo(x + w * a, y)
        ctx.lineTo(x + w * b, y)
        ctx.stroke()
      }
      glow(ctx, x + w * b, y, 8 * g.u, color, 0.6)
    }
    const step = lane.state === 'working' ? lane.step : `${lane.state}${lane.step !== '' ? ' · ' + lane.step : ''}`
    if (step !== '') text(ctx, shortName(step, 34), x, y + 13 * g.u, { font: `${Math.round(10.5 * g.u)}px ${FONT_UI}`, color: lane.state === 'working' ? MUTED : color, alpha: 0.8 })
  })
  if (view.free.length > RAILS_MAX)
    text(ctx, `+${view.free.length - RAILS_MAX} more`, x, bottom - RAILS_MAX * rowH + 4 * g.u, { font: `${Math.round(10.5 * g.u)}px ${FONT_UI}`, color: MUTED, alpha: 0.7 })
}

function drawTimeline(ctx, view, T, now) {
  const { x0, x1, yBase, hMax } = view.geom.tl
  const g = view.geom
  const span = x1 - x0
  ctx.strokeStyle = rgba(FG, 0.16)
  ctx.lineWidth = g.u
  ctx.beginPath()
  ctx.moveTo(x0, yBase + 0.5)
  ctx.lineTo(x1, yBase + 0.5)
  ctx.stroke()
  for (let i = 0; i <= 6; i++) {
    const x = x0 + (span * i) / 6
    ctx.beginPath()
    ctx.moveTo(x, yBase + 1)
    ctx.lineTo(x, yBase + 4.5 * g.u)
    ctx.stroke()
  }
  const bins = timelineBins(view.store.list, T)
  const biggest = bins.reduce((m, b) => Math.max(m, b.total), 0)
  view.tlScale += (Math.max(4, biggest) - view.tlScale) * 0.08
  const barW = Math.max(1.5, (span * BIN_MS) / TIMELINE_MS - 1.6 * g.u)
  const t0 = T - TIMELINE_MS
  for (const bin of bins) {
    const xa = x0 + ((bin.start - t0) / TIMELINE_MS) * span
    const xb = Math.min(x1, xa + barW)
    if (xb <= x0) continue
    const xs = Math.max(x0, xa)
    const edge = clamp((xa - x0) / (span * 0.08), 0.15, 1)
    let top = yBase - 2 * g.u
    const total = Math.min(1, bin.total / view.tlScale) * hMax
    for (const kind of BAR_ORDER) {
      const n = bin.kinds[kind]
      if (n === undefined) continue
      const h = Math.max(1.6 * g.u, (n / bin.total) * total)
      ctx.fillStyle = rgba(kind === 'error' ? ERROR_COLOR : KIND_COLORS[kind] ?? KIND_COLORS.other, 0.88 * edge)
      ctx.fillRect(xs, top - h, Math.max(1, xb - xs), h)
      top -= h
    }
  }
  const quiet = bins.length === 0
  glow(ctx, x1, yBase, 9 * g.u, MAIN_COLOR, quiet ? 0.3 : 0.7)
  text(ctx, 'last minute', x0, yBase + 17 * g.u, { font: `${Math.round(10 * g.u)}px ${FONT_UI}`, color: MUTED, alpha: 0.65 })
  text(ctx, 'now', x1, yBase + 17 * g.u, { font: `${Math.round(10 * g.u)}px ${FONT_UI}`, color: MUTED, align: 'right', alpha: 0.65 })
}

function drawCaption(ctx, view) {
  const g = view.geom
  const data = view.data
  let message = ''
  if (data === null) message = 'Waiting for the first pulse…'
  else if ((data.totals?.calls ?? 0) === 0 && (data.lanes ?? []).length === 0) message = 'Quiet. Tool calls, agents and lanes show up here as they happen.'
  if (message === '') return
  text(ctx, message, g.cx, g.cy + g.coreR * 2.2 + 26 * g.u, { font: `${Math.round(13 * g.u)}px ${FONT_UI}`, color: MUTED, align: 'center', alpha: 0.75 })
}

/** One frame. `T` is the display clock, `now` the page clock in ms. */
export function drawFrame(ctx, view, T, now) {
  const g = view.geom
  ctx.clearRect(0, 0, g.w, g.h)
  drawBackdrop(ctx, view, now)
  drawWorkbench(ctx, view, T, now)
  drawTags(ctx, view, T)
  const nodes = view.shownNodes ?? []
  for (const node of nodes) drawNode(ctx, view, node, now)
  drawSparks(ctx, view, T)
  drawCore(ctx, view, now)
  drawRails(ctx, view, now)
  drawTimeline(ctx, view, T, now)
  drawCaption(ctx, view)
}
