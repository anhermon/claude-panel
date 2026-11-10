// Pure helpers around the web server child: the URL token, the command line and
// the url. No `$`: the mod passes in what it can do (random bytes, openssl).
//
// Hot reload: the engine kills a spawned child when the module that spawned it
// unloads ("the module unloading kills the child", `$.process.spawn`), and a
// reload loads a fresh module that gets `session.start` again. So a reload
// replaces the server; it does not leak a second one. The token and the last
// port live in the runtime atom, which outlives the reload, so the new child is
// started with the same token and asked for the same port: an open browser tab
// keeps working.

export const TOKEN_BYTES = 16
export const TOKEN_PATTERN = /^[0-9a-f]{32}$/
const HEX_RADIX = 16
const HEX_DIGITS = 2
export const NODE_BIN = 'node'
export const SERVER_RELATIVE_PATH = 'web/server.mjs'
export const SERVER_HOST = '127.0.0.1'
/** `--port 0`: no preferred port yet. */
export const NO_PORT = 0
/**
 * The link must survive a restart of the session: the token and the port each folder last got live in `$.store` (which outlives
 * sessions), so the same project opens the same `http://127.0.0.1:<port>/<token>/` every time. A port that is taken makes the
 * server try the next ones (web/server.mjs), so two sessions at once still work, on neighbouring ports.
 */
export const STORE_TOKEN_KEY = 'link.token'
export const STORE_PORTS_KEY = 'link.ports'
/** Where a folder's port search starts when it has none stored (web/server.mjs DEFAULT_PORT). */
export const FIRST_PORT = 4717
const MAX_REMEMBERED_FOLDERS = 64

export type PortMap = Record<string, number>

/** The stored folder -> port map; anything odd in the stored value is dropped. */
export function portMapOf(raw: unknown): PortMap {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const out: PortMap = {}
  for (const [folder, port] of Object.entries(raw)) if (typeof port === 'number' && Number.isInteger(port) && port > 0 && port < 65536) out[folder] = port
  return out
}

/** The map with `folder` -> `port` (the newest last), at most MAX_REMEMBERED_FOLDERS folders. */
export function withPort(map: PortMap, folder: string, port: number): PortMap {
  const { [folder]: _old, ...rest } = map
  const entries = Object.entries({ ...rest, [folder]: port })
  return Object.fromEntries(entries.slice(-MAX_REMEMBERED_FOLDERS))
}
/** The documented override (web/server.mjs): a valid value wins over the remembered port; the server still falls back to neighbours. */
// (the engine's static check wants the literal name at the `$.env.get('CLAUDE_PANEL_PORT')` call in register.tsx)
const MAX_PORT = 65535

/** The env port when it is an integer in 1..65535 (0 means "any" and is not an override); null otherwise. */
export function envPortOf(raw: string | undefined): number | null {
  const text = (raw ?? '').trim()
  if (!/^\d+$/.test(text)) return null
  const port = Number(text)
  return port > 0 && port <= MAX_PORT ? port : null
}

/** Which port to ask for: env override, else the live one, else the folder's remembered one, else the default. */
export const preferredPort = (env: number | null, last: number | null, remembered: number | undefined): number => env ?? last ?? remembered ?? FIRST_PORT

export const OPENSSL_ARGV = ['openssl', 'rand', '-hex', String(TOKEN_BYTES)] as const

export type TokenSources = {
  /** `crypto.getRandomValues`, where the runtime has it. */
  random?: (bytes: Uint8Array) => Uint8Array
  /** `openssl rand -hex 16` through the process API; its stdout. */
  openssl: () => Promise<string>
}

export const hexOf = (bytes: Uint8Array): string =>
  Array.from(bytes, b => b.toString(HEX_RADIX).padStart(HEX_DIGITS, '0')).join('')

/**
 * A fresh 128-bit token as 32 hex characters: from the runtime's random source
 * when it has one, else from openssl. Null when neither works (the caller then
 * starts no server: there is no safe token to put in the url).
 */
export async function mintToken(sources: TokenSources): Promise<string | null> {
  if (sources.random !== undefined) {
    try {
      const token = hexOf(sources.random(new Uint8Array(TOKEN_BYTES)))
      if (TOKEN_PATTERN.test(token)) return token
    } catch {
      // fall through to openssl
    }
  }
  try {
    const token = (await sources.openssl()).trim().toLowerCase()
    return TOKEN_PATTERN.test(token) ? token : null
  } catch {
    return null
  }
}

export type ServerLaunch = {
  /** `$.plugin.root` */
  pluginRoot: string
  stateFile: string
  token: string
  /** The port the last server bound, tried first; null when there is none. */
  port: number | null
  /** Folders a scene may live in, passed as one `--root` each. */
  roots: readonly string[]
}

/** `node <root>/web/server.mjs <stateFile> --token T --port P --root DIR...` */
export function serverArgv(l: ServerLaunch): string[] {
  return [
    NODE_BIN,
    `${l.pluginRoot}/${SERVER_RELATIVE_PATH}`,
    l.stateFile,
    '--token',
    l.token,
    '--port',
    String(l.port ?? NO_PORT),
    ...l.roots.flatMap(r => ['--root', r]),
  ]
}

/** `http://127.0.0.1:<port>/<token>/`: the panel page; `s/<id>/` under it is a scene. */
export const serverUrl = (port: number, token: string): string => `http://${SERVER_HOST}:${port}/${token}/`
