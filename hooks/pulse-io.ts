// The `$` half of the Pulse's file: read the last snapshot back, write live/pulse.json atomically. Thin on purpose; the
// rules are in pulse-flush.ts / pulse-model.ts. `$.fs` has no rename, so the move is a `mv` through `$.process.run`
// (as scene-io.ts does for live/data.json).
import type { EngineInterface } from 'claude-code'

import { LIVE_DIR_NAME, PULSE_FILE_NAME, PULSE_TEMP_NAME, writeAtomic } from './pulse-flush'

type Dollar = EngineInterface

export const PULSE_STATE_DIR = 'claude-panel'
export const PULSE_SUBDIR = 'pulse'
const MOVE_TIMEOUT_MS = 10_000

/** `<tmp>/claude-panel/pulse/<session id>`: where the feed's live/ folder lives. */
export const pulseDirOf = (tmp: string, sessionId: string): string =>
  `${tmp.replace(/\/+$/, '')}/${PULSE_STATE_DIR}/${PULSE_SUBDIR}/${sessionId}`
export const pulseFileOf = (dir: string): string => `${dir}/${LIVE_DIR_NAME}/${PULSE_FILE_NAME}`

async function readText($: Dollar, path: string): Promise<string | undefined> {
  try {
    const text = await $.fs.read(path)
    return typeof text === 'string' ? text : undefined
  } catch {
    return undefined
  }
}

/** The last snapshot this session wrote, parsed; undefined when there is none or it is not JSON. */
export async function readSnapshot($: Dollar, dir: string): Promise<unknown> {
  const text = await readText($, pulseFileOf(dir))
  if (text === undefined) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** live/pulse.json through a temp file in the same folder and one `mv`. */
export async function writeSnapshot($: Dollar, dir: string, text: string): Promise<void> {
  const target = pulseFileOf(dir)
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
    target,
    `${dir}/${LIVE_DIR_NAME}/${PULSE_TEMP_NAME}`,
    text,
  )
}
