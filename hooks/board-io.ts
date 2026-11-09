// The `$` half of the board's files: copy the scene's static files (with their sub-folders) into the session's board
// folder, read the model's sidecar back, write live/data.json and the sidecar atomically. Thin on purpose; the rules are
// in board-model.ts (a mod reload re-runs installBoard, so edited board and agents-info files reach the pane; the engine reloads the mod after a hooks/ file is changed with the Edit tool, not with a shell command; the router frames reload the same way, and the link keeps its port: the old server hands it over; other sessions get the mod through scripts/sync-sessions.sh; an edit to a hooks/ file reloads the mod). `$.fs` has no rename or copy, so the move is a `mv` through `$.process.run` (as pulse-io.ts does) and
// the scene's files are copied as text (they are html / css / js / json).
import type { EngineInterface } from 'claude-code'

import { LIVE_DIR_NAME, writeAtomic } from './pulse-flush'
import { PULSE_STATE_DIR } from './pulse-io'

type Dollar = EngineInterface

export const BOARD_SUBDIR = 'board'
/** The scene's own files, relative to the plugin root. */
export const BOARD_SOURCE_DIR = 'web/builtin/board'
export const DATA_FILE_NAME = 'data.json'
export const DATA_TEMP_NAME = '.data.json.tmp'
/** The model's frames, kept beside the data so a reload of the mod (which drops module memory) gets them back. */
export const MODEL_FILE_NAME = 'board-model.json'
export const MODEL_TEMP_NAME = '.board-model.json.tmp'
const SCENE_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.(html|css|js|mjs|json|svg|txt)$/
const TEST_FILE = /\.test\./
/** Folders of the source that are not part of the page: fixtures for the tests and the scene's own live data. */
const SKIPPED_DIRS: readonly string[] = ['fixtures', LIVE_DIR_NAME, 'node_modules']
const MAX_DEPTH = 4
const MOVE_TIMEOUT_MS = 10_000

/** `<tmp>/claude-panel/board/<session id>`: where the board scene and its live/ folder live. */
export const boardDirOf = (tmp: string, sessionId: string): string =>
  `${tmp.replace(/\/+$/, '')}/${PULSE_STATE_DIR}/${BOARD_SUBDIR}/${sessionId}`
const liveFile = (dir: string, name: string): string => `${dir}/${LIVE_DIR_NAME}/${name}`

async function readText($: Dollar, path: string): Promise<string | undefined> {
  try {
    const text = await $.fs.read(path)
    return typeof text === 'string' ? text : undefined
  } catch {
    return undefined
  }
}

/** The relative paths of the scene's files under `source/rel`, sub-folders included (undefined: the folder cannot be listed). */
async function walk($: Dollar, source: string, rel: string, depth: number): Promise<string[] | undefined> {
  let entries
  try {
    entries = await $.fs.list(rel === '' ? source : `${source}/${rel}`)
  } catch {
    return undefined
  }
  const out: string[] = []
  for (const e of entries) {
    const path = rel === '' ? e.name : `${rel}/${e.name}`
    if (e.kind === 'file' && SCENE_FILE.test(e.name) && !TEST_FILE.test(e.name)) out.push(path)
    else if (e.kind === 'dir' && depth < MAX_DEPTH && !SKIPPED_DIRS.includes(e.name)) out.push(...((await walk($, source, path, depth + 1)) ?? []))
  }
  return out
}

/**
 * Copy the scene's files from the plugin into `dir`, writing only what differs (an untouched file keeps its mtime, so
 * the browser does not reload on a mod reload); `live/` is never touched. Runs at every mod load, so a change to the
 * page's files reaches the pane when the mod reloads. Returns how many files were written; -1 when
 * the source does not exist (the board is not built yet: the caller skips it quietly) or has no file.
 */
export async function installBoard($: Dollar, dir: string): Promise<number> {
  return installScene($, BOARD_SOURCE_DIR, dir)
}

/** `installBoard` for any built-in scene: the files of `<plugin root>/<sourceRel>` into `dir`. */
export async function installScene($: Dollar, sourceRel: string, dir: string): Promise<number> {
  const source = `${$.plugin.root}/${sourceRel}`
  const names = await walk($, source, '', 0)
  if (names === undefined || names.length === 0) return -1
  let written = 0
  for (const name of names) {
    const text = await readText($, `${source}/${name}`)
    if (text === undefined || text === (await readText($, `${dir}/${name}`))) continue
    await $.fs.write(`${dir}/${name}`, text)
    written++
  }
  return written
}

/** A JSON file of the board's live folder, parsed; undefined when there is none or it is not JSON. */
export async function readLive($: Dollar, dir: string, name: string): Promise<unknown> {
  const text = await readText($, liveFile(dir, name))
  if (text === undefined) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** A file of the board's live folder through a temp file in the same folder and one `mv`. */
export async function writeLive($: Dollar, dir: string, name: string, temp: string, text: string): Promise<void> {
  await writeAtomic(
    {
      write: (path, body) => $.fs.write(path, body),
      move: async (from, to) => {
        try {
          return (await $.process.run(['mv', '-f', '--', from, to], { timeoutMs: MOVE_TIMEOUT_MS })).exitCode === 0
        } catch {
          return false
        }
      },
    },
    liveFile(dir, name),
    liveFile(dir, temp),
    text,
  )
}
