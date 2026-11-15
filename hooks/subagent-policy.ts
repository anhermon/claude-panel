// Who may touch the board: the main session owns it, a subagent's lanes are drawn automatically. Pure; the tool.call hooks in
// register.tsx apply the verdict to calls that carry an `agentId`.
import type { SubagentMode } from './panel-config'

export const SUBAGENT_DENY = 'panel: main session owns the board; lanes are drawn automatically'
/** The only fields a subagent's panel call may carry in "lane-only" mode: its own lane or a frame of its own. */
export const SUBAGENT_FIELDS: ReadonlySet<string> = new Set(['lane', 'lane_remove', 'frame'])

/** The deny reason for a call by a subagent, or undefined when it may go on. `isScene` is a call of the scene tool. */
export function subagentDeny(mode: SubagentMode, isScene: boolean, input: Record<string, unknown>): string | undefined {
  if (mode === 'allow') return undefined
  if (mode === 'deny' || isScene) return SUBAGENT_DENY
  const keys = Object.keys(input)
  return keys.length > 0 && keys.every(k => SUBAGENT_FIELDS.has(k)) ? undefined : SUBAGENT_DENY
}
