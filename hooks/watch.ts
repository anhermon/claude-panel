// `/panel watch <folder>`: the router-kit frames follow a run in ANOTHER folder than the session's shell cwd (which is reset
// after each Bash call that leaves the project). The folder lives in `$.store`; board-host.ts reads it every tick.
import type { EngineInterface } from 'claude-code'

import { ROUTER_IO, readRouter } from './router-io'

type Dollar = EngineInterface

export const WATCH_ARG = 'watch'
export const WATCH_STORE_KEY = 'router.watch'
export const WATCH_USAGE = 'usage: /panel watch <absolute folder of the run, or its .router folder> | off | (nothing: show)'
const WATCH_OFF_WORDS: readonly string[] = ['off', 'clear']
const ROUTER_SUFFIX = new RegExp(`/${ROUTER_IO.DIR.replace('.', '\\.')}$`)

export type WatchParsed = { verb: 'show' } | { verb: 'off' } | { verb: 'set'; folder: string } | { usage: string }

/** A folder given as the repo or its `.router`: absolute, no trailing slash, no trailing `/.router`. */
export function watchFolderOf(raw: string): string | undefined {
  const folder = raw.trim().replace(/\/+$/, '').replace(ROUTER_SUFFIX, '').replace(/\/+$/, '')
  return raw.trim().startsWith('/') && folder !== '' ? folder : undefined
}

/** `/panel watch [<folder>|off|clear]`; undefined when the args are not about watch. */
export function parseWatchArgs(args: string): WatchParsed | undefined {
  const text = args.trim()
  const [first = ''] = text.split(/\s+/)
  if (first !== WATCH_ARG) return undefined
  const rest = text.slice(first.length).trim()
  if (rest === '') return { verb: 'show' }
  if (WATCH_OFF_WORDS.includes(rest)) return { verb: 'off' }
  const folder = watchFolderOf(rest)
  return folder === undefined ? { usage: WATCH_USAGE } : { verb: 'set', folder }
}

/** The watched folder from the store, or undefined (follow the session cwd). Never throws. */
export async function watchedFolder($: Dollar): Promise<string | undefined> {
  const v = await $.store.get(WATCH_STORE_KEY).catch(() => undefined)
  return typeof v === 'string' && v !== '' ? v : undefined
}

async function runText($: Dollar, folder: string): Promise<string> {
  const { run } = await readRouter($, folder)
  return run === undefined ? 'no .router/tickets yet' : `${run.tickets.length} tickets`
}

/** Apply the verb and say what is watched. */
export async function watchCommand($: Dollar, parsed: WatchParsed): Promise<string> {
  if ('usage' in parsed) return parsed.usage
  if (parsed.verb === 'set') await $.store.set(WATCH_STORE_KEY, parsed.folder)
  if (parsed.verb === 'off') await $.store.delete(WATCH_STORE_KEY)
  const folder = await watchedFolder($)
  if (folder === undefined) return `following the session folder ${await $.session.cwd()}`
  return `watching ${folder}: ${await runText($, folder)}`
}
