// Pretend sessions for the sessions-frame tests: registry files, `ps` output and transcripts, all plain text (nothing touches the real ~/.claude).
export const NOW = 1_800_000_000_000
export const MIN = 60_000
export const SELF = '11111111-1111-4111-8111-111111111111'
export const ID_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
export const ID_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
export const ID_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
export const ID_DEAD = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
export const LSTART = 'Thu Nov  5 07:34:30 2026'
export const PROC_START = 'Thu Nov 05 07:34:30 2026'

export const registryFile = (pid: number, sessionId: string, over: Record<string, unknown> = {}): string =>
  JSON.stringify({ pid, sessionId, cwd: '/work/alpha', name: 'alpha', status: 'idle', startedAt: NOW - 60 * MIN, procStart: PROC_START, ...over })

/** `ps -axo pid=,ppid=,lstart=,command=` with these pids alive (all started at LSTART). */
export const psText = (pids: number[]): string => [...pids.map(p => `${String(p).padStart(5)}     1 ${LSTART} /usr/local/bin/claude --dangerously-skip-permissions`), '  999     1 Thu Nov  5 07:00:00 2026 /usr/sbin/cron'].join('\n') + '\n'

export const user = (text: string, over: Record<string, unknown> = {}): string => JSON.stringify({ type: 'user', cwd: '/work/alpha', gitBranch: 'feature/x', message: { role: 'user', content: text }, ...over })
export const toolUse = (id: string): string => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Bash', input: {} }] } })
export const toolResult = (id: string): string => JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } })
export const transcript = (...lines: string[]): string => `${lines.join('\n')}\n`
