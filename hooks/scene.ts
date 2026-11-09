// Pure validation and merge logic of the `scene` tool. No `$`, no I/O: the
// checks that need the file system live in ./scene-fs.ts behind a small
// interface, so both halves are tested directly. Every refusal throws `Invalid`
// with a message that names the field and says how to fix it.
import type { PanelScene, PanelState } from '../types'
import { Invalid, isAbsent, isPlain } from './blocks/common'
import type { Plain } from './blocks/common'
import { cellWidth, clean } from './layout-text'
import { dataText, inlineFiles, inlineHtml, sourceOf } from './scene-inline'
import type { InlineSource } from './scene-inline'

export const SCENE_CAPS = {
  SCENES: 6,
  ID_CHARS: 24,
  ID_PATTERN: /^[a-z0-9-]{1,24}$/,
  TITLE_CHARS: 60,
  ALT_CHARS: 300,
  HEIGHT_MIN: 120,
  HEIGHT_MAX: 1200,
  HEIGHT_DEFAULT: 420,
  SPAN_DEFAULT: 3,
  ART_LINES: 24,
  ART_COLS: 100,
  IMAGE_BYTES: 2 * 1024 * 1024, // the engine's own limit for an Image's bytes
  PATH_CHARS: 1024,
  ENTRY_CHARS: 200,
  STAGE_SCENES: 6, // each stage scene is a tile of the workspace; equals SCENES, so the scene cap fires first. Built-ins are not counted
  SHOT_AT_PATTERN: /^#[A-Za-z0-9/._-]{0,40}$/,
  SHOT_AT_CHARS: 41, // `#` + 40
} as const

export const SCENE_SPANS = [1, 2, 3] as const
export const SCENE_LAYOUTS = ['card', 'stage'] as const
/** Where a scene sits in the workspace: `big` first, `side` last, `auto` (default) in publish order. */
export const SCENE_SLOTS = ['big', 'side', 'auto'] as const
export const DEFAULT_SLOT = 'auto'
export const DEFAULT_LAYOUT = 'card'
export const STAGE_LAYOUT = 'stage'
export const DEFAULT_ENTRY = 'index.html'
export const IMAGE_EXTENSION = '.png'
export const PATH_SEP = '/'
const NUL = '\u0000'

const UPSERT_KEYS = [
  'id', 'dir', 'entry', 'title', 'alt', 'span', 'height', 'pin', 'layout', 'slot', 'term', 'shot', 'shot_at', 'html', 'files', 'data',
] as const
const TERM_KEYS = ['art', 'image'] as const
const REMOVE_KEY = 'remove'
const CLEAR_KEY = 'clear'
const GOTO_KEY = 'goto'
const DATA_KEY = 'data'

/** What a validated `scene` call asks for. */
export type SceneDraft = Omit<PanelScene, 'rev'>
/** The screenshot options of an upsert: asked for per call, never stored in the state. */
export type ShotAsk = { isWanted: boolean; at: string }
export type SceneAction =
  /**
   * `inline` (html / files): the mod writes the folder first, `scene.dir` is '' until then. `data`: the
   * serialized JSON to seed live/data.json with before the screenshot.
   */
  | { kind: 'upsert'; scene: SceneDraft; shot: ShotAsk; inline?: InlineSource; data?: string }
  /** `{ id, data }`: write live/data.json of an existing scene. Changes no state. */
  | { kind: 'data'; id: string; text: string }
  | { kind: 'remove'; id: string }
  | { kind: 'clear' }
  /** `{ id, goto }`: move the live terminal view of that scene to a location hash. Changes no state. */
  | { kind: 'goto'; id: string; hash: string }

export type SceneOutcome =
  | { isOk: true; state: PanelState; line: string }
  | { isOk: false; error: string }

// Paths. Scene folders are absolute POSIX paths (the CLI runs on macOS / Linux).
export const isAbsolutePath = (p: string): boolean => p.startsWith(PATH_SEP)
export const withSep = (p: string): string => (p.endsWith(PATH_SEP) ? p : p + PATH_SEP)
export const hasParentSegment = (p: string): boolean => p.split(/[\\/]+/).includes('..')
/** `child` lies strictly inside `root` (compared with a trailing separator, so `/tmpx` is not in `/tmp`). */
export const isInside = (child: string, root: string): boolean =>
  root !== PATH_SEP && child.startsWith(withSep(root)) && child.length > withSep(root).length
export const joinPath = (dir: string, rel: string): string => withSep(dir) + rel

/** `scene.id` -> `id`, `scene.term.art` -> `term.art`: the name a message shows. */
const field = (name: string): string => `scene.${name}`

function sceneId(v: unknown, name: string): string {
  if (typeof v !== 'string' || !SCENE_CAPS.ID_PATTERN.test(v))
    throw new Invalid(
      `${field(name)} ${JSON.stringify(v)} is invalid: use 1-${SCENE_CAPS.ID_CHARS} characters from a-z, 0-9 and "-" (for example "cpu-chart")`,
    )
  return v
}

/** An absolute path with no `..` segment, as the model must spell `dir` and `term.image`. */
function absolutePath(v: unknown, name: string, hint: string): string {
  if (typeof v !== 'string' || v === '')
    throw new Invalid(`${field(name)} is required: ${hint}`)
  if (v.length > SCENE_CAPS.PATH_CHARS || v.includes(NUL))
    throw new Invalid(`${field(name)} is not a usable path (at most ${SCENE_CAPS.PATH_CHARS} characters, no NUL)`)
  if (!isAbsolutePath(v))
    throw new Invalid(
      `${field(name)} "${v}" must be an absolute path, but it is relative: build it from the project directory or the scratchpad directory`,
    )
  if (hasParentSegment(v))
    throw new Invalid(`${field(name)} "${v}" must not contain ".." segments: give the resolved absolute path`)
  return v
}

/** The page inside the scene folder: relative, no `..`, no leading `/`, no dotfile segment. */
function entryPath(v: unknown): string {
  if (isAbsent(v)) return DEFAULT_ENTRY
  const bad = (why: string): Invalid =>
    new Invalid(
      `${field('entry')} ${JSON.stringify(v)} ${why}: use a plain relative path inside the folder, like "${DEFAULT_ENTRY}" or "pages/main.html"`,
    )
  if (typeof v !== 'string' || v === '') throw bad('must be a non-empty string')
  if (v.length > SCENE_CAPS.ENTRY_CHARS || v.includes(NUL)) throw bad('is too long or holds a NUL')
  if (isAbsolutePath(v)) throw bad('must not start with "/"')
  if (v.includes('\\')) throw bad('must use "/" separators')
  if (hasParentSegment(v)) throw bad('must not contain ".." segments')
  if (v.split(PATH_SEP).some(s => s.startsWith('.') || s === ''))
    throw bad('must not have a dotfile, "./" or empty segment')
  return v
}

function textField(v: unknown, name: string, max: number, hint: string): string {
  if (typeof v !== 'string' || v.trim() === '')
    throw new Invalid(`${field(name)} is required: ${hint}`)
  const out = v.trim()
  if (out.length > max)
    throw new Invalid(`${field(name)} is ${out.length} characters; the limit is ${max}: shorten it`)
  return out
}

/** The optional title: whitespace-only counts as none. */
function titleOf(v: unknown): string {
  if (isAbsent(v)) return ''
  if (typeof v !== 'string') throw new Invalid(`${field('title')} must be a string`)
  const out = v.trim()
  if (out.length > SCENE_CAPS.TITLE_CHARS)
    throw new Invalid(`${field('title')} is ${out.length} characters; the limit is ${SCENE_CAPS.TITLE_CHARS}: shorten it`)
  return out
}

function height(v: unknown): number {
  if (isAbsent(v)) return SCENE_CAPS.HEIGHT_DEFAULT
  if (!Number.isInteger(v) || (v as number) < SCENE_CAPS.HEIGHT_MIN || (v as number) > SCENE_CAPS.HEIGHT_MAX)
    throw new Invalid(
      `${field('height')} ${JSON.stringify(v)} must be a whole number of pixels from ${SCENE_CAPS.HEIGHT_MIN} to ${SCENE_CAPS.HEIGHT_MAX} (default ${SCENE_CAPS.HEIGHT_DEFAULT})`,
    )
  return v as number
}

function span(v: unknown): PanelScene['span'] {
  if (isAbsent(v)) return SCENE_CAPS.SPAN_DEFAULT
  if (!(SCENE_SPANS as readonly unknown[]).includes(v))
    throw new Invalid(`${field('span')} ${JSON.stringify(v)} must be one of ${SCENE_SPANS.join(', ')} (columns of the 3-column grid)`)
  return v as PanelScene['span']
}

/** `term.art`: an array of plain lines, at most ART_LINES x ART_COLS cells. */
function artLines(v: unknown): string[] {
  const name = 'term.art'
  if (!Array.isArray(v))
    throw new Invalid(`${field(name)} must be an array of strings, one per line of the picture`)
  if (v.length > SCENE_CAPS.ART_LINES)
    throw new Invalid(`${field(name)} has ${v.length} lines; the limit is ${SCENE_CAPS.ART_LINES}: draw it smaller`)
  return v.map((line, i) => {
    if (typeof line !== 'string') throw new Invalid(`${field(name)}[${i}] must be a string`)
    if (/[\r\n]/.test(line)) throw new Invalid(`${field(name)}[${i}] must be a single line: put each line in its own array item`)
    const cells = cellWidth(clean(line))
    if (cells > SCENE_CAPS.ART_COLS)
      throw new Invalid(`${field(name)}[${i}] is ${cells} columns wide; the limit is ${SCENE_CAPS.ART_COLS}: draw it narrower`)
    return line
  })
}

function layoutOf(v: unknown): NonNullable<PanelScene['layout']> {
  if (isAbsent(v)) return DEFAULT_LAYOUT
  if (!(SCENE_LAYOUTS as readonly unknown[]).includes(v))
    throw new Invalid(`${field('layout')} ${JSON.stringify(v)} must be one of ${SCENE_LAYOUTS.join(', ')}`)
  return v as NonNullable<PanelScene['layout']>
}

function slotOf(v: unknown): NonNullable<PanelScene['slot']> {
  if (isAbsent(v)) return DEFAULT_SLOT
  if (!(SCENE_SLOTS as readonly unknown[]).includes(v))
    throw new Invalid(`${field('slot')} ${JSON.stringify(v)} must be one of ${SCENE_SLOTS.join(', ')}`)
  return v as NonNullable<PanelScene['slot']>
}

/** A location hash such as `#/3`, as `shot_at` and `goto` take it. */
function hashOf(v: unknown, name: string): string {
  if (typeof v !== 'string' || !SCENE_CAPS.SHOT_AT_PATTERN.test(v))
    throw new Invalid(
      `${field(name)} ${JSON.stringify(v)} is invalid: use a location hash such as "#/3" (a "#" and up to 40 of A-Z a-z 0-9 / . _ -)`,
    )
  return v
}

/** `shot` (default true) and `shot_at` (default none) are about this call only. */
function shotOf(input: Plain): ShotAsk {
  if (!isAbsent(input.shot) && typeof input.shot !== 'boolean')
    throw new Invalid(`${field('shot')} must be true or false`)
  const at = input.shot_at
  if (isAbsent(at)) return { isWanted: input.shot !== false, at: '' }
  return { isWanted: input.shot !== false, at: hashOf(at, 'shot_at') }
}

function term(v: unknown): PanelScene['term'] {
  if (isAbsent(v)) return undefined
  if (!isPlain(v)) throw new Invalid(`${field('term')} must be an object {art?, image?}`)
  for (const key of Object.keys(v))
    if (!(TERM_KEYS as readonly string[]).includes(key))
      throw new Invalid(`${field(`term.${key}`)} is not a known field (allowed: ${TERM_KEYS.join(', ')})`)
  const out: NonNullable<PanelScene['term']> = {}
  if (!isAbsent(v.art)) out.art = artLines(v.art)
  if (!isAbsent(v.image)) {
    const image = absolutePath(v.image, 'term.image', 'the absolute path of a .png file')
    if (!image.toLowerCase().endsWith(IMAGE_EXTENSION))
      throw new Invalid(`${field('term.image')} "${image}" must be a ${IMAGE_EXTENSION} file`)
    out.image = image
  }
  return out.art === undefined && out.image === undefined ? undefined : out
}

/** The upsert fields, checked as far as no file system is needed. */
function draftOf(input: Plain): { scene: SceneDraft; shot: ShotAsk; inline?: InlineSource; data?: string } {
  for (const key of Object.keys(input))
    if (!(UPSERT_KEYS as readonly string[]).includes(key))
      throw new Invalid(
        `${field(key)} is not a known field (to publish: ${UPSERT_KEYS.join(', ')}; or send only "${REMOVE_KEY}" or only "${CLEAR_KEY}")`,
      )
  const t = term(input.term)
  const title = titleOf(input.title)
  if (!isAbsent(input.pin) && typeof input.pin !== 'boolean')
    throw new Invalid(`${field('pin')} must be true or false`)
  const source = sourceOf(input)
  if (source === 'html' && !isAbsent(input.entry))
    throw new Invalid(`${field('entry')} goes with files, not html (html is always written as index.html): drop entry, or send files`)
  const entry = entryPath(input.entry)
  const inline: InlineSource | undefined =
    source === 'html' ? inlineHtml(textOf(input.html, 'html')) : source === 'files' ? inlineFiles(input.files, entry) : undefined
  const scene: SceneDraft = {
    id: sceneId(input.id, 'id'),
    ...(title === '' ? {} : { title }),
    dir: inline === undefined ? absolutePath(input.dir, 'dir', "the absolute path of the folder that holds the scene's files") : '',
    entry: inline === undefined ? entry : inline.entry,
    span: span(input.span),
    height: height(input.height),
    ...(input.pin === true ? { pin: true } : {}),
    layout: layoutOf(input.layout),
    ...(isAbsent(input.slot) ? {} : { slot: slotOf(input.slot) }),
    alt: textField(
      input.alt,
      'alt',
      SCENE_CAPS.ALT_CHARS,
      `one plain sentence (at most ${SCENE_CAPS.ALT_CHARS} characters) saying what the scene shows; the terminal and screen readers use it`,
    ),
    ...(t === undefined ? {} : { term: t }),
  }
  return {
    scene,
    shot: shotOf(input),
    ...(inline === undefined ? {} : { inline }),
    ...(input[DATA_KEY] === undefined ? {} : { data: dataText(input[DATA_KEY]) }),
  }
}

function textOf(v: unknown, name: string): string {
  if (typeof v !== 'string') throw new Invalid(`${field(name)} must be a string (the page's HTML)`)
  return v
}

/**
 * What one `scene` call asks for: upsert (the default), `{ remove: id }` or
 * `{ clear: true }`. Throws `Invalid` naming the field.
 */
export function parseSceneInput(input: unknown): SceneAction {
  if (!isPlain(input)) throw new Invalid('input must be an object')
  const given = Object.keys(input).filter(k => !isAbsent(input[k]))
  const alone = (key: string): void => {
    if (given.some(k => k !== key))
      throw new Invalid(`${field(key)} cannot be combined with other fields: send it alone`)
  }
  if (input[CLEAR_KEY] !== undefined && input[CLEAR_KEY] !== null && typeof input[CLEAR_KEY] !== 'boolean')
    throw new Invalid(`${field(CLEAR_KEY)} must be true`)
  if (input[CLEAR_KEY] === true) {
    alone(CLEAR_KEY)
    return { kind: 'clear' }
  }
  if (!isAbsent(input[REMOVE_KEY])) {
    alone(REMOVE_KEY)
    return { kind: 'remove', id: sceneId(input[REMOVE_KEY], REMOVE_KEY) }
  }
  if (input[DATA_KEY] === null) dataText(null) // throws: null is not data
  if (input[DATA_KEY] !== undefined && given.every(k => k === DATA_KEY || k === 'id'))
    return { kind: 'data', id: sceneId(input.id, 'id'), text: dataText(input[DATA_KEY]) }
  if (!isAbsent(input[GOTO_KEY])) {
    if (given.some(k => k !== GOTO_KEY && k !== 'id'))
      throw new Invalid(`${field(GOTO_KEY)} cannot be combined with other fields: send only {"id": ..., "goto": "#/2"}`)
    return { kind: 'goto', id: sceneId(input.id, 'id'), hash: hashOf(input[GOTO_KEY], GOTO_KEY) }
  }
  const rest = Object.fromEntries(Object.entries(input).filter(([k]) => k !== CLEAR_KEY && k !== REMOVE_KEY))
  return { kind: 'upsert', ...draftOf(rest) }
}

/** `scene <id> rev N · <url>s/<id>/` (the url ends with `/`; none until the server is up). */
export function sceneResultLine(scene: PanelScene, url: string | null): string {
  const head = `scene ${scene.id} rev ${scene.rev}`
  return url === null ? head : `${head} · ${sceneUrl(url, scene.id)}`
}

export const sceneUrl = (url: string, id: string): string => `${withSep(url)}s/${id}/`

const listOf = (scenes: readonly PanelScene[]): string =>
  scenes.length === 0 ? 'none' : scenes.map(s => s.id).join(', ')

/**
 * Apply a validated action. An upsert keeps the scene's place and bumps its
 * `rev` (a new one starts at 1 and is appended); every change bumps the state's
 * `rev`, so the pane and the browser redraw.
 */
export function applyScene(prev: PanelState, action: SceneAction, now: number): SceneOutcome {
  const scenes = Array.isArray(prev.scenes) ? prev.scenes : []
  const stamp = (next: PanelScene[]): PanelState => ({
    ...prev,
    scenes: next,
    rev: prev.rev + 1,
    updatedAt: now,
  })
  if (action.kind === 'goto' || action.kind === 'data') return { isOk: true, state: prev, line: '' } // not state: the live view and live/data.json are the mod's
  if (action.kind === 'clear')
    return { isOk: true, state: stamp([]), line: `scenes cleared (${scenes.length} removed)` }
  if (action.kind === 'remove') {
    if (!scenes.some(s => s.id === action.id))
      return { isOk: true, state: prev, line: `no scene "${action.id}" to remove; scenes: ${listOf(scenes)}` }
    const left = scenes.filter(s => s.id !== action.id)
    return { isOk: true, state: stamp(left), line: `scene ${action.id} removed; scenes: ${listOf(left)}` }
  }
  const at = scenes.findIndex(s => s.id === action.scene.id)
  if (at < 0 && scenes.length >= SCENE_CAPS.SCENES)
    return {
      isOk: false,
      error:
        `scene: already ${SCENE_CAPS.SCENES} scenes (${listOf(scenes)}): remove one with {"remove":"<id>"} ` +
        `(or reuse one of those ids to replace it) before adding "${action.scene.id}"`,
    }
  const stages = scenes.filter(s => s.layout === STAGE_LAYOUT && s.id !== action.scene.id)
  if (action.scene.layout === STAGE_LAYOUT && stages.length >= SCENE_CAPS.STAGE_SCENES)
    return {
      isOk: false,
      error:
        `scene.layout: already ${SCENE_CAPS.STAGE_SCENES} stage scenes (${listOf(stages)}): remove one with {"remove":"<id>"}, ` +
        `or publish "${action.scene.id}" with layout "card"`,
    }
  const scene: PanelScene = { ...action.scene, rev: at < 0 ? 1 : (scenes[at]?.rev ?? 0) + 1 }
  const next = at < 0 ? [...scenes, scene] : scenes.map((s, i) => (i === at ? scene : s))
  const state = stamp(next)
  return { isOk: true, state, line: sceneResultLine(scene, state.url) }
}

/**
 * The screenshot as the scene's terminal face, when it has none of its own. A changed `term.image`
 * is the ONLY change: no `rev` bump (neither the scene's nor the state's), so the browser does not
 * reload. Only for the revision that was shot (`rev`), so a republish in between is not touched.
 */
export function withShotFace(prev: PanelState, id: string, rev: number, png: string): PanelState {
  const scenes = Array.isArray(prev.scenes) ? prev.scenes : []
  const hit = scenes.find(s => s.id === id)
  if (hit === undefined || hit.rev !== rev || hit.term?.image !== undefined) return prev
  return { ...prev, scenes: scenes.map(s => (s === hit ? { ...s, term: { ...s.term, image: png } } : s)) }
}
