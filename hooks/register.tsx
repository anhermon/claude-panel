// panel: the mod half. It is the single writer of the panel state: it
// registers the `panel` and `scene` tools natively, serves them with `tool.call`
// hooks, keeps the state in an atom (the Pane redraws on every write) and
// mirrors it to a JSON file that the standalone web/server.mjs watches and serves.
import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import { agentsInfoBind, agentsInfoControls, agentsInfoInstall, agentsInfoPress, setAgentsInfoListener } from './agents-info-host'
import { AGENTS_INFO_SCENE_ID, hasAgentsInfo, isAgentsUiEvent, withAgentsInfo } from './agents-info-scene'
import { parseLiveArgs, planCommand } from './commands'
import { parseWatchArgs, watchCommand } from './watch'
import type { LiveVerb } from './commands'
import { eventsBlock, eventsPath, eventsResult, readEvents } from './events'
import type { EventsBlock } from './events'
import { appendAnswer, readEventsText, shotEnv } from './events-io'
import { liveEnable, liveGoto, liveRendered, liveResize, liveSetHash, liveScroll, liveStatusText, liveStep, liveStop, liveSync, liveView, resetLive } from './live'
import { scrollMoveOf, SCROLL_MOVES } from './live-proto'
import { paneTree } from './pane'
import { applyParts, boardAdopt, boardKept, boardNote, boardNoteScene, boardSceneDir, boardStart, boardVarietyHint } from './board-host'
import { hasFramePart, planFrames } from './board-model'
import { withBoard } from './board-scene'
import { applyOptions } from './panel-config'
import { parsePulseArgs, pulseAdoptLanes, pulseCommand, pulseLanes, pulseSelfCall, pulseStart, registerPulse } from './pulse-host'
import type { PulseInit } from './pulse-host'
import { hasLanePart, planLanes } from './pulse-lanes'
import { applyUserScene } from './pulse-scene'
import { STAGE_LAYOUT, withShotFace } from './scene'
import { allowedRoots, prepareScene, resolveRoots } from './scene-fs'
import { sceneIo, sendData } from './scene-io'
import { FIRST_PORT, mintToken, OPENSSL_ARGV, portMapOf, serverArgv, serverUrl, STORE_PORTS_KEY, STORE_TOKEN_KEY, TOKEN_PATTERN, withPort } from './server'
import {
  BASELINE_TEXT,
  COMMAND_NAME,
  PANE_ID,
  PLUGIN_NAME,
  SCENE_FULL_NAME,
  SCENE_INPUT_SCHEMA,
  SCENE_TOOL_DESCRIPTION,
  SCENE_TOOL_NAME,
  SECTION_ID,
  TOOL_DESCRIPTION,
  TOOL_FULL_NAME,
  TOOL_INPUT_SCHEMA,
  TOOL_NAME,
} from './spec'
import { COMMAND_ARG_HINT, COMMAND_DESCRIPTION, joinResult, log, modelInput, openInBrowser, registerTool, RESULT_JOIN, sceneDeny, sceneEnv, sceneFs, stateFilePath, tmpDir, tryOpenPane } from './register-support'
import type { Dollar, Reserved } from './register-support'
import { runShot } from './shot'
import { applyInput, emptyState, parsePort, resultLine, withUrl } from './state'
import type { ApplyResult } from './state'
import { Invalid } from './blocks/common'
import type { PanelBoardKeep, PanelRuntime, PanelState } from '../types'

// `/foo` (a slash command) and `!cmd` (a shell escape) are not messages to Claude: no events ride along.
const NOT_A_MESSAGE = /^\s*[/!]/
const SENT_NOTE_MS = 4000

// The session values the mod keeps. `plugin` and `key` are literals. Bump a
// shape tag when its value changes: a reload then declines what the old code
// stored (which outlives the reload) and starts from the initial.
const INITIAL_RUNTIME: PanelRuntime = { stateFile: null, isPaneOpened: false, token: null, lastPort: null, eventCursor: 0 }
// The state is v4 now (choices, scene layout): a v3 value is declined, as the shape tag says. The runtime
// only GREW a field (`eventCursor`, read through `cursorOf` so a missing or odd stored value is 0):
// keeping its tag keeps the url token and the port, so an open browser tab survives this reload.
const stateAtom = atom({ plugin: 'panel', key: 'state' } as const, emptyState(), {
  shape: 'panel-state-4',
})
const runtimeAtom = atom({ plugin: 'panel', key: 'runtime' } as const, INITIAL_RUNTIME, {
  shape: 'panel-runtime-2',
})

// What the model posted to the board (frames, removed auto frames, lanes). Module variables die with a mod reload and
// the session does not re-fire `session.start`, so the board reads this back on its first use (`keepBoard`).
const INITIAL_BOARD: PanelBoardKeep = { frames: [], removedAuto: [], lanes: [] }
const boardAtom = atom({ plugin: 'panel', key: 'board' } as const, INITIAL_BOARD, {
  shape: 'panel-board-1',
})
let isBoardKept = false

/** Once per module instance (and at session start): put the kept frames and lanes back into this instance. */
async function keepBoard($: Dollar, isForced = false): Promise<void> {
  if (isBoardKept && !isForced) return
  isBoardKept = true
  const kept = await read($, boardAtom)
  boardAdopt(kept.frames.length === 0 && kept.removedAuto.length === 0 ? undefined : kept, await read($, stateAtom))
  await pulseAdoptLanes($, kept.lanes)
}

/** After a board or lane change: write the board's data to the kept state (only when it differs). */
async function saveBoard($: Dollar): Promise<void> {
  const model = boardKept()
  const next: PanelBoardKeep = { frames: model?.frames ?? [], removedAuto: model?.removedAuto ?? [], lanes: [...pulseLanes()], recent: model?.recent ?? [] }
  await update($, boardAtom, prev => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next))
}

/** The highest event `n` already delivered; a runtime stored before v4 has none. */
const cursorOf = (r: PanelRuntime): number =>
  Number.isInteger(r.eventCursor) && r.eventCursor >= 0 ? r.eventCursor : 0

/** The live terminal view of the stage scene is on unless `/panel live off` said otherwise (kept in the runtime atom, so a reload keeps it). */
const isLiveOn = async ($: Dollar): Promise<boolean> => (await read($, runtimeAtom)).isLiveOff !== true

/** What the ambient Pulse (./pulse-host.ts) needs to know at start; it never touches the atoms itself. */
async function pulseInit($: Dollar): Promise<PulseInit> {
  return { tmp: await tmpDir($), isOff: (await read($, runtimeAtom)).isPulseOff }
}

/** Put the built-in board scene first in the state (and a retired pulse scene out) and mirror it when that changed anything. */
async function syncBoardScene($: Dollar): Promise<void> {
  const dir = await boardSceneDir($)
  if (dir === null) return
  const now = await $.clock.now()
  const before = await read($, stateAtom)
  const state = await update($, stateAtom, prev => withBoard(prev, dir, now))
  if (state !== before) await mirror($, state)
}

/**
 * The agents scene is a tile the mod registers itself once an agent exists (`isWanted`), and refreshes at start when the state
 * already holds it. The model taking it away (`scene {remove}`) keeps it away for the session (`isCrewOff`).
 */
async function syncAgentsInfo($: Dollar, isWanted: boolean): Promise<void> {
  if ((await read($, runtimeAtom)).isCrewOff === true) return
  if (!isWanted && !hasAgentsInfo(await read($, stateAtom))) return
  const dir = await agentsInfoInstall($, await tmpDir($))
  if (dir === null) return
  const now = await $.clock.now()
  const before = await read($, stateAtom)
  const state = await update($, stateAtom, prev => withAgentsInfo(prev, dir, now))
  if (state !== before) await mirror($, state)
}

/** The terminal pane's own choices (which scene is the hero, the details toggle): kept in the runtime atom, redrawn at once. */
async function setView($: Dollar, patch: (r: PanelRuntime) => Partial<PanelRuntime>): Promise<void> {
  await update($, runtimeAtom, r => ({ ...r, ...patch(r) }))
  $.ui.invalidate('ui.render')
}

/** `/panel live on|off|status`: apply it, and say plainly where live stands. */
async function liveCommand($: Dollar, parsed: { verb: LiveVerb } | { usage: string }): Promise<string> {
  if ('usage' in parsed) return parsed.usage
  if (parsed.verb !== 'status') {
    const isOff = parsed.verb === 'off'
    await update($, runtimeAtom, r => ({ ...r, isLiveOff: isOff }))
    if (isOff) await liveStop($)
    else liveEnable($)
  }
  return liveStatusText(await read($, stateAtom), await isLiveOn($))
}

/** Mirror the state to the file the web server watches. Never throws. */
async function mirror($: Dollar, state: PanelState): Promise<void> {
  boardNote(state)
  const { stateFile } = await read($, runtimeAtom)
  if (stateFile === null) return
  try {
    await $.fs.write(stateFile, JSON.stringify(state, null, 2) + '\n')
  } catch (err) {
    log($, `could not write ${stateFile}: ${String(err)}`)
  }
}

async function setUrl($: Dollar, url: string | null): Promise<void> {
  const now = await $.clock.now()
  const state = await update($, stateAtom, s => withUrl(s, url, now))
  await mirror($, state)
}

/**
 * The URL token, minted once per session and kept in the runtime atom, so an
 * open browser tab survives a mod reload. Null when no random source works.
 */
async function ensureToken($: Dollar): Promise<string | null> {
  const held = (await read($, runtimeAtom)).token
  if (held !== null && TOKEN_PATTERN.test(held)) {
    if ((await $.store.get(STORE_TOKEN_KEY).catch(() => undefined)) !== held) await $.store.set(STORE_TOKEN_KEY, held).catch(() => undefined) // a link made before the store existed is kept too
    return held
  }
  // The token outlives the session (`$.store`), so the link in the browser keeps working after a restart.
  const kept = await $.store.get(STORE_TOKEN_KEY).catch(() => undefined)
  if (typeof kept === 'string' && TOKEN_PATTERN.test(kept)) {
    await update($, runtimeAtom, r => ({ ...r, token: kept }))
    return kept
  }
  const minted = await mintToken({
    ...(typeof crypto === 'undefined' || typeof crypto.getRandomValues !== 'function'
      ? {}
      : { random: (bytes: Uint8Array) => crypto.getRandomValues(bytes) }),
    openssl: async () => (await $.process.run([...OPENSSL_ARGV])).stdout,
  })
  if (minted === null) return null
  await $.store.set(STORE_TOKEN_KEY, minted).catch(() => undefined)
  const box = { token: minted }
  await update($, runtimeAtom, r => {
    box.token = r.token !== null && TOKEN_PATTERN.test(r.token) ? r.token : minted
    return { ...r, token: box.token }
  })
  return box.token
}

/**
 * Start web/server.mjs for the life of the module (the child dies with it, a
 * reload starts a new one: see ./server.ts) and publish the url it serves
 * (`PORT <n>` on stdout) as `http://127.0.0.1:<n>/<token>/`.
 */
function startServer($: Dollar, stateFile: string, token: string, roots: readonly string[]): void {
  void (async () => {
    let output = ''
    let isPortRead = false
    try {
      const { lastPort } = await read($, runtimeAtom)
      const folder = await $.session.cwd().catch(() => '')
      const remembered = portMapOf(await $.store.get(STORE_PORTS_KEY).catch(() => undefined))[folder]
      const argv = serverArgv({ pluginRoot: $.plugin.root, stateFile, token, port: lastPort ?? remembered ?? FIRST_PORT, roots })
      for await (const { stream, text } of $.process.spawn({ argv })) {
        if (stream === 'stderr') log($, `web server: ${text.trim()}`)
        else if (!isPortRead) {
          output += text
          const port = parsePort(output)
          if (port !== null) {
            isPortRead = true
            await update($, runtimeAtom, r => ({ ...r, lastPort: port }))
            if (folder !== '') {
              const ports = portMapOf(await $.store.get(STORE_PORTS_KEY).catch(() => undefined))
              if (ports[folder] !== port) await $.store.set(STORE_PORTS_KEY, withPort(ports, folder, port)).catch(() => undefined)
            }
            await setUrl($, serverUrl(port, token))
            await keepBoard($, true)
    await syncBoardScene($)
          }
        }
      }
      log($, 'web server exited')
      await setUrl($, null)
    } catch (err) {
      log($, `web server did not start: ${String(err)}`)
    }
  })()
}

/** Opens the pane the first time only; the person closing it is final. */
async function openPaneOnce($: Dollar): Promise<void> {
  const box: { isFirst: boolean } = { isFirst: false }
  await update($, runtimeAtom, r => {
    box.isFirst = !r.isPaneOpened
    return { ...r, isPaneOpened: true }
  })
  if (!box.isFirst) return
  await tryOpenPane($)
}

// ---- the return channel: undelivered events ------------------------------------------------------------

type Taken = EventsBlock & { before: number; to: number }
const NO_EVENTS: Taken = { count: 0, block: '', omitted: 0, before: 0, to: 0 }

// Reading the file and moving the cursor are one step: two tool calls at once (or a call and a prompt)
// must not both deliver the same lines, nor read a stale copy and rewind the cursor.
let takeQueue: Promise<unknown> = Promise.resolve()

/**
 * The events past the cursor as the block Claude reads, and the cursor moved past them. Never throws:
 * a missing, unreadable or trimmed file just means there is nothing (or everything again, see readEvents).
 */
function takeEvents($: Dollar): Promise<Taken> {
  const step = async (): Promise<Taken> => {
    try {
      const runtime = await read($, runtimeAtom)
      if (runtime.stateFile === null) return NO_EVENTS
      const before = cursorOf(runtime)
      const found = readEvents(await readEventsText($, eventsPath(runtime.stateFile)), before)
      // The cursor is the highest `n` seen. A file whose highest `n` is below it was reset: it follows the file down.
      if (found.last !== before) await update($, runtimeAtom, r => ({ ...r, eventCursor: found.last }))
      // The url and its token are never quoted back to the model.
      const secrets = [(await read($, stateAtom)).url ?? '', runtime.token ?? '']
      // A click on an agent row is the Agents tile talking to the mod (./agent-detail-host.ts), not to the model.
      return { ...eventsBlock(found.events.filter(e => !isAgentsUiEvent(e)), secrets), before, to: found.last }
    } catch (err) {
      log($, `could not read the events: ${String(err)}`)
      return NO_EVENTS
    }
  }
  const run = takeQueue.then(step, step)
  takeQueue = run
  return run
}

/** A prompt that did not enter (another hook dropped it) gets its events back. */
async function giveBack($: Dollar, taken: Taken): Promise<void> {
  await update($, runtimeAtom, r => (cursorOf(r) === taken.to ? { ...r, eventCursor: taken.before } : r))
}

// "sent: <label>" under the answer buttons for a few seconds. A module variable is enough: a reload
// that loses it only ends the note early.
let lastNote: { text: string; at: number } | null = null

/** A press on an answer button of the pane: append the event the browser's buttons write too. */
async function answer($: Dollar, id: string): Promise<void> {
  const choice = (await read($, stateAtom)).choices.find(c => c.id === id)
  const { stateFile } = await read($, runtimeAtom)
  if (choice === undefined || stateFile === null) return
  const now = await $.clock.now()
  const isSent = await appendAnswer($, eventsPath(stateFile), choice, now)
  lastNote = { text: isSent ? `sent: ${choice.label}` : `could not send: ${choice.label}`, at: now }
  $.ui.invalidate('ui.render')
  $.clock.after(SENT_NOTE_MS + 100, () => $.ui.invalidate('ui.render'))
}

/**
 * Screenshot the scene just published (web/shot.mjs through a headless Chrome), hand its lines to the
 * result and, when the scene has no terminal face yet, make the PNG its face WITHOUT bumping any `rev`
 * (the browser must not reload for a picture of itself). Never fails the publish.
 */
async function shoot($: Dollar, state: PanelState, id: string, at: string): Promise<string[]> {
  const scene = state.scenes.find(s => s.id === id)
  if (state.url === null || scene === undefined) return ['shot: unavailable (the browser view has no url yet)']
  const outcome = await runShot(shotEnv($), {
    pluginRoot: $.plugin.root,
    url: state.url,
    id,
    rev: scene.rev,
    at,
    tmp: await tmpDir($),
  })
  const { face } = outcome
  if (face !== undefined) {
    const box = { isChanged: false }
    const next = await update($, stateAtom, prev => {
      const withFace = withShotFace(prev, id, scene.rev, face)
      box.isChanged = withFace !== prev
      return withFace
    })
    if (box.isChanged) await mirror($, next)
  }
  return outcome.lines
}

export const register: Register = (on, options) => {
  applyOptions(options)
  registerPulse(on)

  on('session.start', async ($, e, next) => {
    resetLive()
    await registerTool($, TOOL_NAME, TOOL_DESCRIPTION, TOOL_INPUT_SCHEMA, TOOL_FULL_NAME)
    await registerTool($, SCENE_TOOL_NAME, SCENE_TOOL_DESCRIPTION, SCENE_INPUT_SCHEMA, SCENE_FULL_NAME)
    await $.command.register({
      name: COMMAND_NAME,
      description: COMMAND_DESCRIPTION,
      argumentHint: COMMAND_ARG_HINT,
    })

    const started = await next(e)

    const stateFile = await stateFilePath($)
    await update($, runtimeAtom, r => ({ ...r, stateFile }))
    await mirror($, await read($, stateAtom))
    await pulseStart($, await pulseInit($))
    await boardStart($, await tmpDir($), await read($, stateAtom))
    await syncBoardScene($)
    setAgentsInfoListener(() => void syncAgentsInfo($, true))
    await syncAgentsInfo($, false)
    // The Agents tile's drill-down: this instance owns the loop until another one (a reload) takes the runtime's owner mark.
    const owner = await $.clock.now()
    await update($, runtimeAtom, r => ({ ...r, detailOwner: owner }))
    agentsInfoBind($, { eventsFile: eventsPath(stateFile), isCurrent: async () => (await read($, runtimeAtom)).detailOwner === owner })
    const token = await ensureToken($)
    // Only roots that exist, as real paths: the server exits on a --root it cannot read,
    // and with no --root at all it serves scenes from anywhere.
    const roots = await resolveRoots(sceneFs($), allowedRoots(await sceneEnv($)))
    if (token === null) log($, 'no random source for the url token: the browser view is not started')
    else if (roots.length === 0) log($, 'no scene folder exists to serve from: the browser view is not started')
    else startServer($, stateFile, token, roots)
    return started
  })

  on('tool.call', { tool: TOOL_FULL_NAME }, async ($, e) => {
    const { agentId } = e as typeof e & Reserved
    const planned = planLanes(modelInput(e as typeof e & Reserved))
    if (!planned.isOk) return { deny: planned.error }
    const { plan } = planned
    const framed = planFrames(plan.rest)
    if (!framed.isOk) return { deny: framed.error }
    const frames = framed.plan
    const input = frames.rest
    // A lane-only or frame-only call (a worker's one-line progress, a frame on the board) is no panel update: it changes
    // no section and leaves the browser's events for the main session. The main session's frame call also opens the pane.
    if ((hasLanePart(plan) || hasFramePart(frames)) && Object.keys(input).length === 0) {
      await keepBoard($)
      const parts = await applyParts($, plan, frames, agentId, await read($, stateAtom))
      await saveBoard($)
      if (parts.deny !== undefined) return { deny: parts.deny }
      if (agentId !== undefined || !hasFramePart(frames)) return { result: parts.lines.join(RESULT_JOIN) }
      await openPaneOnce($)
      return { result: joinResult([...parts.lines, eventsResult(await takeEvents($))]) }
    }
    pulseSelfCall($, agentId, TOOL_NAME)
    // No fields at all: a poll for events. Nothing changes, so nothing is bumped, mirrored or opened.
    if (Object.keys(input).length === 0) {
      const taken = await takeEvents($)
      const line = resultLine(await read($, stateAtom), [])
      return { result: [line, taken.count === 0 ? 'events: 0 new' : eventsResult(taken)].join(RESULT_JOIN) }
    }
    const now = await $.clock.now()
    const box: { outcome?: ApplyResult } = {}
    const state = await update($, stateAtom, prev => {
      box.outcome = applyInput(prev, input, now)
      return box.outcome.isOk ? box.outcome.state : prev
    })
    const outcome = box.outcome
    if (outcome === undefined || !outcome.isOk)
      return { deny: outcome?.error ?? `${PLUGIN_NAME}: no input` }

    await mirror($, state)
    await openPaneOnce($)
    await keepBoard($)
    const parts = await applyParts($, plan, frames, agentId, state)
    if (hasLanePart(plan) || hasFramePart(frames)) await saveBoard($)
    // The browser's events belong to the main session: a worker's call leaves them be.
    const events = agentId === undefined ? eventsResult(await takeEvents($)) : ''
    return { result: joinResult([resultLine(state, outcome.trimmed), ...(parts.deny === undefined ? parts.lines : [parts.deny]), events]) }
  })

  on('tool.call', { tool: SCENE_FULL_NAME }, async ($, e) => {
    const prepared = await prepareScene(modelInput(e as typeof e & Reserved), await sceneEnv($), sceneFs($), sceneIo($)).then(
      action => ({ action }),
      (err: unknown) => {
        if (err instanceof Invalid) return { error: err.message }
        throw err
      },
    )
    if ('error' in prepared) return { deny: sceneDeny(prepared.error) }
    const { action } = prepared
    // {id, goto}: only moves the live terminal view; the state, the browser and the pane are untouched.
    if (action.kind === 'goto') {
      const isKnown = (await read($, stateAtom)).scenes.some(s => s.id === action.id)
      const line = isKnown ? await liveGoto($, action.id, action.hash) : `live: no scene "${action.id}"`
      return { result: joinResult([line, eventsResult(await takeEvents($))]) }
    }
    // {id, data}: only rewrites live/data.json; no rev, no reload, no screenshot.
    if (action.kind === 'data') {
      const sent = await sendData($, await read($, stateAtom), action.id, action.text)
      if ('error' in sent) return { deny: sceneDeny(sent.error) }
      return { result: joinResult([sent.line, eventsResult(await takeEvents($))]) }
    }
    // `shot_at` is also where the live view opens. Set before the state changes: the pane's redraw may restart it at once.
    if (action.kind === 'upsert') liveSetHash($, action.scene.id, action.shot.at)
    const now = await $.clock.now()
    // Fixing a scene already published is not a new form; only a new scene id counts for the variety nudge.
    const isNewScene = action.kind === 'upsert' && !(await read($, stateAtom)).scenes.some(s => s.id === action.scene.id)
    const box: { outcome?: ReturnType<typeof applyUserScene> } = {}
    const state = await update($, stateAtom, prev => {
      box.outcome = applyUserScene(prev, action, now)
      return box.outcome.isOk ? box.outcome.state : prev
    })
    const outcome = box.outcome
    if (outcome === undefined || !outcome.isOk) {
      if (action.kind === 'upsert') liveSetHash($, action.scene.id, '')
      return { deny: outcome?.error ?? `${PLUGIN_NAME}: no input` }
    }

    await mirror($, state)
    if (action.kind === 'remove' && action.id === AGENTS_INFO_SCENE_ID) await update($, runtimeAtom, r => ({ ...r, isCrewOff: true }))
    await openPaneOnce($)
    const lines = [outcome.line]
    if (isNewScene) {
      await keepBoard($)
      boardNoteScene(state)
      await saveBoard($)
      const hint = boardVarietyHint()
      if (hint !== '') lines.push(hint)
    }
    // A new stage scene is a tile of the workspace beside the board (its `slot` places it); it does not take the big
    // tile from the board. Only the person's pick (the switcher) sets the hero.
    if (action.kind === 'upsert' && action.shot.isWanted) lines.push(...(await shoot($, state, action.scene.id, action.shot.at)))
    return { result: joinResult([...lines, eventsResult(await takeEvents($))]) }
  })

  on('command.run', { command: COMMAND_NAME }, async ($, e) => {
    await update($, runtimeAtom, r => ({ ...r, isPaneOpened: true }))
    await tryOpenPane($)
    const live = parseLiveArgs(e.args)
    if (live !== undefined) return { text: await liveCommand($, live) }
    const watch = parseWatchArgs(e.args)
    if (watch !== undefined) return { text: await watchCommand($, watch) }
    const pulse = parsePulseArgs(e.args)
    if (pulse !== undefined) {
      const url = (await read($, stateAtom)).url
      const done = await pulseCommand($, pulse, await pulseInit($), url)
      if (done.saveOff !== undefined) await update($, runtimeAtom, r => ({ ...r, isPulseOff: done.saveOff }))
      return { text: done.text }
    }
    const plan = planCommand(e.args, await read($, stateAtom))
    if (plan.open !== undefined && !(await openInBrowser($, plan.open)))
      return { text: `${plan.text} (could not open a browser)` }
    return { text: plan.text }
  })

  // Events ride beside the next message as `context` (the model reads it, the person's own text and the
  // prompt history stay untouched). Slash commands, shell escapes and prompts the person did not type
  // get nothing; the cursor only moves for a prompt that enters.
  on('prompt.submit', async ($, e, next) => {
    if (e.command !== undefined || e.isMeta === true || NOT_A_MESSAGE.test(e.text)) return next(e)
    const taken = await takeEvents($)
    if (taken.count === 0) return next(e)
    const entered = await next({ ...e, context: [...(e.context ?? []), taken.block] })
    if (entered.drop !== undefined) await giveBack($, taken)
    return entered
  })

  on('prompt.compose', async ($, e, next) => {
    const { sections } = await next(e)
    await keepBoard($)
    const hint = boardVarietyHint()
    return {
      sections: [...sections, { id: SECTION_ID, text: hint === '' ? BASELINE_TEXT : `${BASELINE_TEXT}\n${hint}`, scope: 'session' }],
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE_ID }, async ($, e) => {
    const held = lastNote
    const isFresh = held !== null && (await $.clock.now()) - held.at < SENT_NOTE_MS
    const state = await read($, stateAtom)
    // The live view lives on the terminal only. Every draw lets it start, restart or stop (it never throws,
    // and is not waited for); the tree takes the newest frame, so a redraw does not bring the old picture back.
    const isTerminal = e.surface === 'terminal'
    const view = await read($, runtimeAtom)
    if (isTerminal) void liveSync($, { state, isEnabled: view.isLiveOff !== true, tmp: () => tmpDir($), heroId: view.heroId ?? null })
    const live = isTerminal ? liveView() : null
    let box: { columns: number; rows: number } | null = null
    const tree = await paneTree($, e, state, {
      heroId: view.heroId ?? null,
      onHero: id => void setView($, () => ({ heroId: id })),
      onLiveBox: b => {
        box = b
      },
      ...(held !== null && isFresh ? { note: held.text } : {}),
      onAnswer: id => void answer($, id),
      live,
      agents: agentsInfoControls(),
      onAgent: key => void agentsInfoPress($, key),
      onLive: step => void liveStep($, step),
      onScroll: action => void liveScroll($, SCROLL_MOVES[action]),
    })
    await liveRendered($, live)
    if (isTerminal) liveResize($, box)
    return tree
  })

  // The person's wheel and scroll keys on the pane. The picture fills the pane, so the engine has nothing to move: the same
  // gesture scrolls the hero tile of the live page instead. A tree that does overflow (a tall ask box) keeps the engine's scroll.
  on('ui.scroll', { component: 'Pane', requestId: PANE_ID }, async ($, e, next) => {
    const move = e.contentRows > e.bodyRows ? null : scrollMoveOf(e.by, e.bodyRows)
    return move !== null && liveScroll($, move) ? {} : next(e)
  })

  // A closed pane draws nothing: its live child would run for no one, and the blit it makes next would be refused
  // and held against the terminal. Stop it; the next draw (the pane reopened) starts it again.
  on('ui.close', async ($, e, next) => {
    const closed = await next(e)
    if (e.id === PANE_ID) await liveStop($)
    return closed
  })
}
