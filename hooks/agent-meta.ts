// What a subagent was started as: its model and effort, read once from the `agent-<id>.meta.json` the engine writes next to the agent's
// transcript (`agentType`, `model` as the alias it was given, `effort`). The spawn event carries no effort, so this is the one source.
// A pure parser plus one bounded, once-per-agent lookup (same shape as agent-proof.ts); never throws; absent fields stay absent (never guessed).
import type { EngineInterface } from 'claude-code'

import { findTranscript, run } from './agent-names'

export const META_CAPS = { TRIES: 3, RETRY_MS: 4000, VALUE_CHARS: 28 } as const
const MAIN_ID = 'main'
const TRANSCRIPT_SUFFIX = /\.jsonl$/
const META_SUFFIX = '.meta.json'

export type AgentMeta = { model?: string; effort?: string }

const wordOf = (v: unknown): string | undefined => {
  const s = typeof v === 'number' ? String(v) : typeof v === 'string' ? v.replace(/[^\w.:*/-]/g, '').slice(0, META_CAPS.VALUE_CHARS) : ''
  return s === '' ? undefined : s
}

/** The model and effort of a meta file's text; {} when it is not JSON or holds neither. */
export function parseMeta(raw: string): AgentMeta {
  try {
    const j: unknown = JSON.parse(raw)
    if (typeof j !== 'object' || j === null) return {}
    const o = j as Record<string, unknown>
    const model = wordOf(o.model)
    const effort = wordOf(o.effort)
    return { ...(model === undefined ? {} : { model }), ...(effort === undefined ? {} : { effort }) }
  } catch {
    return {}
  }
}

type Attempt = { tries: number; at: number; isDone: boolean }
const attempts = new Map<string, Attempt>()
export const resetMeta = (): void => attempts.clear()

/** The model and effort of an agent from its meta file, or undefined (not found yet, nothing usable, tried enough times). */
export async function resolveMeta($: EngineInterface, agentId: string, now: number): Promise<AgentMeta | undefined> {
  const held = attempts.get(agentId) ?? { tries: 0, at: 0, isDone: false }
  if (held.isDone || held.tries >= META_CAPS.TRIES || (held.tries > 0 && now - held.at < META_CAPS.RETRY_MS) || agentId === MAIN_ID) return undefined
  attempts.set(agentId, { ...held, tries: held.tries + 1, at: now })
  try {
    const path = await findTranscript($, agentId)
    if (path === undefined) return undefined
    const meta = parseMeta((await run($, ['cat', path.replace(TRANSCRIPT_SUFFIX, META_SUFFIX)])) ?? '')
    if (meta.model === undefined && meta.effort === undefined) return undefined
    attempts.set(agentId, { tries: held.tries + 1, at: now, isDone: true })
    return meta
  } catch {
    return undefined
  }
}
