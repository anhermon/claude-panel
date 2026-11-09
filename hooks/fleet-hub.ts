// The fleet hub: the one place a message from the fleet page becomes `$.session.send`. The page's server (a separate
// process with no engine access) drops <stateDir>/commands/<id>.json; this module polls that folder, claims a file with an
// atomic `mkdir` (two sessions running this mod never both send), re-validates it (./fleet-validate.ts), prefixes the
// text, sends, appends to audit.jsonl, writes results/<id>.json for the page and removes the command. It also rewrites
// hub.json every few seconds: the page enables "send" only while that file is fresh. `$` only goes to function declarations.
import type { EngineInterface } from 'claude-code'

import {
  AUDIT_KEEP_LINES,
  AUDIT_PREVIEW_CHARS,
  COMMANDS_PER_TICK,
  FLEET_COMMAND_FILE,
  FLEET_ORIGIN_PREFIX,
  FLEET_STATE_PARTS,
  FLEET_STATUS,
  HUB_BEAT_MS,
  HUB_KEEP_MS,
  HUB_POLL_MS,
  HUB_PRUNE_MS,
  RATE_WINDOW_MS,
  REASON_MAX_CHARS,
  fleetPaths,
} from './fleet-contract'
import type { FleetPaths, FleetStatus } from './fleet-contract'
import { SESSION_ID, judge, parseLstart, parseRegistry } from './fleet-validate'
import type { RegistryRow } from './fleet-validate'
import { clip, scrubText } from './transcript-redact'
import { log, tmpDir } from './register-support'

type Dollar = EngineInterface

const PROCESS_TIMEOUT_MS = 5000
const HUB_SCHEMA = 1
const STATE_DIR_MODE = '700'
const FALLBACK_HOME = ''
const CLAIM_ID = /^[0-9a-f]{32}$/

export type Hub = { timer: { cancel: () => void }; isTicking: boolean; isPrepared: boolean; lastBeat: number; lastPrune: number; sends: Map<string, number[]> }
let hub: Hub | undefined

/** The folder shared with the page's server. `$.env.get` takes literal names (the engine lists what a module reads). */
export async function fleetStateDir($: Dollar): Promise<string> {
  const override = await $.env.get('CLAUDE_FLEET_DIR')
  return override !== undefined && override !== '' ? override : [await tmpDir($), ...FLEET_STATE_PARTS].join('/')
}

async function sessionsDir($: Dollar): Promise<string> {
  const config = await $.env.get('CLAUDE_CONFIG_DIR')
  const home = (await $.env.get('HOME')) ?? FALLBACK_HOME
  return `${config !== undefined && config !== '' ? config : `${home}/.claude`}/sessions`
}

async function run($: Dollar, argv: readonly string[]): Promise<{ exitCode: number; stdout: string }> {
  try {
    const done = await $.process.run(argv, { timeoutMs: PROCESS_TIMEOUT_MS })
    return { exitCode: done.exitCode, stdout: done.stdout }
  } catch {
    return { exitCode: 1, stdout: '' }
  }
}

async function readText($: Dollar, path: string): Promise<string | undefined> {
  try {
    const text = await $.fs.read(path)
    return typeof text === 'string' ? text : undefined
  } catch {
    return undefined
  }
}

/** Temp file in the same folder, then one `mv` (`$.fs` has no rename). */
async function writeAtomic($: Dollar, path: string, text: string): Promise<void> {
  const temp = `${path}.tmp`
  await $.fs.write(temp, text)
  if ((await run($, ['mv', '-f', '--', temp, path])).exitCode !== 0) await $.fs.write(path, text)
}

const safeText = (v: unknown, max: number): string => clip(scrubText(typeof v === 'string' ? v : ''), max)

/** The result file the page polls. */
async function writeResult($: Dollar, paths: FleetPaths, id: string, status: FleetStatus, reason: string | null, now: number): Promise<void> {
  const body = JSON.stringify({ id, status, reason: reason === null ? null : safeText(reason, REASON_MAX_CHARS), ts: now })
  await writeAtomic($, `${paths.resultsDir}/${id}.json`, body)
}

async function appendAudit($: Dollar, paths: FleetPaths, entry: Record<string, unknown>): Promise<void> {
  const old = (await readText($, paths.auditFile)) ?? ''
  const lines = old.split('\n').filter(l => l !== '').slice(-(AUDIT_KEEP_LINES - 1))
  await writeAtomic($, paths.auditFile, `${[...lines, JSON.stringify(entry)].join('\n')}\n`)
}

async function readAllowSelf($: Dollar, paths: FleetPaths): Promise<boolean> {
  const text = await readText($, paths.hubConfigFile)
  if (text === undefined) return false
  try {
    return (JSON.parse(text) as { allowSelf?: unknown }).allowSelf === true
  } catch {
    return false
  }
}

async function registryOf($: Dollar, pid: number): Promise<RegistryRow | undefined> {
  const text = await readText($, `${await sessionsDir($)}/${pid}.json`) // only <pid>.json, never the *.key peer tokens beside it
  return text === undefined ? undefined : parseRegistry(text)
}

async function startOf($: Dollar, pid: number): Promise<string | undefined> {
  const ps = await run($, ['ps', '-p', String(pid), '-o', 'lstart='])
  return ps.exitCode === 0 ? parseLstart(ps.stdout) : undefined
}

const pidOf = (v: unknown): number | undefined => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : undefined)

type Outcome = { status: FleetStatus; reason: string | null }

/** One claimed command: judge, send, record. */
async function handle($: Dollar, paths: FleetPaths, h: Hub, id: string, now: number): Promise<void> {
  const raw = await readText($, `${paths.commandsDir}/${id}.json`)
  if (raw === undefined) return // another hub removed it already
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    parsed = undefined
  }
  const o = (parsed !== null && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>
  const pid = pidOf(o.pid)
  const self = await $.session.id()
  const verdict = judge({
    command: parsed,
    now,
    selfSessionId: self,
    allowSelf: await readAllowSelf($, paths),
    registry: pid === undefined ? undefined : await registryOf($, pid),
    lstart: pid === undefined ? undefined : await startOf($, pid),
    recentSends: typeof o.sessionId === 'string' ? (h.sends.get(o.sessionId.toLowerCase()) ?? []) : [],
  })
  let outcome: Outcome
  if (!verdict.ok) outcome = { status: FLEET_STATUS.REFUSED, reason: verdict.reason }
  else {
    const { command } = verdict
    h.sends.set(command.sessionId, [...(h.sends.get(command.sessionId) ?? []).filter(t => now - t < RATE_WINDOW_MS), now])
    try {
      const sent = await $.session.send({ to: { sessionId: command.sessionId }, text: `${FLEET_ORIGIN_PREFIX}\n${command.text}` })
      outcome = sent.isDelivered ? { status: FLEET_STATUS.QUEUED, reason: null } : { status: FLEET_STATUS.FAILED, reason: sent.reason }
    } catch (error) {
      outcome = { status: FLEET_STATUS.FAILED, reason: error instanceof Error ? error.message : 'the send failed' }
    }
  }
  await writeResult($, paths, id, outcome.status, outcome.reason, now)
  await appendAudit($, paths, {
    ts: now,
    id,
    hub: self,
    sessionId: typeof o.sessionId === 'string' && SESSION_ID.test(o.sessionId) ? o.sessionId.toLowerCase() : null,
    pid: pid ?? null,
    status: outcome.status,
    reason: outcome.reason === null ? null : safeText(outcome.reason, REASON_MAX_CHARS),
    chars: typeof o.text === 'string' ? o.text.length : 0,
    preview: safeText(o.text, AUDIT_PREVIEW_CHARS),
  })
  await run($, ['rm', '-f', '--', `${paths.commandsDir}/${id}.json`])
}

/** Claims, results and command files an hour old are removed (a claim whose hub died would otherwise stay for good). */
async function prune($: Dollar, paths: FleetPaths, now: number): Promise<void> {
  for (const dir of [paths.claimsDir, paths.resultsDir, paths.commandsDir]) {
    let entries: Awaited<ReturnType<Dollar['fs']['list']>> = []
    try {
      entries = await $.fs.list(dir)
    } catch {
      continue
    }
    for (const entry of entries) {
      const isOurs = CLAIM_ID.test(entry.name.replace(/\.json$/, ''))
      if (isOurs && now - entry.mtimeMs > HUB_KEEP_MS) await run($, ['rm', '-rf', '--', `${dir}/${entry.name}`])
    }
  }
}

/** One poll. Exported for the tests. */
export async function hubTick($: Dollar, h: Hub): Promise<void> {
  const paths = fleetPaths(await fleetStateDir($))
  const now = await $.clock.now()
  if (!h.isPrepared) {
    h.isPrepared = true // the folder holds commands and message previews: owner only, whoever created it first
    await run($, ['mkdir', '-p', '-m', STATE_DIR_MODE, '--', paths.stateDir])
    await run($, ['chmod', STATE_DIR_MODE, '--', paths.stateDir])
  }
  if (now - h.lastBeat >= HUB_BEAT_MS) {
    h.lastBeat = now
    await writeAtomic($, paths.hubFile, JSON.stringify({ schema: HUB_SCHEMA, ts: now, sessionId: await $.session.id() }))
  }
  let names: string[] = []
  try {
    names = (await $.fs.list(paths.commandsDir)).filter(e => e.kind === 'file' && FLEET_COMMAND_FILE.test(e.name)).map(e => e.name)
  } catch {
    names = []
  }
  if (names.length > 0) await run($, ['mkdir', '-p', '--', paths.claimsDir])
  for (const name of names.slice(0, COMMANDS_PER_TICK)) {
    const id = name.replace(/\.json$/, '')
    if ((await run($, ['mkdir', '--', `${paths.claimsDir}/${id}`])).exitCode !== 0) continue // someone else holds it
    await handle($, paths, h, id, now)
  }
  if (now - h.lastPrune >= HUB_PRUNE_MS) {
    h.lastPrune = now
    await prune($, paths, now)
  }
}

export const newHub = (timer: { cancel: () => void }): Hub => ({ timer, isTicking: false, isPrepared: false, lastBeat: Number.NEGATIVE_INFINITY, lastPrune: Number.NEGATIVE_INFINITY, sends: new Map() })

/** Starts the poll once; calling it again while it runs does nothing. A reload of the mod starts a new module (and a new hub). */
export function ensureHub($: Dollar): void {
  if (hub !== undefined) return
  const h = newHub({ cancel: () => {} })
  h.timer = $.clock.every(HUB_POLL_MS, () => {
    if (h.isTicking) return
    h.isTicking = true
    hubTick($, h)
      .catch(error => log($, `fleet hub: ${error instanceof Error ? error.message : 'poll failed'}`))
      .finally(() => {
        h.isTicking = false
      })
  })
  hub = h
}

export function stopHub(): void {
  hub?.timer.cancel()
  hub = undefined
}
