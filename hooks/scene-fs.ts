// The file-system half of the `scene` validation. It talks to the disk only
// through `SceneFs` (the mod hands it a `$.fs.stat` adapter; the tests hand it a
// table), so the rules are checked without a file system. Everything is judged
// on REAL paths (symlinks and `..` resolved) with a trailing separator, so
// `/tmpx` is not inside `/tmp` and a symlink cannot lead out of a root.
import { Invalid } from './blocks/common'
import { SCENE_CAPS, hasParentSegment, isInside, joinPath, parseSceneInput } from './scene'
import type { SceneAction } from './scene'
import { SHOT_STATE_DIR } from './shot'

/** What a stat answers; `realPath` is where the path really lands (absent when it leads nowhere). */
export type PathInfo = { kind: 'file' | 'dir' | 'other'; size: number; realPath?: string }
export type SceneFs = { stat: (path: string) => Promise<PathInfo | undefined> }
/** `scenesDir`: where inline (html / files) scenes are written, one folder per scene id (see `inlineScenesDir`). */
export type SceneEnv = { cwd: string; home?: string; scenesDir?: string }
/** What an inline publish writes through (the mod hands it `$.fs` + `mv` / `rm`; the tests hand it a recorder). */
export type SceneIo = {
  /** Replace the folder's content (all but its `live/`) with exactly these files. */
  putFiles: (dir: string, files: Record<string, string>) => Promise<void>
  /** Write `live/data.json` atomically. */
  putData: (dir: string, text: string) => Promise<void>
}

export const INLINE_DIR_NAME = 'scenes'
/** `<tmp>/claude-panel/scenes/<session id>`: the parent of the inline scene folders. */
export const inlineScenesDir = (tmp: string, sessionId: string): string =>
  `${tmp.replace(/\/+$/, '')}/${SHOT_STATE_DIR}/${INLINE_DIR_NAME}/${sessionId}`

// A scene folder must lie inside the session's directory, an OS temp dir or ~/.claude.
export const TEMP_ROOTS = ['/tmp', '/private/tmp', '/var/folders', '/private/var/folders'] as const
export const CLAUDE_DIR_NAME = '.claude'
const ROOT_HINT = 'put the scene folder under the project directory or its scratchpad (or /tmp), then publish again'

/** The allowed roots as spelled (not yet resolved). */
export function allowedRoots(env: SceneEnv): string[] {
  const home = env.home === undefined || env.home === '' ? [] : [joinPath(env.home, CLAUDE_DIR_NAME)]
  return [env.cwd, ...TEMP_ROOTS, ...home]
}

/** The roots as they really are (`/tmp` -> `/private/tmp`), those that exist, each once; never `/`. */
export async function resolveRoots(fs: SceneFs, roots: readonly string[]): Promise<string[]> {
  const real = await Promise.all(roots.map(async r => (await fs.stat(r))?.realPath))
  return [...new Set(real.filter((r): r is string => r !== undefined && r !== '/'))]
}

async function sceneDir(dir: string, roots: readonly string[], fs: SceneFs): Promise<string> {
  const info = await fs.stat(dir)
  if (info === undefined)
    throw new Invalid(`scene.dir "${dir}" does not exist: create the folder and write its files first`)
  if (info.kind !== 'dir')
    throw new Invalid(`scene.dir "${dir}" is not a directory: pass the folder that holds the scene, not a file`)
  const real = info.realPath
  if (real === undefined) throw new Invalid(`scene.dir "${dir}" cannot be resolved to a real path`)
  if (!roots.some(r => isInside(real, r)))
    throw new Invalid(
      `scene.dir "${dir}"${real === dir ? '' : ` (really ${real})`} is outside the allowed folders ` +
        `(${roots.join(', ')}): ${ROOT_HINT}`,
    )
  return real
}

async function sceneEntry(realDir: string, entry: string, fs: SceneFs): Promise<void> {
  const info = await fs.stat(joinPath(realDir, entry))
  if (info === undefined || info.kind !== 'file')
    throw new Invalid(
      `scene.entry "${entry}" was not found as a file in ${realDir}: write it there, or set entry to a page that exists`,
    )
  if (info.realPath === undefined || !isInside(info.realPath, realDir))
    throw new Invalid(`scene.entry "${entry}" leads outside ${realDir} (a symlink?): keep the page inside the folder`)
}

async function terminalImage(path: string, fs: SceneFs): Promise<void> {
  if (hasParentSegment(path)) throw new Invalid(`scene.term.image "${path}" must not contain ".." segments`)
  const info = await fs.stat(path)
  if (info === undefined || info.kind !== 'file')
    throw new Invalid(`scene.term.image "${path}" was not found as a file: write the PNG first, or drop term.image`)
  if (info.size > SCENE_CAPS.IMAGE_BYTES)
    throw new Invalid(
      `scene.term.image "${path}" is ${info.size} bytes; the limit is ${SCENE_CAPS.IMAGE_BYTES} (2 MiB): downscale it`,
    )
}

/**
 * Parse one `scene` call and check the files it names. An upsert comes back with
 * `dir` resolved to its real path. Throws `Invalid` naming the field.
 */
export async function prepareScene(input: unknown, env: SceneEnv, fs: SceneFs, io?: SceneIo): Promise<SceneAction> {
  const action = parseSceneInput(input)
  if (action.kind !== 'upsert') return action
  const { scene, inline } = action
  let at = scene.dir
  if (inline !== undefined) {
    if (env.scenesDir === undefined || io === undefined)
      throw new Invalid('scene.html and scene.files are not available here: write a folder and publish it with dir')
    at = joinPath(env.scenesDir, scene.id)
    await io.putFiles(at, inline.files)
  }
  const roots = await resolveRoots(fs, allowedRoots(env))
  const dir = await sceneDir(at, roots, fs)
  await sceneEntry(dir, scene.entry ?? '', fs)
  if (scene.term?.image !== undefined) await terminalImage(scene.term.image, fs)
  if (action.data !== undefined) {
    if (io === undefined) throw new Invalid('scene.data is not available here')
    await io.putData(dir, action.data)
  }
  return { ...action, scene: { ...scene, dir } }
}
