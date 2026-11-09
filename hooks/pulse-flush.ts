// Writes the pulse model to live/pulse.json: coalesced (a burst of events is one write), at most two writes a
// second, only while something changed, and atomic (a temp file next to it, then a rename) so the page never reads
// half a file. Timers and the file system come in as arguments: nothing here knows `$`.

/** First write this long after the first change of a quiet period (lets a burst of parallel calls land in one write). */
export const LEAD_MS = 60
/** After a write, the next one waits at least this long: two writes a second at most. */
export const COOLDOWN_MS = 500
export const PULSE_FILE_NAME = 'pulse.json'
export const PULSE_TEMP_NAME = '.pulse.json.tmp'
export const LIVE_DIR_NAME = 'live'

export type Cancel = { cancel: () => void }
export type FlushDeps = {
  /** `$.clock.after`. */
  after: (ms: number, fn: () => void) => Cancel
  /** Build the snapshot and write it to the pulse file, atomically. */
  run: () => Promise<void>
  onError: (err: unknown) => void
}

export type Flusher = {
  /** Something changed: a write follows, soon. Cheap and synchronous; safe in a hot path. */
  touch: () => void
  /** Write now if anything changed (a final flush, or a test). */
  flushNow: () => Promise<void>
  /** Drop the timers; nothing is written after this. */
  dispose: () => void
  /** Writes made so far. */
  writes: () => number
}

export function createFlusher(deps: FlushDeps): Flusher {
  const box = { isDirty: false, isCooling: false, isDisposed: false, timer: undefined as Cancel | undefined, count: 0, chain: Promise.resolve() }

  const writeOnce = (): Promise<void> => {
    box.isDirty = false
    box.count++
    box.chain = box.chain.then(deps.run, deps.run).catch(deps.onError)
    return box.chain
  }
  const arm = (ms: number, fn: () => void): void => {
    box.timer = deps.after(ms, () => {
      box.timer = undefined
      if (!box.isDisposed) fn()
    })
  }
  const cooldown = (): void => {
    box.isCooling = true
    arm(COOLDOWN_MS, () => {
      box.isCooling = false
      if (box.isDirty) fire()
    })
  }
  const fire = (): void => {
    void writeOnce()
    cooldown()
  }

  return {
    touch() {
      if (box.isDisposed) return
      box.isDirty = true
      if (box.isCooling || box.timer !== undefined) return
      arm(LEAD_MS, fire)
    },
    async flushNow() {
      if (box.isDisposed || !box.isDirty) return box.chain
      return writeOnce()
    },
    dispose() {
      box.isDisposed = true
      box.timer?.cancel()
      box.timer = undefined
    },
    writes: () => box.count,
  }
}

/**
 * Atomic replace through a temp file and a rename. `$.fs` has no rename, so the move is a `mv` the caller runs;
 * if it fails the text goes straight to the target (a torn read is then possible but the page tolerates a bad parse).
 */
export async function writeAtomic(io: {
  write: (path: string, text: string) => Promise<void>
  move: (from: string, to: string) => Promise<boolean>
}, target: string, temp: string, text: string): Promise<void> {
  await io.write(temp, text)
  if (!(await io.move(temp, target))) await io.write(target, text)
}
