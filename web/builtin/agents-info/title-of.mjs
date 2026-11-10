// Plain titles of tasks for the Agents scene: the person reads WHAT the work is, never a ticket id ("T63", "01-evaluator").
// Pure (no DOM); tested by title-of.test.mjs. Tooltips use the same plain titles.

export const TITLE_CHARS = 28;
export const ELLIPSIS = '…';
const MIN_WORD_CUT = 8;
/** Shown when nothing says what the work is: the role, else "Agent". */
export const ROLE_TITLE = Object.freeze({ router: 'Router', worker: 'Worker', verifier: 'Verifier', 'codex-worker': 'Codex worker', watchdog: 'Watchdog', qa: 'QA', merger: 'Merger' });
export const FALLBACK_TITLE = 'Agent';
import { plainTitle } from '../../kit/panel/plain-title.mjs';
export { plainTitle } from '../../kit/panel/plain-title.mjs';

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const oneLine = (s) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : '');
const cleanTitle = (s) => plainTitle(oneLine(s));

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
  if (agent.isMain) return cleanTitle(agent.title) || 'This session';
  const ids = agent.ticket ? [agent.ticket.id] : [];
  for (const c of [agent.ticket?.title, agent.name]) {
    const t = cleanTitle(ids.reduce((s, id) => s.replace(new RegExp(`(^|[^\\w-])${escapeRe(id)}(?![\\w-])`, 'gi'), '$1'), oneLine(c)));
    if (t !== '' && !GENERIC_NAME.test(t)) return t;
  }
  if (ROLE_TITLE[agent.role]) return ROLE_TITLE[agent.role];
  const kind = typeof agent.kindLabel === 'string' && agent.kind && !['working', 'thinking', 'waiting', 'done'].includes(agent.kind) ? agent.kindLabel : '';
  return kind ? `${kind} agent` : FALLBACK_TITLE;
}

/** Compatibility helper: tooltips now show the same human title as the visible name. */
export const idHint = (agent) => titleOf(agent);

/** Rewrites the ids inside a sentence ("Delegating: T43, T40", "T43 testing") into the plain titles of `agents`; an unknown bare id is dropped. */
export function retitle(text, agents) {
  let s = oneLine(text);
  for (const a of agents) {
    const lead = /^T\d+\b/i.exec(oneLine(a.name))?.[0];
    const tokens = [lead, a.ticket?.id, a.short].filter((t, i, all) => typeof t === 'string' && t.length > 1 && t !== 'Me' && all.indexOf(t) === i);
    for (const token of tokens) s = s.replace(new RegExp(`(^|[^\\w-])${escapeRe(token)}(?![\\w-])`, 'g'), `$1${clipTitle(titleOf(a))}`);
  }
  return plainTitle(s, false).replace(/\s+([,:])/g, '$1').replace(/\s+/g, ' ').replace(/[\s,;]+$/, '').trim();
}
