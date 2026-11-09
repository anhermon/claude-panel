// Terminal faces of the scenes: per scene `▣ title`, then ONE face (its PNG
// through the Image element, else its plain-text art, else its alt text), then
// a dim `↗ /panel open <id>` line. Pure, no `$`.
import type { PanelScene } from '../types'
import { imageBox } from './png'
import { COLOR, GLYPH, LIVE_KEY, LIVE_KEY_PREFIX, LIVE_STEPS, OPEN_COMMAND } from './layout-types'
import type { Faces, ImageSeg, Line, LiveFace, Outlines } from './layout-types'
import { cellWidth, fit, hang, plain, str } from './layout-text'
import { STAGE_LAYOUT } from './scene'

const BLANK_ROW: Line = [{ text: '' }]

/** `image.rows` lines: the picture on the first, blank placeholders under it. */
export function pictureLines(image: ImageSeg): Line[] {
  return [[{ text: '', image }], ...Array.from({ length: image.rows - 1 }, () => BLANK_ROW)]
}

const LIVE_LABELS = { prev: GLYPH.PREV, next: GLYPH.NEXT } as const
/** The live view's slide buttons, one row: `[ ◀ ]  [ ▶ ]`. */
const controlsLine = (): Line =>
  LIVE_STEPS.flatMap((step, i) => [
    ...(i === 0 ? [] : [{ text: '  ' }]),
    { text: `[ ${LIVE_LABELS[step]} ]`, button: { key: `${LIVE_KEY_PREFIX}${step}`, label: LIVE_LABELS[step] } },
  ])

/** One scene's face: the live frame, else the readable picture, else the art, else the alt text. */
export function faceLines(scene: PanelScene, width: number, faces: Faces, live?: LiveFace): Line[] {
  const alt = str(scene.alt) || scene.id
  if (live?.sceneId === scene.id) {
    const { columns, rows } = imageBox({ width: live.width, height: live.height }, width)
    return pictureLines({ png: '', columns, rows, alt, key: LIVE_KEY, file: live.file, generation: live.generation })
  }
  const picture = faces.get(scene.id)
  if (picture !== undefined) {
    const { columns, rows } = imageBox({ width: picture.width, height: picture.height }, width)
    return pictureLines({ png: picture.png, columns, rows, alt })
  }
  const art = Array.isArray(scene.term?.art) ? (scene.term?.art as unknown[]).map(l => str(l)) : []
  if (art.some(l => l.trim() !== '')) return art.map((l): Line => [{ text: fit(l, width), isDim: true }])
  return plain(str(scene.alt), width)
}

/** A stage scene's slide titles, numbered and dim (one hanging line each). */
const outlineLines = (titles: readonly string[], width: number): Line[] =>
  titles.flatMap((t, i) => hang({ text: `${i + 1}. `, isDim: true }, t, width, { isDim: true }))

/**
 * The lines of one scene (title, face, open hint), none wider than `width` cells. A stage scene
 * adds its slide outline (when its page names slides) and says `stage` in the hint.
 */
export function sceneLines(scene: PanelScene, width: number, faces: Faces, outlines?: Outlines, live?: LiveFace): Line[] {
  const mark = `${GLYPH.SCENE} `
  const title = str(scene.title).trim() || str(scene.id)
  const isStage = scene.layout === STAGE_LAYOUT
  const hint = `${GLYPH.OPEN} ${isStage ? `${GLYPH.STAGE}${GLYPH.SEP}` : ''}${OPEN_COMMAND} ${str(scene.id)}`
  return [
    [
      { text: mark, color: COLOR.ACCENT },
      { text: fit(title, Math.max(1, width - cellWidth(mark))), isBold: true },
    ],
    ...faceLines(scene, width, faces, live),
    ...(live?.sceneId === scene.id ? [controlsLine()] : []),
    ...(isStage ? outlineLines(outlines?.get(scene.id) ?? [], width) : []),
    [{ text: fit(hint, width), isDim: true }],
  ]
}

// A state written by older or hand-edited code may hold anything: only a record with an id is drawn.
const isDrawable = (s: unknown): s is PanelScene =>
  typeof s === 'object' && s !== null && typeof (s as PanelScene).id === 'string' && (s as PanelScene).id !== ''

/** Pinned scenes first, each group in the order given (the browser orders them the same way). */
export function orderedScenes(scenes: readonly PanelScene[], exceptId?: string): { pinned: PanelScene[]; loose: PanelScene[] } {
  const list = (Array.isArray(scenes) ? scenes : []).filter(s => isDrawable(s) && s.builtin !== true && s.id !== exceptId)
  return { pinned: list.filter(s => s.pin === true), loose: list.filter(s => s.pin !== true) }
}
