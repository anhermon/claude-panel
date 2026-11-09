// Self-check screenshots: after a scene is published the mod runs web/shot.mjs (a headless Chrome
// capture, written separately) on the scene's page and hands Claude the PNG path and the page's
// console errors. The PNG also becomes the scene's terminal face when it has none. Pure apart from
// the `ShotEnv` it is given (process, stat, exists), so the tests drive it with a fake process.
// A shot NEVER fails the publish: every problem comes back as `shot: unavailable (<reason>)`.
import { SCENE_CAPS, sceneUrl } from './scene'
import { NODE_BIN } from './server'

export const SHOT_SCRIPT = 'web/shot.mjs'
/** The mod's bound for the whole step; a longer run is killed. */
export const SHOT_TIMEOUT_MS = 20_000
/** shot.mjs's own `--timeout`: below the bound, so it closes Chrome itself instead of being killed mid-run. */
export const SHOT_CHILD_TIMEOUT_MS = 15_000
export const SHOT_WIDTH = 1280
export const SHOT_HEIGHT = 720
export const SHOT_WAIT_MS = 1500
export const SHOT_DIR = 'shots'
export const SHOT_STATE_DIR = 'claude-panel'
export const MAX_CONSOLE_LINES = 5
export const LINE_CHARS = 200
const REASON_CHARS = 120
export const SIPS_ARGV = ['sips', '-Z', String(SHOT_WIDTH)] as const
const PNG_EXTENSION = '.png'
const RESIZED_SUFFIX = '-small.png'
const TIMEOUT_WORDS = /time(d)? ?out|still running/i

/** What the shot step needs from the outside; the mod hands in `$.process.run`, `$.fs.stat` and `$.fs.exists`. */
export type ShotEnv = {
  run: (argv: readonly string[], timeoutMs: number) => Promise<{ exitCode: number; stdout: string; stderr: string }>
  stat: (path: string) => Promise<{ size: number } | undefined>
  exists: (path: string) => Promise<boolean>
}

export type ShotRequest = {
  /** `$.plugin.root` */
  pluginRoot: string
  /** The panel url (ends with `/`). */
  url: string
  id: string
  rev: number
  /** The location hash to open (`#/3`) or ''. */
  at: string
  /** `$TMPDIR` */
  tmp: string
}

export type ShotOutcome = {
  /** Lines for the tool result: `shot: ...` and the console errors. */
  lines: string[]
  /** A PNG that can be the scene's terminal face (<= 2 MiB), when there is one. */
  face?: string
}

const oneLine = (s: string, max: number): string => {
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : flat.slice(0, max - 1) + '…'
}

/** `<tmp>/claude-panel/shots/<id>-<rev>.png` */
export const shotPath = (tmp: string, id: string, rev: number): string =>
  `${tmp.replace(/\/+$/, '')}/${SHOT_STATE_DIR}/${SHOT_DIR}/${id}-${rev}.png`

/** `node <root>/web/shot.mjs <url>s/<id>/<at> --out <png> --width 1280 --height 720 --wait 1500 --timeout 15000` */
export function shotArgv(r: ShotRequest, out: string): string[] {
  return [
    NODE_BIN,
    `${r.pluginRoot}/${SHOT_SCRIPT}`,
    sceneUrl(r.url, r.id) + r.at,
    '--out', out,
    '--width', String(SHOT_WIDTH),
    '--height', String(SHOT_HEIGHT),
    '--wait', String(SHOT_WAIT_MS),
    '--timeout', String(SHOT_CHILD_TIMEOUT_MS),
  ]
}

export type ShotReport = { ok: boolean; png?: string; error?: string; errors: string[] }

const textOf = (v: unknown): string | undefined => {
  if (typeof v === 'string') return v
  if (typeof v === 'object' && v !== null && typeof (v as { text?: unknown }).text === 'string') return (v as { text: string }).text
  return undefined
}

/** The one JSON line shot.mjs prints (the last line that parses to an object with a boolean `ok`), or undefined. */
export function parseShot(stdout: string): ShotReport | undefined {
  for (const line of stdout.split('\n').reverse()) {
    let v: unknown
    try {
      v = JSON.parse(line)
    } catch {
      continue
    }
    if (typeof v !== 'object' || v === null) continue
    const o = v as Record<string, unknown>
    if (typeof o.ok !== 'boolean') continue
    const errors = [
      ...(Array.isArray(o.errors) ? o.errors : []).map(textOf),
      ...(Array.isArray(o.console) ? o.console : []).flatMap(c => (c as { level?: unknown })?.level === 'error' ? [textOf(c)] : []),
    ].flatMap(t => (t === undefined || t.trim() === '' ? [] : [oneLine(t, LINE_CHARS)]))
    return {
      ok: o.ok,
      ...(typeof o.png === 'string' ? { png: o.png } : {}),
      ...(typeof o.error === 'string' ? { error: o.error } : {}),
      errors,
    }
  }
  return undefined
}

const unavailable = (why: string): ShotOutcome => ({ lines: [`shot: unavailable (${oneLine(why, REASON_CHARS)})`] })

const errorLines = (r: ShotReport): string[] => [...new Set(r.errors)].slice(0, MAX_CONSOLE_LINES).map(t => `console error: ${t}`)

/** A PNG within the engine's Image limit: the file itself, or `sips -Z 1280` of it once, else none. */
async function faceOf(env: ShotEnv, png: string, info: { size: number }): Promise<string | undefined> {
  if (info.size <= SCENE_CAPS.IMAGE_BYTES) return png
  const small = png.replace(/\.png$/i, '') + RESIZED_SUFFIX
  try {
    const { exitCode } = await env.run([...SIPS_ARGV, '--out', small, png], SHOT_TIMEOUT_MS)
    const made = exitCode === 0 ? await env.stat(small) : undefined
    return made !== undefined && made.size <= SCENE_CAPS.IMAGE_BYTES ? small : undefined
  } catch {
    return undefined
  }
}

/** Take the screenshot. Never throws. */
export async function runShot(env: ShotEnv, r: ShotRequest): Promise<ShotOutcome> {
  try {
    if (!(await env.exists(`${r.pluginRoot}/${SHOT_SCRIPT}`))) return unavailable(`${SHOT_SCRIPT} is missing`)
    const out = shotPath(r.tmp, r.id, r.rev)
    let done: Awaited<ReturnType<ShotEnv['run']>>
    try {
      done = await env.run(shotArgv(r, out), SHOT_TIMEOUT_MS)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return unavailable(TIMEOUT_WORDS.test(message) ? `timed out after ${SHOT_TIMEOUT_MS / 1000} s` : message)
    }
    const report = parseShot(done.stdout)
    if (report === undefined) {
      const why = oneLine(done.stderr, REASON_CHARS)
      return unavailable(why === '' ? `no result from ${SHOT_SCRIPT}, exit ${done.exitCode}` : why)
    }
    if (!report.ok) return { lines: [unavailable(report.error ?? 'the page could not be captured').lines[0] as string, ...errorLines(report)] }
    const png = report.png !== undefined && report.png.startsWith('/') && report.png.endsWith(PNG_EXTENSION) ? report.png : out
    const info = await env.stat(png)
    if (info === undefined) return { lines: [unavailable('no PNG was written').lines[0] as string, ...errorLines(report)] }
    const face = await faceOf(env, png, info)
    return { lines: [`shot: ${png}`, ...errorLines(report)], ...(face === undefined ? {} : { face }) }
  } catch (err) {
    return unavailable(err instanceof Error ? err.message : String(err))
  }
}
