// Shared by the end-to-end tests: boots the mod with everything beneath it
// stood in for (clock, env, file system, processes, the web server).
import { mock } from 'claude-code/testing'
import type { Engine, Mounted } from 'claude-code/testing'
import type { On, ProcessRunInit, UiBlitArgs, UiBlitResult } from 'claude-code'

export const TOOL = 'mcp__panel__panel'
export const SCENE_TOOL = 'mcp__panel__scene'
export const CWD = '/work/proj'
export const HOME = '/Users/a'
export const PORT = 4717
export const STATE_FILE = '/tmp/t/claude-panel/panel-sess-1.json'
export const RUN = { origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } } as const

/** One path of the pretend disk. `real` is where it really lands (a link). */
export type Entry = { kind: 'file' | 'dir'; size?: number; real?: string; base64?: string }
export const dir = (real?: string): Entry => ({ kind: 'dir', ...(real === undefined ? {} : { real }) })
export const file = (size = 10, base64?: string): Entry => ({ kind: 'file', size, ...(base64 === undefined ? {} : { base64 }) })

// The roots a scene may live in exist on every pretend disk.
const ROOTS: Record<string, Entry> = {
  [CWD]: dir(),
  '/tmp': dir('/private/tmp'),
  '/private/tmp': dir(),
  [`${HOME}/.claude`]: dir(),
}

export const pane = (bodyRows = 30, bodyColumns = 60, offset = 0, requestId = 'panel') =>
  ({
    plugin: 'panel',
    component: 'Pane',
    requestId,
    props: {
      title: 'Panel',
      isFocused: false,
      bodyColumns,
      placement: 'dock',
      scroll: { offset, bodyRows },
      view: {},
    },
  }) as const

type Node = string | { type?: string; props?: Record<string, unknown>; children?: unknown[] }

/** What a drawn node shows as one line: its text, a Button as `[ label ]`. */
const shown = (n: unknown): string => {
  if (typeof n === 'string') return n
  const node = (n ?? {}) as Exclude<Node, string>
  if (node.type === 'Button') return `[ ${String(node.props?.label ?? '')} ]`
  return (node.children ?? []).map(shown).join('')
}

// The mounted tree is the whole tree the hook drew (the engine does the
// windowing on screen): the outer Box holds one row per child, a Text (the runs
// nested inside it) or a Box (an answer button after its side). A picture is no text row.
export async function paneRows(ui: Pick<Mounted, 'findAll'>): Promise<string[]> {
  const root = (await ui.findAll({ type: 'Box' }))[0]
  return (root?.children ?? [])
    .filter(c => typeof c === 'object' && c !== null && (c as { type?: string }).type !== 'Image')
    .map(shown)
}

/** The Buttons of the pane, by key. */
export async function buttons(ui: Pick<Mounted, 'findAll'>): Promise<{ key: string | undefined; label: string }[]> {
  return (await ui.findAll({ type: 'Button' })).map(b => ({ key: b.key, label: String(b.props.label ?? '') }))
}

// Finds a Text by its words; the failure lists what the pane did show.
export async function seen(ui: Pick<Mounted, 'find' | 'findAll'>, text: RegExp): Promise<void> {
  if ((await ui.find({ type: 'Text', text })) !== undefined) return
  const shown = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  throw new Error(`no Text matches ${text}; the pane shows ${JSON.stringify(shown)}`)
}

/** A stand-in for web/live.mjs: a test says what it prints (`say`) and when it ends; `isClosed` once the mod let go of it. */
export type FakeChild = {
  argv: string[]
  isClosed: boolean
  say: (line: object | string) => void
  end: () => void
}
const LIVE_SCRIPT_SUFFIX = '/web/live.mjs'

function fakeChild(argv: string[], signal: AbortSignal): { child: FakeChild; output: () => AsyncGenerator<{ stream: 'stdout'; text: string }, void> } {
  const pending: string[] = []
  const box: { wake: () => void; isEnded: boolean } = { wake: () => {}, isEnded: false }
  const child: FakeChild = {
    argv,
    isClosed: false,
    say: line => {
      pending.push(typeof line === 'string' ? line : `${JSON.stringify(line)}\n`)
      box.wake()
    },
    end: () => {
      box.isEnded = true
      box.wake()
    },
  }
  signal.addEventListener('abort', () => box.wake())
  async function* output() {
    try {
      for (;;) {
        const text = pending.shift()
        if (text !== undefined) yield { stream: 'stdout' as const, text }
        else if (box.isEnded || signal.aborted) return
        else await new Promise<void>(resolve => (box.wake = resolve))
      }
    } finally {
      child.isClosed = true
    }
  }
  return { child, output }
}

export type BootOptions = {
  portPieces?: string[]
  isServerDown?: boolean
  setup?: (on: On) => void
  /** Paths of the pretend disk, on top of the roots. */
  files?: Record<string, Entry>
  /** What `process.run` answers: stdout by the program's name (default: nothing, exit 0). */
  run?: Record<string, string>
  /** web/shot.mjs exists in the plugin (default: it does not, so a publish answers `shot: unavailable`). */
  hasShot?: boolean
  /** Text of files for `fs.read` (the default read of a file in `files` is its PNG bytes). */
  texts?: Record<string, string>
  /**
   * A finer `process.run`: returns the answer, or undefined to fall back to `run`; throws to make the
   * call reject (a timeout). `init` is what the mod passed (stdin, timeoutMs).
   */
  onRun?: (argv: readonly string[], init?: ProcessRunInit) => Partial<RunAnswer> | undefined
  /** The ambient pulse is on (default: off, see `PANEL_PULSE`). */
  pulse?: boolean
  /** What `ui.blit` answers for a frame (default: taken, `{}`). */
  blit?: (args: UiBlitArgs) => UiBlitResult
}
export type RunAnswer = { exitCode: number; stdout: string; stderr: string }
/** A `process.run` call with the options the mod gave it. */
export type RanCall = { argv: string[]; init?: ProcessRunInit }

export async function boot($: Engine, on: On, opts: BootOptions = {}) {
  const registered: string[] = []
  const spawned: string[][] = []
  const children: FakeChild[] = []
  const blits: UiBlitArgs[] = []
  const ran: string[][] = []
  const calls: RanCall[] = []
  const writes: { path: string; text: string }[] = []
  const opened: string[] = []
  const disk = { ...ROOTS, ...opts.files }
  opts.setup?.(on)
  const clock = mock.clock(on)
  // The ambient pulse is off unless a test asks for it: it adds a built-in scene and its own file writes to every run.
  mock.env(on, { TMPDIR: '/tmp/t/', HOME, PANEL_PULSE: opts.pulse === true ? 'on' : 'off' })
  // `$.store` (kept between sessions): a plain map, returned so a test can read what the mod kept.
  const stored = new Map<string, unknown>()
  on('store.get', (_, e) => ({ value: stored.get(e.key) }))
  on('store.set', (_, e) => {
    stored.set(e.key, e.value)
    return { value: undefined }
  })
  on('store.delete', (_, e) => {
    stored.delete(e.key)
    return { value: undefined }
  })
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.cwd', () => ({ value: CWD }))
  on('tool.register', (_, e) => {
    registered.push(`mcp__panel__${e.name}`)
    return { value: { tool: `mcp__panel__${e.name}` } }
  })
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('fs.write', (_, e) => {
    writes.push(e)
    return { value: undefined }
  })
  on('fs.stat', (_, e) => {
    const hit = disk[e.path]
    if (hit === undefined) throw Object.assign(new Error(`ENOENT: ${e.path}`), { code: 'ENOENT' })
    const real = hit.real ?? e.path
    return {
      value: { kind: hit.kind, size: hit.size ?? 0, mtimeMs: 1, isLink: hit.real !== undefined, ...(e.resolve ? { realPath: real } : {}) },
    }
  })
  on('fs.read', (_, e) => {
    const text = opts.texts?.[e.path]
    if (text !== undefined) return { value: e.as === 'bytes' ? { base64: btoa(text) } : text }
    const hit = disk[e.path]
    if (hit?.base64 === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: { base64: hit.base64 } }
  })
  on('fs.exists', (_, e) => ({ value: disk[e.path] !== undefined || (opts.hasShot === true && e.path.endsWith('/web/shot.mjs')) }))
  on('process.run', (_, e) => {
    ran.push([...e.argv])
    calls.push({ argv: [...e.argv], ...(e.init === undefined ? {} : { init: e.init }) })
    const done = { exitCode: 0, stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
    const custom = opts.onRun?.(e.argv, e.init)
    return { value: { ...done, stdout: opts.run?.[e.argv[0] ?? ''] ?? '', ...custom } }
  })
  on('ui.open', (_, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  // The web server: prints its port, then runs until the test stops it. (Not
  // held on the mock clock: a wait held there slows every later call.)
  let stopServer = (): void => {}
  const isStopped = new Promise<void>(resolve => (stopServer = resolve))
  on('ui.blit', (_, e) => {
    blits.push(e)
    return { value: opts.blit?.(e) ?? {} }
  })
  on('process.spawn', async function* (_, e, next) {
    if (e.argv[1]?.endsWith(LIVE_SCRIPT_SUFFIX) === true) {
      // The live preview's child: a fake the test drives; it ends when the mod lets go of it (or the test ends it).
      const { child, output } = fakeChild([...e.argv], next.signal)
      children.push(child)
      yield* output()
      return { value: { code: 0, signal: null } }
    }
    spawned.push([...e.argv])
    if (opts.isServerDown !== true) {
      for (const text of opts.portPieces ?? [`PORT ${PORT}\n`]) yield { stream: 'stdout' as const, text }
      await isStopped
    }
    return { value: { code: 0, signal: null } }
  })
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  await clock.settle()
  const last = () => JSON.parse(writes.at(-1)?.text ?? 'null')
  /** The `--token` the server was started with, and the url it serves at. */
  const token = (): string => spawned[0]?.[(spawned[0]?.indexOf('--token') ?? -2) + 1] ?? ''
  const url = (port = PORT): string => `http://127.0.0.1:${port}/${token()}/`
  return { writes, opened, registered, spawned, children, blits, ran, calls, clock, stopServer, last, token, url, stored }
}
