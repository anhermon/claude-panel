// Pure view model of the fleet page: filter, sort, group. No DOM. Tested in Node.
export const GROUP_ORDER = ['running', 'idle', 'earlier'];
export const GROUP_TITLES = { running: 'Running now', idle: 'Idle', earlier: 'Earlier' };
export const GROUP_CAPTIONS = {
  running: 'Written to in the last seconds, or marked busy by the session registry',
  idle: 'Process alive, nothing being written',
  earlier: 'No process found; transcript written inside the window',
};
export const SORTS = {
  activity: { label: 'Recent activity', by: (s) => s.lastWriteAt ?? 0 },
  tokens: { label: 'Output tokens', by: (s) => s.tokens.out },
  tools: { label: 'Tool calls', by: (s) => s.tools.total },
  errors: { label: 'Errors', by: (s) => s.errors },
};
export const DEFAULT_SORT = 'activity';

const haystack = (s) => [s.title, s.name, s.project, s.cwd, s.model, s.lastPrompt, s.id, s.entrypoint, s.branch, s.currentTool?.name, s.currentTool?.label, s.pid]
  .filter((v) => v !== null && v !== undefined).join('\n').toLowerCase();

/** Every whitespace separated word of `query` must appear (case-insensitive) in some field of the session. */
export function filterSessions(sessions, query) {
  const words = String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  return words.length === 0 ? sessions : sessions.filter((s) => { const h = haystack(s); return words.every((w) => h.includes(w)); });
}

export function sortSessions(sessions, key) {
  const by = (SORTS[key] ?? SORTS[DEFAULT_SORT]).by;
  return [...sessions].sort((a, b) => by(b) - by(a) || (b.lastWriteAt ?? 0) - (a.lastWriteAt ?? 0));
}

/** [{ group, title, caption, sessions }] in display order; empty groups are left out. */
export function groupSessions(sessions) {
  return GROUP_ORDER.map((g) => ({ group: g, title: GROUP_TITLES[g], caption: GROUP_CAPTIONS[g], sessions: sessions.filter((s) => s.group === g) })).filter((g) => g.sessions.length > 0);
}

/** Top `n` entries of a {name: count} map as [{name, count}], the rest folded into one "other" row. */
export function topEntries(map, n) {
  const all = Object.entries(map ?? {}).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
  if (all.length <= n) return all;
  const rest = all.slice(n).reduce((sum, e) => sum + e.count, 0);
  return [...all.slice(0, n), { name: 'other', count: rest }];
}

/** A short title for a row: the AI title, else the registry name, else the project, else the id head. */
export const titleOf = (s) => s.title ?? s.name ?? s.project ?? s.id.slice(0, 8);
