// The board's frame validator: ONE `frame` (what the model sends with `panel {frame}`) in, one validated BoardFrame
// out. Pure: no `$`, no I/O. Every refusal throws `Invalid` with a message that names the field (`frame.items[2].label`)
// and says the cap; an over-cap value is refused, never cut (a chart label that loses its end would change what the
// chart says). Unknown keys are refused with the field named. The shape is the `BoardFrame` type in types/index.d.ts.
import { validateVizData } from './viz-schema'
import type { BoardFrame, BoardFrameType } from '../types'
import { Invalid, isAbsent, isPlain } from './blocks/common'
import type { Plain } from './blocks/common'
import { ROUTER_CAPS, ROUTER_STAGES } from './router-state'
import { INSIGHT_KINDS } from './work-kinds'
import { VIZ_KIND_TABLE as vizKindTable, VIZ_SCHEMAS } from './viz-kinds'

export const FRAME_CAPS = {
  ID_PATTERN: /^[a-z0-9-]{1,24}$/,
  ID_CHARS: 24,
  TITLE_CHARS: 40,
  TEXT_CHARS: 90,
  SUB_CHARS: 120,
  METRIC_VALUE_CHARS: 12,
  METRIC_LABEL_CHARS: 40,
  METRIC_DELTA_CHARS: 12,
  SPARK_POINTS: 24,
  RINGS_ITEMS: 4,
  RING_LABEL_CHARS: 16,
  PCT_MIN: 0,
  PCT_MAX: 100,
  BARS_ITEMS: 8,
  BAR_LABEL_CHARS: 24,
  BARS_UNIT_CHARS: 8,
  LINE_SERIES: 3,
  LINE_LABEL_CHARS: 24,
  LINE_POINTS: 60,
  STEPS_ITEMS: 6,
  STEP_CHARS: 48,
  DIAGRAM_NODES: 10,
  NODE_ID_PATTERN: /^[a-z0-9-]{1,16}$/,
  NODE_ID_CHARS: 16,
  NODE_LABEL_CHARS: 24,
  DIAGRAM_EDGES: 14,
  EDGE_LABEL_CHARS: 16,
  TIMELINE_ITEMS: 6,
  TIMELINE_WHEN_CHARS: 12,
  TIMELINE_TEXT_CHARS: 48,
  COMPARE_ITEMS: 4,
  COMPARE_TITLE_CHARS: 24,
  COMPARE_ITEM_CHARS: 40,
  SAY_CHARS: 80,
  ASK_Q_CHARS: 120,
  ASK_OPTIONS: 4,
  ASK_OPTION_CHARS: 32,
  IMAGE_SRC_CHARS: 200 * 1024,
  IMAGE_PATH_CHARS: 200,
  CAPTION_CHARS: 60,
  HTML_CHARS: 8192,
  UML_CODE_CHARS: 4096,
  UML_HIGHLIGHT_ITEMS: 24,
  UML_ID_PATTERN: /^[A-Za-z0-9_-]{1,40}$/,
  UML_ID_CHARS: 40,
  SWIMLANE_ITEMS: 8,
  SWIMLANE_SEGS: 48,
  SWIMLANE_LABEL_CHARS: 24,
  INSIGHT_CAPTION_CHARS: 160,
  INSIGHT_FOOT_CHARS: 70,
  INSIGHT_LABEL_CHARS: 28,
  INSIGHT_TEXT_CHARS: 140,
  KINDSTACK_ITEMS: 8,
  KINDSTACK_SEGS: 12,
  SINKS_ITEMS: 6,
  INSIGHT_NOTES: 4,
  REPEAT_COLS: 5,
  REPEAT_ROWS: 5,
  HINTS_ITEMS: 4,
  TICKETS_ITEMS: 12,
  TICKET_ID_CHARS: 24,
  TICKET_TITLE_CHARS: 60,
  TICKET_AGENT_CHARS: 24,
  TICKET_NOTE_CHARS: 120,
  TICKET_DEPENDS: 6,
  TICKET_EVAL_WHAT_CHARS: 60,
  TICKET_EVAL_EVIDENCE_CHARS: 120,
  TICKET_ROUNDS_MAX: 20,
  CHECKS_ITEMS: 12,
  CHECK_ITEM_CHARS: 80,
  CHECK_EVIDENCE_CHARS: 140,
  VIZ_DATA_CHARS: 12288,
  VIZ_DEPTH: 8,
  VIZ_CAPTION_CHARS: 120,
  COLOR_PATTERN: /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/,
} as const

export const FRAME_TYPES: readonly BoardFrameType[] = [
  'text', 'now', 'metric', 'rings', 'bars', 'line', 'steps', 'diagram', 'timeline', 'compare', 'avatar', 'ask', 'lanes', 'pulse', 'image', 'html', 'uml', 'doing', 'swimlane', 'kindstack', 'sinks', 'repeats', 'hints', 'viz', 'tickets', 'checks',
]
/** The asset kinds a `viz` frame can draw (hooks/viz-kinds.ts, generated from the asset registry by scripts/gen-viz-kinds.mjs). */
export const VIZ_KINDS: readonly string[] = Object.keys(vizKindTable)
/** `kind(field,field)` for every asset: the tool description lists them so one call can post any of them. */
export const VIZ_SIGNATURES: string = Object.entries(vizKindTable).map(([kind, v]) => `${kind}(${v.keys.join(',')})`).join(' ')
export const FRAME_SIZES = ['s', 'm', 'l', 'xl'] as const
export const FRAME_TONES = ['info', 'ok', 'warn', 'danger'] as const
export const FRAME_STATUSES = ['working', 'waiting', 'blocked', 'done'] as const
export const STEP_STATES = ['todo', 'doing', 'done', 'failed'] as const
export const UML_STATES = ['active', 'done', 'blocked', 'todo'] as const
export const SWIMLANE_STATES = ['working', 'waiting', 'done'] as const
export const MOODS = ['idle', 'thinking', 'working', 'happy', 'alert', 'sleepy'] as const

const COMMON_KEYS = ['id', 'type', 'title', 'size'] as const
const LIST_JOIN = ', '
const DATA_IMAGE_PREFIX = 'data:image/'
const SCHEME = /^[a-z][a-z0-9+.-]*:/i
const IMAGE_PATH = /^[A-Za-z0-9_][A-Za-z0-9_./-]*$/

type Build = (o: Plain, at: string) => Record<string, unknown>
type Spec = { keys: readonly string[]; build: Build }

// ---- field helpers --------------------------------------------------------------------------------------------------

const fix = (what: string): string => `: ${what}`

/** A required, non-empty string of at most `max` characters (whitespace-trimmed). */
function text(v: unknown, path: string, max: number, hint = 'shorten it'): string {
  if (typeof v !== 'string') throw new Invalid(`${path} must be a string of at most ${max} characters`)
  const out = v.trim()
  if (out === '') throw new Invalid(`${path} must not be empty`)
  if (out.length > max) throw new Invalid(`${path} is ${out.length} characters; the limit is ${max}${fix(hint)}`)
  return out
}

/** An optional string: absent gives undefined. */
function optText(v: unknown, path: string, max: number): string | undefined {
  if (isAbsent(v) || (typeof v === 'string' && v.trim() === '')) return undefined
  return text(v, path, max)
}

function oneOf<T extends string>(v: unknown, path: string, allowed: readonly T[]): T {
  if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v))
    throw new Invalid(`${path} ${JSON.stringify(v)} must be one of ${allowed.join(LIST_JOIN)}`)
  return v as T
}

function finite(v: unknown, path: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Invalid(`${path} ${JSON.stringify(v)} must be a finite number`)
  return v
}

function list(v: unknown, path: string, max: number, min = 1): unknown[] {
  if (!Array.isArray(v)) throw new Invalid(`${path} must be an array of at most ${max} items`)
  if (v.length > max) throw new Invalid(`${path} has ${v.length} items; the limit is ${max}${fix('keep the ones that matter most')}`)
  if (v.length < min) throw new Invalid(`${path} needs at least ${min} item${min === 1 ? '' : 's'}`)
  return v
}

function numbers(v: unknown, path: string, max: number, min: number): number[] {
  return list(v, path, max, min).map((n, i) => finite(n, `${path}[${i}]`))
}

/** `v` as an object holding only `allowed` keys; an unknown key names its path. */
function item(v: unknown, path: string, allowed: readonly string[]): Plain {
  if (!isPlain(v)) throw new Invalid(`${path} must be an object {${allowed.join(LIST_JOIN)}}`)
  for (const key of Object.keys(v))
    if (!allowed.includes(key)) throw new Invalid(`${path}.${key} is not a known field (allowed: ${allowed.join(LIST_JOIN)})`)
  return v
}

function color(v: unknown, path: string): string | undefined {
  if (isAbsent(v)) return undefined
  if (typeof v !== 'string' || !FRAME_CAPS.COLOR_PATTERN.test(v)) throw new Invalid(`${path} ${JSON.stringify(v)} must be a #hex color such as "#4ade80"`)
  return v
}

const tone = (v: unknown, path: string): (typeof FRAME_TONES)[number] | undefined => (isAbsent(v) ? undefined : oneOf(v, path, FRAME_TONES))

/** `{k: v}` without the undefined values (the JSON stays small and the type exact). */
function defined<T extends Record<string, unknown>>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T
}

// ---- the per-type builders -----------------------------------------------------------------------------------------

const buildText: Build = (o, at) =>
  defined({ text: text(o.text, `${at}.text`, FRAME_CAPS.TEXT_CHARS, 'one idea, one short line'), sub: optText(o.sub, `${at}.sub`, FRAME_CAPS.SUB_CHARS) })

const buildNow: Build = (o, at) =>
  defined({
    text: optText(o.text, `${at}.text`, FRAME_CAPS.TEXT_CHARS),
    status: isAbsent(o.status) ? undefined : oneOf(o.status, `${at}.status`, FRAME_STATUSES),
    sub: optText(o.sub, `${at}.sub`, FRAME_CAPS.SUB_CHARS),
    who: optText(o.who, `${at}.who`, FRAME_CAPS.SUB_CHARS),
    for: optText(o.for, `${at}.for`, FRAME_CAPS.SUB_CHARS),
    last: optText(o.last, `${at}.last`, FRAME_CAPS.SUB_CHARS),
  })

function metricValue(v: unknown, path: string): string | number {
  if (typeof v === 'number') {
    finite(v, path)
    const shown = String(v)
    if (shown.length > FRAME_CAPS.METRIC_VALUE_CHARS)
      throw new Invalid(`${path} ${shown} is ${shown.length} characters; the limit is ${FRAME_CAPS.METRIC_VALUE_CHARS}: round it or send it as a short string like "1.2M"`)
    return v
  }
  return text(v, path, FRAME_CAPS.METRIC_VALUE_CHARS, 'send a short string like "1.2M"')
}

const buildMetric: Build = (o, at) =>
  defined({
    value: metricValue(o.value, `${at}.value`),
    label: optText(o.label, `${at}.label`, FRAME_CAPS.METRIC_LABEL_CHARS),
    delta: optText(o.delta, `${at}.delta`, FRAME_CAPS.METRIC_DELTA_CHARS),
    tone: tone(o.tone, `${at}.tone`),
    spark: isAbsent(o.spark) ? undefined : numbers(o.spark, `${at}.spark`, FRAME_CAPS.SPARK_POINTS, 2),
  })

const buildRings: Build = (o, at) => ({
  items: list(o.items, `${at}.items`, FRAME_CAPS.RINGS_ITEMS).map((raw, i) => {
    const p = `${at}.items[${i}]`
    const r = item(raw, p, ['label', 'pct', 'color'])
    const pct = finite(r.pct, `${p}.pct`)
    if (pct < FRAME_CAPS.PCT_MIN || pct > FRAME_CAPS.PCT_MAX)
      throw new Invalid(`${p}.pct ${pct} must be from ${FRAME_CAPS.PCT_MIN} to ${FRAME_CAPS.PCT_MAX}`)
    return defined({ label: text(r.label, `${p}.label`, FRAME_CAPS.RING_LABEL_CHARS), pct, color: color(r.color, `${p}.color`) })
  }),
})

const buildBars: Build = (o, at) =>
  defined({
    items: list(o.items, `${at}.items`, FRAME_CAPS.BARS_ITEMS).map((raw, i) => {
      const p = `${at}.items[${i}]`
      const r = item(raw, p, ['label', 'value', 'color'])
      return defined({ label: text(r.label, `${p}.label`, FRAME_CAPS.BAR_LABEL_CHARS), value: finite(r.value, `${p}.value`), color: color(r.color, `${p}.color`) })
    }),
    unit: optText(o.unit, `${at}.unit`, FRAME_CAPS.BARS_UNIT_CHARS),
  })

const buildLine: Build = (o, at) => ({
  series: list(o.series, `${at}.series`, FRAME_CAPS.LINE_SERIES).map((raw, i) => {
    const p = `${at}.series[${i}]`
    const r = item(raw, p, ['label', 'points'])
    return { label: text(r.label, `${p}.label`, FRAME_CAPS.LINE_LABEL_CHARS), points: numbers(r.points, `${p}.points`, FRAME_CAPS.LINE_POINTS, 2) }
  }),
})

const buildSteps: Build = (o, at) =>
  defined({
    items: list(o.items, `${at}.items`, FRAME_CAPS.STEPS_ITEMS).map((raw, i) => {
      const p = `${at}.items[${i}]`
      const r = item(raw, p, ['t', 'state'])
      return { t: text(r.t, `${p}.t`, FRAME_CAPS.STEP_CHARS), state: oneOf(r.state, `${p}.state`, STEP_STATES) }
    }),
    owner: optText(o.owner, `${at}.owner`, FRAME_CAPS.TITLE_CHARS),
    since: optText(o.since, `${at}.since`, FRAME_CAPS.SUB_CHARS),
  })

function nodeId(v: unknown, path: string): string {
  if (typeof v !== 'string' || !FRAME_CAPS.NODE_ID_PATTERN.test(v))
    throw new Invalid(`${path} ${JSON.stringify(v)} is invalid: use 1-${FRAME_CAPS.NODE_ID_CHARS} characters from a-z, 0-9 and "-" (for example "cache")`)
  return v
}

function buildDiagram(o: Plain, at: string): Record<string, unknown> {
  const seen = new Set<string>()
  const nodes = list(o.nodes, `${at}.nodes`, FRAME_CAPS.DIAGRAM_NODES).map((raw, i) => {
    const p = `${at}.nodes[${i}]`
    const r = item(raw, p, ['id', 'label', 'tone'])
    const id = nodeId(r.id, `${p}.id`)
    if (seen.has(id)) throw new Invalid(`${p}.id "${id}" is used twice: give each node its own id`)
    seen.add(id)
    return defined({ id, label: text(r.label, `${p}.label`, FRAME_CAPS.NODE_LABEL_CHARS), tone: tone(r.tone, `${p}.tone`) })
  })
  const edges = (isAbsent(o.edges) ? [] : list(o.edges, `${at}.edges`, FRAME_CAPS.DIAGRAM_EDGES, 0)).map((raw, i) => {
    const p = `${at}.edges[${i}]`
    const r = item(raw, p, ['from', 'to', 'label'])
    const ends = (['from', 'to'] as const).map(end => {
      const id = nodeId(r[end], `${p}.${end}`)
      if (!seen.has(id)) throw new Invalid(`${p}.${end} "${id}" is not a node of this diagram (nodes: ${[...seen].join(LIST_JOIN)})`)
      return id
    })
    return defined({ from: ends[0], to: ends[1], label: optText(r.label, `${p}.label`, FRAME_CAPS.EDGE_LABEL_CHARS) })
  })
  return { nodes, edges }
}

const buildTimeline: Build = (o, at) => ({
  items: list(o.items, `${at}.items`, FRAME_CAPS.TIMELINE_ITEMS).map((raw, i) => {
    const p = `${at}.items[${i}]`
    const r = item(raw, p, ['when', 'text', 'tone'])
    return defined({
      when: optText(r.when, `${p}.when`, FRAME_CAPS.TIMELINE_WHEN_CHARS),
      text: text(r.text, `${p}.text`, FRAME_CAPS.TIMELINE_TEXT_CHARS),
      tone: tone(r.tone, `${p}.tone`),
    })
  }),
})

function side(v: unknown, path: string): { title: string; items: string[] } {
  const r = item(v, path, ['title', 'items'])
  return {
    title: text(r.title, `${path}.title`, FRAME_CAPS.COMPARE_TITLE_CHARS),
    items: list(r.items, `${path}.items`, FRAME_CAPS.COMPARE_ITEMS).map((t, i) => text(t, `${path}.items[${i}]`, FRAME_CAPS.COMPARE_ITEM_CHARS)),
  }
}

const buildCompare: Build = (o, at) => ({ left: side(o.left, `${at}.left`), right: side(o.right, `${at}.right`) })

const buildAvatar: Build = (o, at) =>
  defined({ mood: oneOf(o.mood, `${at}.mood`, MOODS), say: optText(o.say, `${at}.say`, FRAME_CAPS.SAY_CHARS) })

const buildAsk: Build = (o, at) => ({
  q: text(o.q, `${at}.q`, FRAME_CAPS.ASK_Q_CHARS),
  options: list(o.options, `${at}.options`, FRAME_CAPS.ASK_OPTIONS).map((t, i) => text(t, `${at}.options[${i}]`, FRAME_CAPS.ASK_OPTION_CHARS)),
})

const buildNothing: Build = () => ({})

/** A data:image URL, or a plain relative path in the scene folder (no scheme, no `..`, no dotfile, no leading `/`). */
function imageSrc(v: unknown, path: string): string {
  if (typeof v !== 'string' || v === '') throw new Invalid(`${path} must be a string: a relative path in the scene folder or a data:image URL`)
  if (v.startsWith(DATA_IMAGE_PREFIX)) {
    if (v.length > FRAME_CAPS.IMAGE_SRC_CHARS)
      throw new Invalid(`${path} is ${v.length} characters; the limit is ${FRAME_CAPS.IMAGE_SRC_CHARS} (200 KB): shrink the image`)
    return v
  }
  if (SCHEME.test(v) || v.startsWith('//'))
    throw new Invalid(`${path} must not be a URL (no http, no other scheme): use a relative path or a data:image URL`)
  if (v.length > FRAME_CAPS.IMAGE_PATH_CHARS) throw new Invalid(`${path} is ${v.length} characters; the limit is ${FRAME_CAPS.IMAGE_PATH_CHARS} for a path`)
  if (!IMAGE_PATH.test(v) || v.split('/').some(s => s === '' || s.startsWith('.')))
    throw new Invalid(`${path} ${JSON.stringify(v)} must be a plain relative path (no leading "/", no "..", no dotfile segment)`)
  return v
}

const buildImage: Build = (o, at) =>
  defined({ src: imageSrc(o.src, `${at}.src`), caption: optText(o.caption, `${at}.caption`, FRAME_CAPS.CAPTION_CHARS) })

const buildHtml: Build = (o, at) => ({ html: text(o.html, `${at}.html`, FRAME_CAPS.HTML_CHARS, 'send less markup, or publish a scene instead') })

/** `highlight`: {mermaid node id: active|done|blocked|todo}; the ids are the ones written in `code` (a participant, a flowchart node, a state). */
function umlHighlight(v: unknown, path: string): Record<string, (typeof UML_STATES)[number]> | undefined {
  if (isAbsent(v)) return undefined
  if (!isPlain(v)) throw new Invalid(`${path} must be an object {nodeId: ${UML_STATES.join('|')}}`)
  const entries = Object.entries(v)
  if (entries.length > FRAME_CAPS.UML_HIGHLIGHT_ITEMS)
    throw new Invalid(`${path} has ${entries.length} entries; the limit is ${FRAME_CAPS.UML_HIGHLIGHT_ITEMS}${fix('highlight only the nodes that matter')}`)
  return Object.fromEntries(
    entries.map(([id, state]) => {
      if (!FRAME_CAPS.UML_ID_PATTERN.test(id))
        throw new Invalid(`${path}.${id} is not a node id: use 1-${FRAME_CAPS.UML_ID_CHARS} characters from A-Z, a-z, 0-9, "_" and "-" (the id written in the code)`)
      return [id, oneOf(state, `${path}.${id}`, UML_STATES)]
    }),
  )
}

const buildUml: Build = (o, at) =>
  defined({
    code: text(o.code, `${at}.code`, FRAME_CAPS.UML_CODE_CHARS, 'a few lines of Mermaid (sequenceDiagram, flowchart, stateDiagram-v2, classDiagram, erDiagram, mindmap, timeline, gantt); split it or drop detail'),
    highlight: umlHighlight(o.highlight, `${at}.highlight`),
  })

/** A time in whole seconds from the start of the session: finite, not negative. */
const seconds = (v: unknown, path: string): number => Math.max(0, Math.round(finite(v, path)))

const buildSwimlane: Build = (o, at) => ({
  items: list(o.items, `${at}.items`, FRAME_CAPS.SWIMLANE_ITEMS).map((raw, i) => {
    const p = `${at}.items[${i}]`
    const r = item(raw, p, ['label', 'state', 'from', 'to', 'segs'])
    return {
      label: text(r.label, `${p}.label`, FRAME_CAPS.SWIMLANE_LABEL_CHARS),
      state: oneOf(r.state, `${p}.state`, SWIMLANE_STATES),
      from: seconds(r.from, `${p}.from`),
      to: seconds(r.to, `${p}.to`),
      segs: list(r.segs, `${p}.segs`, FRAME_CAPS.SWIMLANE_SEGS, 0).map((s, j) => {
        const sp = `${p}.segs[${j}]`
        const seg = item(s, sp, ['k', 'a', 'b'])
        return { k: oneOf(seg.k, `${sp}.k`, INSIGHT_KINDS), a: seconds(seg.a, `${sp}.a`), b: seconds(seg.b, `${sp}.b`) }
      }),
    }
  }),
})

// ---- the workflow-insight frames (hooks/insight-*.ts draw them; a frame of the same id from the model replaces them) ----------

const caption = (o: Plain, at: string): string | undefined => optText(o.caption, `${at}.caption`, FRAME_CAPS.INSIGHT_CAPTION_CHARS)
const foot = (o: Plain, at: string): string | undefined => optText(o.foot, `${at}.foot`, FRAME_CAPS.INSIGHT_FOOT_CHARS)
const notesOf = (v: unknown, path: string): string[] | undefined =>
  isAbsent(v) ? undefined : list(v, path, FRAME_CAPS.INSIGHT_NOTES, 0).map((t, i) => text(t, `${path}[${i}]`, FRAME_CAPS.INSIGHT_TEXT_CHARS))
/** A count: a finite, not negative number, rounded. */
const count = (v: unknown, path: string): number => Math.max(0, Math.round(finite(v, path)))

const buildKindStack: Build = (o, at) =>
  defined({
    caption: caption(o, at),
    foot: foot(o, at),
    items: list(o.items, `${at}.items`, FRAME_CAPS.KINDSTACK_ITEMS).map((raw, i) => {
      const p = `${at}.items[${i}]`
      const r = item(raw, p, ['label', 'total', 'tokens', 'segs'])
      return defined({
        label: text(r.label, `${p}.label`, FRAME_CAPS.INSIGHT_LABEL_CHARS),
        total: text(r.total, `${p}.total`, FRAME_CAPS.INSIGHT_LABEL_CHARS, 'a duration in words such as "3 min 20 s"'),
        tokens: optText(r.tokens, `${p}.tokens`, FRAME_CAPS.INSIGHT_LABEL_CHARS),
        segs: list(r.segs, `${p}.segs`, FRAME_CAPS.KINDSTACK_SEGS).map((s, j) => {
          const sp = `${p}.segs[${j}]`
          const seg = item(s, sp, ['k', 's', 'text'])
          return { k: oneOf(seg.k, `${sp}.k`, INSIGHT_KINDS), s: seconds(seg.s, `${sp}.s`), text: text(seg.text, `${sp}.text`, FRAME_CAPS.INSIGHT_LABEL_CHARS) }
        }),
      })
    }),
  })

const buildSinks: Build = (o, at) =>
  defined({
    caption: caption(o, at),
    foot: foot(o, at),
    items: list(o.items, `${at}.items`, FRAME_CAPS.SINKS_ITEMS).map((raw, i) => {
      const p = `${at}.items[${i}]`
      const r = item(raw, p, ['k', 'pct', 'text', 'time', 'meta'])
      const pct = finite(r.pct, `${p}.pct`)
      if (pct < FRAME_CAPS.PCT_MIN || pct > FRAME_CAPS.PCT_MAX) throw new Invalid(`${p}.pct ${pct} must be from ${FRAME_CAPS.PCT_MIN} to ${FRAME_CAPS.PCT_MAX}`)
      return defined({
        k: oneOf(r.k, `${p}.k`, INSIGHT_KINDS),
        pct: Math.round(pct),
        text: text(r.text, `${p}.text`, FRAME_CAPS.INSIGHT_TEXT_CHARS),
        time: optText(r.time, `${p}.time`, FRAME_CAPS.INSIGHT_LABEL_CHARS),
        meta: optText(r.meta, `${p}.meta`, FRAME_CAPS.INSIGHT_LABEL_CHARS),
      })
    }),
    notes: notesOf(o.notes, `${at}.notes`),
  })

function buildRepeats(o: Plain, at: string): Record<string, unknown> {
  const cols = (isAbsent(o.cols) ? [] : list(o.cols, `${at}.cols`, FRAME_CAPS.REPEAT_COLS, 0)).map((c, i) => text(c, `${at}.cols[${i}]`, FRAME_CAPS.INSIGHT_LABEL_CHARS))
  const rows = (isAbsent(o.rows) ? [] : list(o.rows, `${at}.rows`, FRAME_CAPS.REPEAT_ROWS, 0)).map((raw, i) => {
    const p = `${at}.rows[${i}]`
    const r = item(raw, p, ['label', 'cells', 'note'])
    const cells = list(r.cells, `${p}.cells`, FRAME_CAPS.REPEAT_COLS, 0).map((n, j) => count(n, `${p}.cells[${j}]`))
    if (cells.length !== cols.length) throw new Invalid(`${p}.cells has ${cells.length} numbers; give one per column (${cols.length})`)
    return defined({ label: text(r.label, `${p}.label`, FRAME_CAPS.INSIGHT_LABEL_CHARS), cells, note: optText(r.note, `${p}.note`, FRAME_CAPS.INSIGHT_LABEL_CHARS) })
  })
  const notes = notesOf(o.notes, `${at}.notes`)
  if (rows.length === 0 && (notes === undefined || notes.length === 0)) throw new Invalid(`${at} needs rows or notes: say what was repeated`)
  return defined({ caption: caption(o, at), foot: foot(o, at), cols, rows, notes })
}

const buildHints: Build = (o, at) =>
  defined({
    caption: caption(o, at),
    foot: foot(o, at),
    items: list(o.items, `${at}.items`, FRAME_CAPS.HINTS_ITEMS).map((raw, i) => {
      const p = `${at}.items[${i}]`
      const r = item(raw, p, ['text', 'evidence', 'rule'])
      return {
        text: text(r.text, `${p}.text`, FRAME_CAPS.INSIGHT_TEXT_CHARS),
        evidence: text(r.evidence, `${p}.evidence`, FRAME_CAPS.INSIGHT_TEXT_CHARS, 'the number that backs the suggestion, with its unit'),
        rule: text(r.rule, `${p}.rule`, FRAME_CAPS.INSIGHT_TEXT_CHARS, 'the rule that fired'),
      }
    }),
  })

// ---- the router-kit frames (hooks/router-frames.ts draws them from `.router/`; a frame of the same id from the model replaces them) ----

const SUMMARY_KEYS = ['total', 'verified', 'unverified', 'blocked', 'inflight'] as const
/** Counts a tickets frame may add (a frame written before them has none). */
const OPTIONAL_SUMMARY_KEYS = ['unproven'] as const
const EVAL_RESULTS = ['pass', 'fail', 'none'] as const

/** The proof of a ticket row: `present` (an eval exists), what it checks, its `result`, one line of `evidence`. */
function evalOf(v: unknown, path: string): Record<string, unknown> {
  const r = item(v, path, ['present', 'what', 'result', 'evidence'])
  if (typeof r.present !== 'boolean') throw new Invalid(`${path}.present must be true or false`)
  return defined({
    present: r.present,
    what: optText(r.what, `${path}.what`, FRAME_CAPS.TICKET_EVAL_WHAT_CHARS),
    result: oneOf(r.result, `${path}.result`, EVAL_RESULTS),
    evidence: optText(r.evidence, `${path}.evidence`, FRAME_CAPS.TICKET_EVAL_EVIDENCE_CHARS),
  })
}
const VERDICTS = ['PASS', 'FAIL'] as const
/** `PASS` / `FAIL`, or null when absent (no verdict yet). */
const verdict = (v: unknown, path: string): (typeof VERDICTS)[number] | null => (isAbsent(v) ? null : oneOf(v, path, VERDICTS))
/** A whole number from 0 to `max`. */
function whole(v: unknown, path: string, max: number): number {
  const n = count(v, path)
  if (n > max) throw new Invalid(`${path} ${n} must be at most ${max}`)
  return n
}

function buildTickets(o: Plain, at: string): Record<string, unknown> {
  const s = item(o.summary, `${at}.summary`, [...SUMMARY_KEYS, ...OPTIONAL_SUMMARY_KEYS])
  return {
    summary: Object.fromEntries([
      ...SUMMARY_KEYS.map(k => [k, count(s[k], `${at}.summary.${k}`)]),
      ...OPTIONAL_SUMMARY_KEYS.filter(k => !isAbsent(s[k])).map(k => [k, count(s[k], `${at}.summary.${k}`)]),
    ]),
    items: list(o.items, `${at}.items`, FRAME_CAPS.TICKETS_ITEMS).map((raw, i) => {
      const p = `${at}.items[${i}]`
      const r = item(raw, p, ['id', 'title', 'stage', 'agent', 'checks', 'round', 'maxRounds', 'verdict', 'note', 'dependsOn', 'eval'])
      const checks = isAbsent(r.checks) ? undefined : item(r.checks, `${p}.checks`, ['pass', 'total'])
      return defined({
        id: text(r.id, `${p}.id`, FRAME_CAPS.TICKET_ID_CHARS),
        title: text(r.title, `${p}.title`, FRAME_CAPS.TICKET_TITLE_CHARS),
        stage: oneOf(r.stage, `${p}.stage`, ROUTER_STAGES),
        agent: optText(r.agent, `${p}.agent`, FRAME_CAPS.TICKET_AGENT_CHARS),
        checks: checks && { pass: count(checks.pass, `${p}.checks.pass`), total: count(checks.total, `${p}.checks.total`) },
        round: isAbsent(r.round) ? undefined : whole(r.round, `${p}.round`, FRAME_CAPS.TICKET_ROUNDS_MAX),
        maxRounds: isAbsent(r.maxRounds) ? undefined : whole(r.maxRounds, `${p}.maxRounds`, FRAME_CAPS.TICKET_ROUNDS_MAX),
        verdict: verdict(r.verdict, `${p}.verdict`),
        eval: isAbsent(r.eval) ? undefined : evalOf(r.eval, `${p}.eval`),
        note: optText(r.note, `${p}.note`, FRAME_CAPS.TICKET_NOTE_CHARS),
        dependsOn: isAbsent(r.dependsOn) ? undefined : list(r.dependsOn, `${p}.dependsOn`, FRAME_CAPS.TICKET_DEPENDS, 0).map((d, j) => text(d, `${p}.dependsOn[${j}]`, FRAME_CAPS.TICKET_ID_CHARS)),
      })
    }),
  }
}

const buildChecks: Build = (o, at) => ({
  result: verdict(o.result, `${at}.result`),
  round: isAbsent(o.round) ? 0 : whole(o.round, `${at}.round`, FRAME_CAPS.TICKET_ROUNDS_MAX),
  maxRounds: isAbsent(o.maxRounds) ? ROUTER_CAPS.DEFAULT_MAX_ROUNDS : whole(o.maxRounds, `${at}.maxRounds`, FRAME_CAPS.TICKET_ROUNDS_MAX),
  items: list(o.items, `${at}.items`, FRAME_CAPS.CHECKS_ITEMS).map((raw, i) => {
    const p = `${at}.items[${i}]`
    const r = item(raw, p, ['item', 'pass', 'evidence'])
    if (!isAbsent(r.pass) && typeof r.pass !== 'boolean') throw new Invalid(`${p}.pass ${JSON.stringify(r.pass)} must be true, false or null (not run)`)
    return defined({ item: text(r.item, `${p}.item`, FRAME_CAPS.CHECK_ITEM_CHARS), pass: isAbsent(r.pass) ? null : r.pass, evidence: optText(r.evidence, `${p}.evidence`, FRAME_CAPS.CHECK_EVIDENCE_CHARS) })
  }),
})

/** How deeply `v` nests (arrays and objects); stops counting past `limit`. */
const depthOf = (v: unknown, limit: number): number =>
  v !== null && typeof v === 'object' && limit > 0 ? 1 + Math.max(0, ...Object.values(v).map(x => depthOf(x, limit - 1))) : 0

/** `viz`: a freeform visual asset. `kind` names the asset, `data` is its own schema (checked by the asset when drawn; the frame shows the error). */
function buildViz(o: Plain, at: string): Record<string, unknown> {
  const kind = oneOf(o.kind, `${at}.kind`, VIZ_KINDS)
  if (!isPlain(o.data)) throw new Invalid(`${at}.data must be an object (the fields of the "${kind}" asset: ${JSON.stringify(vizKindTable[kind]?.keys)})`)
  const size = JSON.stringify(o.data).length
  if (size > FRAME_CAPS.VIZ_DATA_CHARS) throw new Invalid(`${at}.data is ${size} characters; the limit is ${FRAME_CAPS.VIZ_DATA_CHARS}: send fewer items or shorter labels`)
  if (depthOf(o.data, FRAME_CAPS.VIZ_DEPTH + 1) > FRAME_CAPS.VIZ_DEPTH) throw new Invalid(`${at}.data nests deeper than ${FRAME_CAPS.VIZ_DEPTH} levels: flatten it`)
  if (VIZ_SCHEMAS[kind]) validateVizData(o.data, VIZ_SCHEMAS[kind], `${at}.data`)
  return defined({ kind, data: o.data, caption: optText(o.caption, `${at}.caption`, FRAME_CAPS.VIZ_CAPTION_CHARS) })
}

const SPECS: Record<BoardFrameType, Spec> = {
  text: { keys: ['text', 'sub'], build: buildText },
  now: { keys: ['text', 'status', 'sub', 'who', 'for', 'last'], build: buildNow },
  metric: { keys: ['value', 'label', 'delta', 'tone', 'spark'], build: buildMetric },
  rings: { keys: ['items'], build: buildRings },
  bars: { keys: ['items', 'unit'], build: buildBars },
  line: { keys: ['series'], build: buildLine },
  steps: { keys: ['items', 'owner', 'since'], build: buildSteps },
  diagram: { keys: ['nodes', 'edges'], build: buildDiagram },
  timeline: { keys: ['items'], build: buildTimeline },
  compare: { keys: ['left', 'right'], build: buildCompare },
  avatar: { keys: ['mood', 'say'], build: buildAvatar },
  ask: { keys: ['q', 'options'], build: buildAsk },
  lanes: { keys: [], build: buildNothing },
  pulse: { keys: [], build: buildNothing },
  image: { keys: ['src', 'caption'], build: buildImage },
  html: { keys: ['html'], build: buildHtml },
  uml: { keys: ['code', 'highlight'], build: buildUml },
  doing: { keys: [], build: buildNothing },
  swimlane: { keys: ['items'], build: buildSwimlane },
  kindstack: { keys: ['caption', 'foot', 'items'], build: buildKindStack },
  sinks: { keys: ['caption', 'foot', 'items', 'notes'], build: buildSinks },
  repeats: { keys: ['caption', 'foot', 'cols', 'rows', 'notes'], build: buildRepeats },
  hints: { keys: ['caption', 'foot', 'items'], build: buildHints },
  viz: { keys: ['kind', 'data', 'caption'], build: buildViz },
  tickets: { keys: ['summary', 'items'], build: buildTickets },
  checks: { keys: ['result', 'round', 'maxRounds', 'items'], build: buildChecks },
}

/** The id of a frame, or of a frame to remove. */
export function frameId(v: unknown, path: string): string {
  if (typeof v !== 'string' || !FRAME_CAPS.ID_PATTERN.test(v))
    throw new Invalid(`${path} ${JSON.stringify(v)} is invalid: use 1-${FRAME_CAPS.ID_CHARS} characters from a-z, 0-9 and "-" (for example "cpu-latency")`)
  return v
}

/** One frame as the model sent it, validated. `path` names the field in a refusal (default `frame`). Throws `Invalid`. */
export function validateFrame(v: unknown, path = 'frame'): BoardFrame {
  if (!isPlain(v)) throw new Invalid(`${path} must be an object {id, type, title?, size?, ...fields of the type}`)
  const type = oneOf(v.type, `${path}.type`, FRAME_TYPES)
  const spec = SPECS[type]
  const allowed = [...COMMON_KEYS, ...spec.keys]
  for (const key of Object.keys(v))
    if (!allowed.includes(key))
      throw new Invalid(`${path}.${key} is not a known field of a "${type}" frame (allowed: ${allowed.join(LIST_JOIN)})`)
  const common = defined({
    id: frameId(v.id, `${path}.id`),
    type,
    title: optText(v.title, `${path}.title`, FRAME_CAPS.TITLE_CHARS),
    size: isAbsent(v.size) ? undefined : oneOf(v.size, `${path}.size`, FRAME_SIZES),
  })
  return { ...common, ...spec.build(v, path) } as BoardFrame
}
