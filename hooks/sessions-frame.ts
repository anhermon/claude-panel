// The `sessions` frame the board draws by itself: every other live Claude Code session as a `statusboard` viz (columns busy /
// may be waiting / idle, one card per session). Draws nothing with no other session. Pure: no `$`, no I/O.
import type { BoardFrame, BoardTone } from '../types'
import { FRAME_CAPS } from './board-frames'
import type { SessionRow, SessionState } from './sessions-state'

export const SESSIONS_FRAME_ID = 'sessions'
const SESSIONS_TITLE = 'Other sessions'
const SESSIONS_SIZE = 'l'
const TAG_CHARS = 20

const COLUMNS: readonly { state: SessionState; title: string; tone?: BoardTone }[] = [
  { state: 'busy', title: 'Busy', tone: 'info' },
  { state: 'waiting', title: 'May be waiting', tone: 'warn' },
  { state: 'idle', title: 'Idle' }, // no tone: the board's untoned (neutral) column
]

const cardOf = (r: SessionRow): Record<string, unknown> => ({
  title: r.title,
  ...(r.task === undefined ? {} : { sub: r.task }),
  tags: [r.project, r.branch, r.age].filter((t): t is string => t !== undefined && t !== '').map(t => t.slice(0, TAG_CHARS)),
})

/** The frame for these rows (already ordered and capped), or undefined when there are none. Empty columns are left out. */
export function sessionsFrame(rows: readonly SessionRow[] | undefined): BoardFrame | undefined {
  if (rows === undefined || rows.length === 0) return undefined
  const columns = COLUMNS.map(c => ({ id: c.state, title: c.title, ...(c.tone === undefined ? {} : { tone: c.tone }), items: rows.filter(r => r.state === c.state).map(cardOf) })).filter(c => c.items.length > 0)
  return { id: SESSIONS_FRAME_ID, type: 'viz', title: SESSIONS_TITLE.slice(0, FRAME_CAPS.TITLE_CHARS), size: SESSIONS_SIZE, kind: 'statusboard', data: { columns } }
}
