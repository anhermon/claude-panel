// The fleet control plane, wired: the `/fleet` command (starts or asks the standalone process, scripts/fleet.mjs) and the
// hub's poll (./fleet-hub.ts). The URL carries the access token, so it only ever goes to the person: as the text a slash
// command answers, never in a tool result the model could read.
import type { EngineInterface, On } from 'claude-code'

import { ensureHub } from './fleet-hub'
import { log } from './register-support'

type Dollar = EngineInterface

export const FLEET_COMMAND_NAME = 'fleet'
export const FLEET_COMMAND_DESCRIPTION = 'Open the fleet control panel: every Claude Code session on this machine, with a send-message box'
export const FLEET_ARG_HINT = '[start|stop|status|url]'
export const FLEET_USAGE = 'usage: /fleet [start|stop|status|url]'
const FLEET_SCRIPT = 'scripts/fleet.mjs'
const NODE_BIN = 'node'
const LAUNCH_TIMEOUT_MS = 15_000
export type FleetVerb = 'start' | 'stop' | 'status' | 'url'
const VERBS: readonly string[] = ['start', 'stop', 'status', 'url']

/** `/fleet [verb]`: no argument opens (starts when needed). */
export function parseFleetArgs(args: string): { verb: FleetVerb } | { usage: string } {
  const word = args.trim().split(/\s+/)[0] ?? ''
  if (word === '') return { verb: 'start' }
  return VERBS.includes(word) ? { verb: word as FleetVerb } : { usage: FLEET_USAGE }
}

/** The argv of one launcher call. `start` also prints the URL for the person; `status` never does. */
export const fleetArgv = (pluginRoot: string, verb: FleetVerb): string[] => [
  NODE_BIN,
  `${pluginRoot}/${FLEET_SCRIPT}`,
  verb,
  ...(verb === 'start' ? ['--print-url'] : []),
]

/** The reply of `/fleet <verb>`. */
export async function fleetCommand($: Dollar, args: string): Promise<string> {
  const parsed = parseFleetArgs(args)
  if ('usage' in parsed) return parsed.usage
  ensureHub($)
  try {
    const done = await $.process.run(fleetArgv($.plugin.root, parsed.verb), { timeoutMs: LAUNCH_TIMEOUT_MS })
    const out = done.stdout.trim()
    if (done.exitCode !== 0 && parsed.verb !== 'status') return `fleet: ${(done.stderr.trim() || 'the launcher failed').split('\n')[0]}`
    if (parsed.verb === 'start' || parsed.verb === 'url') return out === '' ? 'fleet: not running' : `Fleet control panel (only on this machine): ${out}`
    return out === '' ? done.stderr.trim() : out
  } catch (error) {
    return `fleet: ${error instanceof Error ? error.message : 'the launcher could not run'}`
  }
}

/** Called from the mod's own `session.start` (the engine allows one unmatched hook per event): the command and the hub's poll. */
export async function fleetStart($: Dollar): Promise<void> {
  try {
    await $.command.register({ name: FLEET_COMMAND_NAME, description: FLEET_COMMAND_DESCRIPTION, argumentHint: FLEET_ARG_HINT })
    ensureHub($)
  } catch (error) {
    log($, `fleet: ${error instanceof Error ? error.message : 'could not start'}`)
  }
}

export function registerFleet(on: On): void {
  on('command.run', { command: FLEET_COMMAND_NAME }, async ($, e) => ({ text: await fleetCommand($, e.args) }))
}
