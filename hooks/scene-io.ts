// The `$` half of the inline scenes and the live data channel: write a scene folder from text, write
// live/data.json. Thin on purpose; the rules are in scene-inline.ts and scene-fs.ts. `$.fs` has no rename or
// delete, so `mv` and `rm` go through `$.process.run` (as events-io.ts does for its append).
import type { EngineInterface } from 'claude-code'

import { Invalid } from './blocks/common'
import { dataResultLine, LIVE_DATA_FILE, LIVE_DIR } from './scene-inline'
import type { SceneIo } from './scene-fs'
import { joinPath } from './scene'
import type { PanelState } from '../types'

type Dollar = EngineInterface

const FS_TIMEOUT_MS = 10_000
const TMP_SUFFIX = '.tmp'
const FAILED = (what: string, err: unknown): Invalid =>
  new Invalid(`scene: could not ${what} (${err instanceof Error ? err.message : String(err)}): try again, or publish a folder with dir`)

/** Remove every entry of the folder but `live/` (so a republish keeps the data); a missing folder is nothing to clear. */
async function clearFolder($: Dollar, dir: string): Promise<void> {
  const entries = await $.fs.list(dir).catch(() => [])
  const stale = entries.filter(e => e.name !== LIVE_DIR).map(e => joinPath(dir, e.name))
  if (stale.length === 0) return
  const { exitCode, stderr } = await $.process.run(['rm', '-rf', '--', ...stale], { timeoutMs: FS_TIMEOUT_MS })
  if (exitCode !== 0) throw new Error(stderr.trim() || `rm exited ${exitCode}`)
}

/** `live/data.json` through a temp file in the same folder and one `mv` (a rename), so a reader never sees half of it. */
async function writeData($: Dollar, dir: string, text: string): Promise<void> {
  const target = joinPath(dir, `${LIVE_DIR}/${LIVE_DATA_FILE}`)
  const temp = target + TMP_SUFFIX
  await $.fs.write(temp, text)
  const { exitCode, stderr } = await $.process.run(['mv', '-f', '--', temp, target], { timeoutMs: FS_TIMEOUT_MS })
  if (exitCode !== 0) throw new Error(stderr.trim() || `mv exited ${exitCode}`)
}

/** What `prepareScene` writes through. (A declaration, not an arrow: the plugin checks follow `$` only into a function declaration.) */
export function sceneIo($: Dollar): SceneIo {
  return {
    putFiles: async (dir, files) => {
      try {
        await clearFolder($, dir)
        for (const [path, text] of Object.entries(files)) await $.fs.write(joinPath(dir, path), text)
      } catch (err) {
        throw FAILED('write the scene files', err)
      }
    },
    putData: async (dir, text) => {
      try {
        await writeData($, dir, text)
      } catch (err) {
        throw FAILED('write live/data.json', err)
      }
    },
  }
}

/** `{ id, data }` alone: the result line, or the refusal (an id that is not a published scene). Changes no state. */
export async function sendData($: Dollar, state: PanelState, id: string, text: string): Promise<{ line: string } | { error: string }> {
  const scene = state.scenes.find(s => s.id === id)
  if (scene === undefined) {
    const ids = state.scenes.map(s => s.id)
    return {
      error:
        `scene.id "${id}" is not a published scene (scenes: ${ids.length === 0 ? 'none' : ids.join(', ')}): ` +
        'publish it first with {id, html, alt}, then send {id, data}',
    }
  }
  if (scene.builtin === true)
    return { error: `scene.id "${id}" is a built-in scene of the panel, not yours: send data only to scenes you published` }
  try {
    await sceneIo($).putData(scene.dir, text)
  } catch (err) {
    return { error: err instanceof Invalid ? err.message : String(err) }
  }
  return { line: dataResultLine(text) }
}
