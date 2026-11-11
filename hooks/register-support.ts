// Helpers of register.tsx that touch no atom: names and paths, the tool registration, opening the pane and the
// browser, the shape of what the model sends. They take `$` (function declarations only, as the engine's static
// check wants); the atoms and everything that reads or writes them stay in register.tsx.
import type { EngineInterface } from 'claude-code'

import { inlineScenesDir } from './scene-fs'
import type { SceneEnv, SceneFs } from './scene-fs'
import { COMMAND_GLOBAL_ARG, COMMAND_OPEN_ARG, PANE_ID, PANE_TITLE, PLUGIN_NAME, SCENE_TOOL_NAME } from './spec'

export type Dollar = EngineInterface
export type Reserved = { tool: unknown; tool_use_id: unknown; agentId?: unknown; requestMeta?: unknown }

// Where the state file lives: $TMPDIR (else /tmp), a folder of our own, one
// file per SESSION id (never the cwd). `$.fs.write` takes any absolute path
// and creates the folders; tmp is cleaned up by the OS.
const FALLBACK_TMP_DIR = '/tmp'
const STATE_DIR_NAME = 'claude-panel'
export const COMMAND_DESCRIPTION =
  'Show the live panel pane; "/panel open" opens the browser view, "/panel open <scene>" one scene, "/panel global" the read-only overview of every Claude Code session of the last 48 hours, "/panel live on|off|status" the live stage preview, "/panel pulse on|off|status" the ambient pulse'
export const COMMAND_ARG_HINT = `[${COMMAND_OPEN_ARG} [scene-id] | ${COMMAND_GLOBAL_ARG} | live on|off|status | pulse on|off|status]`
const DARWIN = 'Darwin'
const OPEN_MAC = 'open'
const OPEN_LINUX = 'xdg-open'
export const RESULT_JOIN = '\n'

export const joinResult = (lines: readonly string[]): string => lines.filter(l => l !== '').join(RESULT_JOIN)

export function log($: Dollar, text: string): void {
  $.ui.log(`${PLUGIN_NAME}: ${text}`, { to: 'debug' })
}

/** What the model sent: everything but the engine's envelope. */
export function modelInput(e: Reserved): Record<string, unknown> {
  const { tool, tool_use_id, agentId, requestMeta, ...input } = e
  return input
}

// Field errors already read `scene.dir ...`; the others (`input must be ...`) get the tool's name in front.
export const sceneDeny = (message: string): string =>
  message.startsWith(SCENE_TOOL_NAME) ? message : `${SCENE_TOOL_NAME}: ${message}`

export async function tmpDir($: Dollar): Promise<string> {
  return ((await $.env.get('TMPDIR')) ?? FALLBACK_TMP_DIR).replace(/\/+$/, '')
}

export async function stateFilePath($: Dollar): Promise<string> {
  const id = await $.session.id()
  return `${await tmpDir($)}/${STATE_DIR_NAME}/panel-${id}.json`
}

/** `$.fs.stat` as the scene checks want it: real path resolved, a missing path is undefined. */
export function sceneFs($: Dollar): SceneFs {
  return {
    stat: async path => {
      try {
        const { kind, size, realPath } = await $.fs.stat(path, { resolve: true })
        return { kind, size, ...(realPath === undefined ? {} : { realPath }) }
      } catch {
        return undefined
      }
    },
  }
}

export async function sceneEnv($: Dollar): Promise<SceneEnv> {
  const home = await $.env.get('HOME')
  const tmp = await tmpDir($)
  const scenesDir = inlineScenesDir(tmp, await $.session.id())
  return { cwd: await $.session.cwd(), scenesDir, tmp, ...(home === undefined ? {} : { home }) }
}

export async function registerTool(
  $: Dollar,
  name: string,
  description: string,
  inputSchema: Record<string, unknown>,
  fullName: string,
): Promise<void> {
  const registered = await $.tool.register({ name, description, inputSchema, isDeferred: false })
  if (registered.tool !== fullName) log($, `tool is listed as ${registered.tool}, not ${fullName}`)
}

/**
 * Open the pane without ever failing the caller: a headless run (`-p`, SDK) has
 * no surface, which `ui.open` reports as `no-surface` (a rejection, or an
 * undrawn result with that reason). That is normal, so it is only debug-logged.
 */
export async function tryOpenPane($: Dollar): Promise<void> {
  try {
    const opened = await $.ui.open({ id: PANE_ID, title: PANE_TITLE })
    if (!opened.isPlaced) log($, `pane is open but not drawn: ${opened.reason}`)
  } catch (err) {
    log($, `could not open the pane: ${String(err)}`)
  }
}

export async function openInBrowser($: Dollar, url: string): Promise<boolean> {
  try {
    const { stdout } = await $.process.run(['uname', '-s'])
    const opener = stdout.trim() === DARWIN ? OPEN_MAC : OPEN_LINUX
    const { exitCode } = await $.process.run([opener, url])
    return exitCode === 0
  } catch {
    return false // no uname / xdg-open (Windows, a bare container): the caller says "could not open a browser" and prints the url
  }
}
