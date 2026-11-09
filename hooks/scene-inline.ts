// Pure rules of the two cheap ways to show something with the `scene` tool: INLINE content (`html`, or `files`
// instead of a `dir` the model had to write first) and the live DATA channel (`data` -> live/data.json).
// No `$`, no I/O: scene.ts calls these while it parses, scene-io.ts writes the result. Every refusal throws
// `Invalid`, naming the field and saying how to fix it.
import { Invalid, isAbsent, isPlain } from './blocks/common'

export const INLINE_CAPS = {
  HTML_BYTES: 256 * 1024,
  FILES: 24,
  FILES_BYTES: 1024 * 1024,
  DATA_BYTES: 64 * 1024,
  PATH_CHARS: 200,
} as const

export const INLINE_ENTRY = 'index.html'
/** The TEXT part of the server's scene allow-list (web/scene-files.mjs); binary assets still need a `dir`. */
export const INLINE_EXTENSIONS = ['html', 'css', 'js', 'mjs', 'json', 'svg', 'txt'] as const
/** The top-level folder the server serves but never reloads a scene for, and the file `data` writes in it. */
export const LIVE_DIR = 'live'
export const LIVE_DATA_FILE = 'data.json'
export const LIVE_DATA_PATH = `${LIVE_DIR}/${LIVE_DATA_FILE}`
const NUL = '\u0000'
const SEP = '/'
const FIRST_SURROGATE = 0xd800
const LAST_SURROGATE = 0xdbff
const UTF8_ONE = 0x7f
const UTF8_TWO = 0x7ff
const UTF8_THREE = 3
const UTF8_FOUR = 4
const UTF8_TWO_BYTES = 2

/** What an inline publish carries: every file of the folder as text, and which one is the page. */
export type InlineSource = { files: Record<string, string>; entry: string }

/** UTF-8 length of a string (no TextEncoder or Buffer needed in the mod's sandbox). */
export function utf8Bytes(s: string): number {
  let n = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c <= UTF8_ONE) n += 1
    else if (c <= UTF8_TWO) n += UTF8_TWO_BYTES
    else if (c >= FIRST_SURROGATE && c <= LAST_SURROGATE) {
      n += UTF8_FOUR
      i++ // the low half of the pair
    } else n += UTF8_THREE
  }
  return n
}

/** `262144 bytes (256 KB)`: exact, so a call just over the limit does not read as equal to it. */
const sizeOf = (bytes: number): string => `${bytes} bytes (${Math.round(bytes / 1024)} KB)`

/** A path inside the folder: relative, plain segments (no `..`, dotfiles, empty parts), a text extension. */
export function filePath(path: string): string {
  const name = `scene.files[${JSON.stringify(path)}]`
  const bad = (why: string): Invalid =>
    new Invalid(`${name} ${why}: use a plain relative path such as "index.html", "app.js" or "css/style.css"`)
  if (path === '' || path.length > INLINE_CAPS.PATH_CHARS || path.includes(NUL)) throw bad('is empty, too long or holds a NUL')
  if (path.startsWith(SEP)) throw bad('must not start with "/"')
  if (path.includes('\\')) throw bad('must use "/" separators')
  const segments = path.split(SEP)
  if (segments.includes('..')) throw bad('must not contain ".." segments')
  if (segments.some(s => s === '' || s.startsWith('.'))) throw bad('must not have a dotfile, "./" or empty segment')
  const last = segments[segments.length - 1] as string
  const ext = last.includes('.') ? last.slice(last.lastIndexOf('.') + 1).toLowerCase() : ''
  if (!(INLINE_EXTENSIONS as readonly string[]).includes(ext))
    throw new Invalid(
      `${name} has an extension that cannot be sent inline (allowed: ${INLINE_EXTENSIONS.join(', ')}): ` +
        'write binary assets (images, audio, models) to a folder and publish it with dir',
    )
  return path
}

/** `html`: one page, written as index.html. */
export function inlineHtml(v: string): InlineSource {
  if (v.trim() === '') throw new Invalid('scene.html is empty: send a page or a fragment, for example "<h1>Hello</h1>"')
  const size = utf8Bytes(v)
  if (size > INLINE_CAPS.HTML_BYTES)
    throw new Invalid(
      `scene.html is ${sizeOf(size)}; the limit is ${sizeOf(INLINE_CAPS.HTML_BYTES)}: split it into scene.files (html, css, js) or write a folder and publish it with dir`,
    )
  return { files: { [INLINE_ENTRY]: v }, entry: INLINE_ENTRY }
}

/** `files` + `entry`: {relative path: text}, the page named by `entry` (default index.html) must be one of them. */
export function inlineFiles(v: unknown, entry: string): InlineSource {
  if (!isPlain(v)) throw new Invalid('scene.files must be an object {"index.html": "<h1>...</h1>", "app.js": "..."}: relative path -> text')
  const paths = Object.keys(v)
  if (paths.length === 0) throw new Invalid(`scene.files is empty: send at least "${entry}"`)
  if (paths.length > INLINE_CAPS.FILES)
    throw new Invalid(`scene.files has ${paths.length} files; the limit is ${INLINE_CAPS.FILES}: merge some, or write a folder and publish it with dir`)
  const files: Record<string, string> = {}
  let total = 0
  for (const path of paths) {
    filePath(path)
    const text = v[path]
    if (typeof text !== 'string') throw new Invalid(`scene.files[${JSON.stringify(path)}] must be a string (the file's text)`)
    total += utf8Bytes(text)
    files[path] = text
  }
  if (total > INLINE_CAPS.FILES_BYTES)
    throw new Invalid(`scene.files holds ${sizeOf(total)}; the limit is ${sizeOf(INLINE_CAPS.FILES_BYTES)}: shorten it, or write a folder and publish it with dir`)
  if (!(entry in files))
    throw new Invalid(`scene.entry "${entry}" is not in scene.files (${paths.join(', ')}): add it to files, or set entry to one of them`)
  return { files, entry }
}

/** Which of dir | html | files was sent: exactly one is allowed; none or several are refused naming the fix. */
export function sourceOf(input: Record<string, unknown>): 'dir' | 'html' | 'files' {
  const given = (['dir', 'html', 'files'] as const).filter(k => !isAbsent(input[k]))
  if (given.length > 1)
    throw new Invalid(`scene.${given.join(' and scene.')} cannot be combined: send exactly one of dir, html or files`)
  if (given.length === 0)
    throw new Invalid(
      'scene.dir is required: the absolute path of the folder that holds the scene\'s files (or send html or files instead; fastest is {id, html, alt})',
    )
  return given[0] as 'dir' | 'html' | 'files'
}

/** `data`: any JSON, serialized text <= 64 KB; the exact text that is written to live/data.json. */
export function dataText(v: unknown): string {
  if (v === null) throw new Invalid('scene.data must not be null: send any other JSON value (an object, array, number, string or boolean)')
  let text: string | undefined
  try {
    text = JSON.stringify(v)
  } catch {
    text = undefined
  }
  if (text === undefined) throw new Invalid('scene.data is not JSON-serialisable: send plain JSON')
  const size = utf8Bytes(text)
  if (size > INLINE_CAPS.DATA_BYTES)
    throw new Invalid(`scene.data is ${size} bytes as JSON; the limit is ${INLINE_CAPS.DATA_BYTES}: send less (a summary or the latest rows)`)
  return text
}

export const dataResultLine = (text: string): string => `data: written (${utf8Bytes(text)} bytes) -> ${LIVE_DATA_PATH}`
