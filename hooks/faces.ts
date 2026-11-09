// Reads what the pane draws from disk: the PNGs of the scenes' terminal faces and the slide outlines of
// the stage scenes' entry pages. A face that cannot
// be read (missing, too big, not a PNG) is simply absent: that scene then shows
// its art or alt text. The cache only saves re-reading a file on every redraw;
// losing it in a hot reload costs nothing.
import type { EngineInterface } from 'claude-code'

import type { PanelScene } from '../types'
import type { Faces, Outlines, SceneImage } from './layout-types'
import { OUTLINE_MAX_BYTES, outlineOf } from './outline'
import { pngSize } from './png'
import { DEFAULT_ENTRY, SCENE_CAPS, STAGE_LAYOUT, isAbsolutePath, joinPath } from './scene'

type Dollar = EngineInterface
type Cached = { stamp: string; face: SceneImage | null }

const cache = new Map<string, Cached>()

async function readFace($: Dollar, path: string): Promise<SceneImage | null> {
  const info = await $.fs.stat(path)
  if (info.kind !== 'file' || info.size > SCENE_CAPS.IMAGE_BYTES) return null
  const stamp = `${info.size}:${info.mtimeMs}`
  const hit = cache.get(path)
  if (hit?.stamp === stamp) return hit.face
  const read = await $.fs.read(path, { as: 'bytes' })
  const size = typeof read === 'string' ? null : pngSize(read.base64)
  const face = size === null || typeof read === 'string' ? null : { png: read.base64, ...size }
  cache.set(path, { stamp, face })
  return face
}

/** The readable terminal pictures by scene id. Never throws. */
export async function loadFaces($: Dollar, scenes: readonly PanelScene[]): Promise<Faces> {
  const faces = new Map<string, SceneImage>()
  for (const scene of Array.isArray(scenes) ? scenes : []) {
    const path = scene.term?.image
    if (typeof path !== 'string') continue
    try {
      const face = await readFace($, path)
      if (face !== null) faces.set(scene.id, face)
    } catch {
      // unreadable: the scene keeps its text face
    }
  }
  return faces
}

type CachedOutline = { stamp: string; titles: string[] }

const outlineCache = new Map<string, CachedOutline>()

async function readOutline($: Dollar, path: string): Promise<string[]> {
  const info = await $.fs.stat(path)
  if (info.kind !== 'file' || info.size > OUTLINE_MAX_BYTES) return []
  const stamp = `${info.size}:${info.mtimeMs}`
  const hit = outlineCache.get(path)
  if (hit?.stamp === stamp) return hit.titles
  const titles = outlineOf(await $.fs.read(path))
  outlineCache.set(path, { stamp, titles })
  return titles
}

/** The slide titles of each stage scene's entry page by scene id (cached by mtime). Never throws. */
export async function loadOutlines($: Dollar, scenes: readonly PanelScene[]): Promise<Outlines> {
  const outlines = new Map<string, readonly string[]>()
  for (const scene of Array.isArray(scenes) ? scenes : []) {
    if (scene.layout !== STAGE_LAYOUT || typeof scene.dir !== 'string' || !isAbsolutePath(scene.dir)) continue
    try {
      const titles = await readOutline($, joinPath(scene.dir, scene.entry ?? DEFAULT_ENTRY))
      if (titles.length > 0) outlines.set(scene.id, titles)
    } catch {
      // unreadable: no outline
    }
  }
  return outlines
}
