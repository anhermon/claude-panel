// The conventions the mod used to hard-code, read from the plugin's options (`userConfig` in plugin.json). Every default is
// today's behaviour, so a mod with no option set works as before. `applyOptions` runs once per load (`register`); the pure
// modules read `panelConfig` when they work, so their unit tests need no setup.
import type { PluginOptions } from 'claude-code'
import { LIMITS_SHOW_FROM_PCT } from './limits-frame'
import { QUOTA_IO } from './limits-io'

const MS_PER_MINUTE = 60_000
const MS_PER_SECOND = 1000
const LIST_SPLIT = /\s*,\s*/
const LABEL_SAFE = /^[a-z][a-z ]{0,19}$/

export const CONFIG_DEFAULTS = {
  /** Contextual panel guidance and the task safety net. */
  proactive: true,
  /** Non-panel calls before an empty task is filled; zero disables the safety net. */
  autoTaskAfterCalls: 6,
  /** Show measured provider limits at this percentage; zero always shows available readings. */
  limitsShowPct: LIMITS_SHOW_FROM_PCT,
  /** Seconds between local provider quota reads; zero disables them. */
  quotaEveryS: QUOTA_IO.EVERY_S,
  /** A finished agent keeps its row this many minutes. */
  doneRowMinutes: 10,
  /** At most this many checklist (`dod-*`) frames at once. */
  dodFramesMax: 3,
  /** Strip a trailing `(sonnet/high)` style routing note from an agent's name. */
  stripRoutingSuffix: true,
  /** Lines of a dispatch brief that name the goal / the ticket, comma separated, case-insensitive. */
  goalLabels: 'goal,objective',
  ticketLabels: 'ticket',
  /** The workflow-insight frames (time by kind, sinks, repeats, improve) wait for this many seconds of agent time: below it a share means nothing. */
  insightMinSeconds: 30,
  /** Draw the `sessions` frame: every other Claude Code session running on this machine. */
  sessionsFrame: true,
  /** The same file touched / the same command run at least this many times is a repeat. */
  repeatMin: 4,
  /** A command run again right after it failed, at least this many times, is shown as a retry. */
  retryMin: 2,
  /** This many agents started with the same kind of task are shown as a repeated task. */
  similarMin: 3,
  /** `improve` hints: tests and checks took at least this share (percent) of agent time ... */
  hintTestsPct: 35,
  /** ... agents read/searched at least this share (percent) of their time before their first edit ... */
  hintReadingPct: 30,
  /** ... at least this many files were each read by at least this many agents ... */
  hintSharedFiles: 3,
  hintSharedAgents: 3,
  /** ... commands were run again right after failing at least this many times in all. */
  hintRetries: 3,
} as const

export type PanelConfig = {
  proactive: boolean
  autoTaskAfterCalls: number
  limitsShowPct: number
  quotaEveryS: number
  doneRowMs: number
  dodFramesMax: number
  stripRoutingSuffix: boolean
  goalLabels: readonly string[]
  ticketLabels: readonly string[]
  insightMinMs: number
  sessionsFrame: boolean
  repeatMin: number
  retryMin: number
  similarMin: number
  hintTestsPct: number
  hintReadingPct: number
  hintSharedFiles: number
  hintSharedAgents: number
  hintRetries: number
}

const labelsOf = (raw: unknown, fallback: string): readonly string[] => {
  const list = (typeof raw === 'string' ? raw : fallback)
    .toLowerCase()
    .split(LIST_SPLIT)
    .filter(l => LABEL_SAFE.test(l)) // letters and spaces only: a label is spliced into a regex
  return list.length > 0 ? list : fallback.split(',')
}
const countOf = (raw: unknown, fallback: number): number => (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? raw : fallback)

/** The settings of a set of options; anything missing or odd falls back to the default. */
export const configOf = (options: PluginOptions = {}): PanelConfig => ({
  proactive: typeof options.proactive === 'boolean' ? options.proactive : CONFIG_DEFAULTS.proactive,
  autoTaskAfterCalls: Math.floor(countOf(options.autoTaskAfterCalls, CONFIG_DEFAULTS.autoTaskAfterCalls)),
  limitsShowPct: countOf(options.limitsShowPct, CONFIG_DEFAULTS.limitsShowPct),
  quotaEveryS: countOf(options.quotaEveryS, CONFIG_DEFAULTS.quotaEveryS),
  doneRowMs: countOf(options.doneRowMinutes, CONFIG_DEFAULTS.doneRowMinutes) * MS_PER_MINUTE,
  dodFramesMax: Math.floor(countOf(options.dodFramesMax, CONFIG_DEFAULTS.dodFramesMax)),
  stripRoutingSuffix: typeof options.stripRoutingSuffix === 'boolean' ? options.stripRoutingSuffix : CONFIG_DEFAULTS.stripRoutingSuffix,
  goalLabels: labelsOf(options.goalLabels, CONFIG_DEFAULTS.goalLabels),
  ticketLabels: labelsOf(options.ticketLabels, CONFIG_DEFAULTS.ticketLabels),
  insightMinMs: countOf(options.insightMinSeconds, CONFIG_DEFAULTS.insightMinSeconds) * MS_PER_SECOND,
  sessionsFrame: typeof options.sessionsFrame === 'boolean' ? options.sessionsFrame : CONFIG_DEFAULTS.sessionsFrame,
  repeatMin: Math.floor(countOf(options.repeatMin, CONFIG_DEFAULTS.repeatMin)),
  retryMin: Math.floor(countOf(options.retryMin, CONFIG_DEFAULTS.retryMin)),
  similarMin: Math.floor(countOf(options.similarMin, CONFIG_DEFAULTS.similarMin)),
  hintTestsPct: countOf(options.hintTestsPct, CONFIG_DEFAULTS.hintTestsPct),
  hintReadingPct: countOf(options.hintReadingPct, CONFIG_DEFAULTS.hintReadingPct),
  hintSharedFiles: Math.floor(countOf(options.hintSharedFiles, CONFIG_DEFAULTS.hintSharedFiles)),
  hintSharedAgents: Math.floor(countOf(options.hintSharedAgents, CONFIG_DEFAULTS.hintSharedAgents)),
  hintRetries: Math.floor(countOf(options.hintRetries, CONFIG_DEFAULTS.hintRetries)),
})

export const panelConfig: PanelConfig = configOf()

/** Called by `register` with the plugin's options. */
export function applyOptions(options: PluginOptions): void {
  Object.assign(panelConfig, configOf(options))
}
