// Plain titles of tasks for the Agents scene: the person reads WHAT the work is, never a ticket id ("T63", "01-evaluator").
// Pure (no DOM); tested by title-of.test.mjs. The id may live in a tooltip, never in visible text.

export const TITLE_CHARS = 28;
export const ELLIPSIS = '…';
const MIN_WORD_CUT = 8;
/** Shown when nothing says what the work is: the role, else "Agent". */
export const ROLE_TITLE = Object.freeze({ router: 'Router', worker: 'Worker', verifier: 'Verifier', 'codex-worker': 'Codex worker', watchdog: 'Watchdog', qa: 'QA', merger: 'Merger' });
export const FALLBACK_TITLE = 'Agent';
const LEAD_ID = /^T\d+\b[\s·:.\-–—]*/i;
const TRAIL_PARENS = /(\s*\([^()]*\))+\s*$/;
const SLUG_ID = /(^|\s)\d{1,3}-[A-Za-z0-9][\w-]*(?=$|[\s·:,;.)])/g;
const LOOSE_ID = /(^|[\s(])T\d+\b/gi;
const SEPARATORS = /^[\s·:,;.\-–—]+|[\s·:,;\-–—]+$/g;

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const oneLine = (s) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : '');

/** "T63 · Redesign agent avatars (sonnet/high)" -> "Redesign agent avatars"; `ids`: extra ids to drop (a ticket's own id). May return ''. */
export function plainTitle(text, ids = []) {
  let s = oneLine(text).replace(TRAIL_PARENS, '').replace(LEAD_ID, '');
  for (const id of ids) if (typeof id === 'string' && id !== '') s = s.replace(new RegExp(`(^|[\\s(])${escapeRe(id)}(?![\\w-])`, 'gi'), '$1');
  s = s.replace(SLUG_ID, '$1').replace(SEPARATORS, '').replace(/\s+/g, ' ');
  return /^\p{L}/u.test(s) ? s[0].toUpperCase() + s.slice(1) : s;
}

/** At most `max` characters, cut at a word boundary with an ellipsis (a hard cut when the first word alone is longer). */
export function clipTitle(title, max = TITLE_CHARS) {
  if (title.length <= max) return title;
  const head = title.slice(0, max - 1);
  const at = head.lastIndexOf(' ');
  return `${(at >= MIN_WORD_CUT ? head.slice(0, at) : head).trimEnd().replace(/[,;:·\-–—]+$/, '')}${ELLIPSIS}`;
}

/** Names that say nothing about the job: "Agent 1348", "Worker", "Verifier 02". */
const GENERIC_NAME = /^(?:sub-?agent|agent|task|worker|verifier|codex[- ]worker)(?:\s+[0-9a-f]{2,})?$/i;

/** The full title of an agent: the ticket's title, else its label stripped of ids; else the role name; else "<Kind> agent" from its kind of work. Never an id. */
export function titleOf(agent) {
  if (agent.isMain) return 'This session';
  const ids = agent.ticket ? [agent.ticket.id] : [];
  for (const c of [agent.ticket?.title, agent.name]) {
    const t = plainTitle(c, ids);
    if (t !== '' && !GENERIC_NAME.test(t)) return t;
  }
  if (ROLE_TITLE[agent.role]) return ROLE_TITLE[agent.role];
  const kind = typeof agent.kindLabel === 'string' && agent.kind && !['working', 'thinking', 'waiting', 'done'].includes(agent.kind) ? agent.kindLabel : '';
  return kind ? `${kind} agent` : FALLBACK_TITLE;
}

/** The id as a tooltip: "01-slugify" / "T63" when the agent has one, else ''. */
export function idHint(agent) {
  const lead = /^T\d+\b/i.exec(oneLine(agent.name))?.[0];
  return agent.ticket?.id ?? lead ?? '';
}

/** Rewrites the ids inside a sentence ("Delegating: T43, T40", "T43 testing") into the plain titles of `agents`; an unknown bare id is dropped. */
export function retitle(text, agents) {
  let s = oneLine(text);
  for (const a of agents) {
    const lead = /^T\d+\b/i.exec(oneLine(a.name))?.[0];
    const tokens = [lead, a.ticket?.id, a.short].filter((t, i, all) => typeof t === 'string' && t.length > 1 && t !== 'Me' && all.indexOf(t) === i);
    for (const token of tokens) s = s.replace(new RegExp(`(^|[^\\w-])${escapeRe(token)}(?![\\w-])`, 'g'), `$1${clipTitle(titleOf(a))}`);
  }
  return s.replace(LOOSE_ID, '$1').replace(/\s+([,:])/g, '$1').replace(/\s+/g, ' ').replace(/[\s,;]+$/, '').trim();
}
