// Best-effort local quota reads. The board's timer calls this; the first draw never waits for a subprocess.
import type { EngineInterface } from 'claude-code'
import { parseQuota } from './limits-quota'
import type { ProviderQuota } from './limits-quota'

export const QUOTA_IO = { EVERY_S: 120, TIMEOUT_MS: 15_000, MS_PER_SECOND: 1000, OFF: 0 } as const
const CACHE_DIR = '.claude/plugins/cache/delegation-kit/delegation-kit'
const SCRIPT_PATH = 'bin/delegate.py'
const PROGRAM = 'python3'
const QUOTA_ARGS = ['quota', '--json'] as const
const SUCCESS_EXIT = 0
const VERSION_LOCALE = 'en'
const DIRECTORY_KIND = 'dir'
const FILE_KIND = 'file'
const VERSION_NAME = /^\d+(?:\.\d+)*(?:[-+][A-Za-z0-9.-]+)?$/
type Cache = { quota: ProviderQuota[]; attemptedAt?: number }
let cache: Cache = { quota: [] }
let reading: Promise<void> | undefined

/** Session start and tests forget cached data; an older in-flight read cannot update the new cache. */
export function resetQuota(): void { cache = { quota: [] } }

async function scriptOf($: EngineInterface): Promise<string | undefined> {
  const home = await $.env.get('HOME')
  if (!home) return undefined
  const root = `${home.replace(/\/+$/, '')}/${CACHE_DIR}`
  const entries = await $.fs.list(root)
  const versions = entries.filter(e => e.kind === DIRECTORY_KIND && VERSION_NAME.test(e.name))
    .map(e => e.name).sort((a, b) => b.localeCompare(a, VERSION_LOCALE, { numeric: true }))
  for (const version of versions) {
    const path = `${root}/${version}/${SCRIPT_PATH}`
    if ((await $.fs.stat(path).catch(() => undefined))?.kind === FILE_KIND) return path
  }
  return undefined
}

/** Return cached data immediately and refresh at most once per interval, with only one run in flight. */
export function quotaRead($: EngineInterface, now: number, everyS: number = QUOTA_IO.EVERY_S, refresh: () => void = () => {}): readonly ProviderQuota[] {
  if (everyS <= QUOTA_IO.OFF) return []
  const current = cache
  if (reading === undefined && (current.attemptedAt === undefined || now - current.attemptedAt >= everyS * QUOTA_IO.MS_PER_SECOND)) {
    current.attemptedAt = now
    reading = (async () => {
      try {
        const script = await scriptOf($)
        if (script === undefined) return
        const out = await $.process.run([PROGRAM, script, ...QUOTA_ARGS], { timeoutMs: QUOTA_IO.TIMEOUT_MS })
        if (out.exitCode !== SUCCESS_EXIT) return
        const quota = parseQuota(out.stdout)
        if (quota.length === QUOTA_IO.OFF || cache !== current) return
        current.quota = quota
        refresh()
      } catch {
        // Missing script, timeout, failed process or junk output leaves the last good snapshot intact.
      } finally {
        reading = undefined
      }
    })()
  }
  return current.quota
}

/** Wait for an already-running read (useful for deterministic host tests); never starts a read. */
export async function quotaIdle(): Promise<void> { await reading }
