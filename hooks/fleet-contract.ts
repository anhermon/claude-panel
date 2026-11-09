// The send-message contract between the fleet page's server (web/fleet/commands.mjs, config.mjs) and this mod's hub.
// The numbers and words here are the twins of those files; web/fleet/contract.test.mjs reads this file and fails when
// they differ (a plugin test cannot import() an .mjs, so the check lives on the web side). Text and numbers only.

/** The only origin the hub accepts on a command file. */
export const FLEET_ORIGIN = 'fleet-ui'
/** Put in front of every message the hub sends, so the receiving session knows it is a person's note, not a peer's order. */
export const FLEET_ORIGIN_PREFIX = '[sent from fleet control panel by the user]'
export const FLEET_MESSAGE_MAX_CHARS = 2000
/** A command file is `<id>.json`. */
export const FLEET_COMMAND_ID = /^[0-9a-f]{32}$/
export const FLEET_COMMAND_FILE = /^([0-9a-f]{32})\.json$/
export const FLEET_STATUS = { PENDING: 'pending', QUEUED: 'queued', REFUSED: 'refused', FAILED: 'failed' } as const
export type FleetStatus = (typeof FLEET_STATUS)[keyof typeof FLEET_STATUS]

/** The folder the page's server and the hub share: `<TMPDIR>/claude-panel/fleet`, or `CLAUDE_FLEET_DIR`. */
export const FLEET_STATE_PARTS = ['claude-panel', 'fleet'] as const
export const FLEET_DIR_NAMES = { COMMANDS: 'commands', RESULTS: 'results', CLAIMS: 'claims' } as const
export const FLEET_FILE_NAMES = { AUDIT: 'audit.jsonl', HUB: 'hub.json', HUB_CONFIG: 'hub-config.json' } as const

// Timing and limits of the hub (the server treats hub.json older than 15 s as "offline").
export const HUB_POLL_MS = 2000
export const HUB_BEAT_MS = 5000
export const HUB_PRUNE_MS = 10 * 60 * 1000
export const HUB_KEEP_MS = 60 * 60 * 1000
export const COMMANDS_PER_TICK = 10
export const COMMAND_MAX_AGE_MS = 120 * 1000
export const COMMAND_CLOCK_SKEW_MS = 5000
export const RATE_WINDOW_MS = 60 * 1000
export const RATE_MAX_PER_TARGET = 5
export const PROC_START_TOLERANCE_MS = 2000
export const AUDIT_KEEP_LINES = 500
export const AUDIT_PREVIEW_CHARS = 80
export const REASON_MAX_CHARS = 300

export type FleetPaths = {
  stateDir: string
  commandsDir: string
  resultsDir: string
  claimsDir: string
  auditFile: string
  hubFile: string
  hubConfigFile: string
}

export function fleetPaths(stateDir: string): FleetPaths {
  const dir = stateDir.replace(/\/+$/, '')
  return {
    stateDir: dir,
    commandsDir: `${dir}/${FLEET_DIR_NAMES.COMMANDS}`,
    resultsDir: `${dir}/${FLEET_DIR_NAMES.RESULTS}`,
    claimsDir: `${dir}/${FLEET_DIR_NAMES.CLAIMS}`,
    auditFile: `${dir}/${FLEET_FILE_NAMES.AUDIT}`,
    hubFile: `${dir}/${FLEET_FILE_NAMES.HUB}`,
    hubConfigFile: `${dir}/${FLEET_FILE_NAMES.HUB_CONFIG}`,
  }
}
