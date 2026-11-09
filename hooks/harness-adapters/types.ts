// What a harness (the program an agent runs in: Claude, codex, agy) must give the panel so its transcript can be shown like a
// Claude subagent's. The result types are the neutral ones of ../transcript-parse.ts, so the detail view needs no change.
// Pure: no `$`, no I/O. A piece of transcript is TEXT; the caller reads it (see ../run-records-io.ts and ../agent-detail-host.ts).
import type { Parsed } from '../transcript-parse'

export type { Parsed }

/** The transcript formats a run record can name. */
export type TranscriptFormat = 'claude-subagent' | 'codex-rollout' | 'agy-transcript'

export type RunState = 'running' | 'done' | 'aborted'

/** One tool call, finished, as the pulse's beginCall / endCall want it. */
export type HarnessCall = { t: number; tool: string; target: string; ms: number | null; failed: boolean }

export type HarnessAdapter = {
  format: TranscriptFormat
  /** Entries, steps and brief of a piece of the transcript; `isWhole`: the piece starts at the file's first byte. Never throws. */
  parse(text: string, isWhole: boolean): Parsed
  /** The finished tool calls, oldest first (feeds the pulse's spans, tally and counts). */
  calls(text: string): HarnessCall[]
  /** The final report ('' while there is none), scrubbed. */
  lastMessage(text: string): string
  /** The state the transcript alone shows: `now` and `mtimeMs` are epoch ms. Used when no record says better. */
  state(text: string, mtimeMs: number, now: number): RunState
  model(text: string): { model?: string; effort?: string }
  /** The brief unshortened (for the proof parsers: its `Eval:` line); '' when the piece does not hold it. */
  rawBrief?(text: string): string
}
