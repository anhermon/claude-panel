// The adapter of a transcript format. Only codex is implemented; the Claude subagent path still has its own reader
// (../transcript-parse.ts) and agy is not read yet, so those formats give undefined (the caller shows no transcript).
import { codexAdapter } from './codex'
import type { HarnessAdapter } from './types'

const ADAPTERS: ReadonlyMap<string, HarnessAdapter> = new Map([[codexAdapter.format, codexAdapter]])

/** The adapter for a record's `transcript.format`; undefined for a format nobody reads yet (or any other string). */
export const adapterOf = (format: string | undefined): HarnessAdapter | undefined => (format === undefined ? undefined : ADAPTERS.get(format))
