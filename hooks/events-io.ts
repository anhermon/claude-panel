// The `$` half of the return channel and of the shots: reading the events file, appending the pane's
// answer lines to it, and the small adapter the shot step runs through. Thin on purpose; the rules live in events.ts
// and shot.ts. The atoms (the cursor) are in register.tsx.
import type { EngineInterface } from 'claude-code'

import type { PanelChoice } from '../types'

import { answerLine, lastEventN } from './events'
import type { ShotEnv } from './shot'

type Dollar = EngineInterface

const APPEND_TIMEOUT_MS = 5000
/** `cat >> "$1"`: one write() in O_APPEND mode, so a line cannot be torn by the server's own appends. */
const APPEND_ARGV = ['sh', '-c', 'cat >> "$1"', 'sh'] as const

/** The events file's text, or null when it does not exist (or cannot be read): there is nothing to deliver. */
export async function readEventsText($: Dollar, path: string): Promise<string | null> {
  try {
    const text = await $.fs.read(path)
    return typeof text === 'string' ? text : null
  } catch {
    return null
  }
}

/**
 * Append one line to the events file (`line` has no newline of its own). `$.fs` has no append (only a whole-file write, which would race
 * with the server's appends and could drop a line), so a tiny `cat >>` does it: a single O_APPEND
 * write. The one remaining race is the server trimming the file (rewriting its last 200 lines) in the
 * same instant; that window is milliseconds wide and happens once per ~800 events.
 */
export async function appendLine($: Dollar, path: string, line: string): Promise<boolean> {
  try {
    const { exitCode } = await $.process.run([...APPEND_ARGV, path], { stdin: `${line}\n`, timeoutMs: APPEND_TIMEOUT_MS })
    return exitCode === 0
  } catch {
    return false
  }
}

// Two presses at once must not both read the same highest `n` and write the same next one.
let answerQueue: Promise<unknown> = Promise.resolve()

/** The file's text, '' when there is none yet, undefined when it exists but cannot be read (then nothing is written). */
async function textToAppendTo($: Dollar, path: string): Promise<string | undefined> {
  try {
    const text = await $.fs.read(path)
    return typeof text === 'string' ? text : undefined
  } catch {
    return (await $.fs.exists(path)) ? undefined : ''
  }
}

async function writeAnswer($: Dollar, path: string, choice: PanelChoice, now: number): Promise<boolean> {
  try {
    const text = await textToAppendTo($, path)
    if (text === undefined) return false
    // The server numbers its lines itself and re-reads the file when its size is not what it wrote, so this
    // line only has to carry the next `n`, like the server's would. A file that lacks its final newline gets
    // one first, and the line it ends is counted (the server counts it too).
    const glue = text !== '' && !text.endsWith('\n') ? '\n' : ''
    return await appendLine($, path, glue + answerLine(choice, now, lastEventN(text + glue) + 1))
  } catch {
    return false
  }
}

/** Append the answer to `choice` as one more event, numbered after the file's highest `n`. Never throws; false when it could not. */
export function appendAnswer($: Dollar, path: string, choice: PanelChoice, now: number): Promise<boolean> {
  const step = (): Promise<boolean> => writeAnswer($, path, choice, now)
  const run = answerQueue.then(step, step)
  answerQueue = run
  return run
}

/** What `runShot` needs, from the engine's process and file-system calls. (A declaration, not an arrow: the plugin checks follow `$` only into a function declaration.) */
export function shotEnv($: Dollar): ShotEnv {
  return {
    run: (argv, timeoutMs) => $.process.run(argv, { timeoutMs }),
    stat: async path => {
      try {
        const { size } = await $.fs.stat(path)
        return { size }
      } catch {
        return undefined
      }
    },
    exists: async path => {
      try {
        return await $.fs.exists(path)
      } catch {
        return false
      }
    },
  }
}
