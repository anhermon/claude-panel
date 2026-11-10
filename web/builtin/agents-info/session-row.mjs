// The row the Agents tile opens for a card of the board's "Other sessions" frame (the page's `open-session` message: id, title, state).
// The session is not one of the tile's agents, so the row is built here from what the card says; the mod builds the detail from the
// session's own transcript (hooks/agent-detail-host.ts) and only for a session it listed.
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const NAME_CHARS = 70;
const SHORT_ID_CHARS = 8;
/** A session's state as the words of the detail view: an idle session is not running. */
const STATE_WORD = Object.freeze({ busy: 'working', waiting: 'waiting', idle: 'done' });
const DEFAULT_STATE = 'busy';

/** The row for this message, or null when it names no safe id. */
export function sessionRowOf(d) {
  if (d === null || typeof d !== 'object' || typeof d.id !== 'string' || !ID_RE.test(d.id)) return null;
  const title = typeof d.title === 'string' ? d.title.trim().slice(0, NAME_CHARS) : '';
  const name = title === '' ? d.id.slice(0, SHORT_ID_CHARS) : title;
  return {
    id: d.id, loop: d.id, isMain: false, name, short: name, state: STATE_WORD[d.state] ?? STATE_WORD[DEFAULT_STATE], pct: null,
    startedAt: Date.now(), endedAt: null, tokens: null, kind: null, kindLabel: 'Other session', kindColor: '', kindGlyph: '', headline: '', files: [],
    role: null, ticket: null,
  };
}
