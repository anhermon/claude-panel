// Links and Jira keys found in other sessions' text. Everything here is untrusted: a link survives only as an absolute
// http(s) URL (the same rule as the board's html frame, builtin/board/sanitize.mjs `cleanHref`) that masking leaves untouched
// (a URL with a token in it is dropped, never shown); a Jira key is linked only for a project prefix that was seen in a real
// `atlassian.net/browse/` link, and the base URL below is the one those links use. No Jira API is ever called.
import { cleanHref } from '../builtin/board/sanitize.mjs';
import { maskSecrets } from './redact.mjs';

export const JIRA_BROWSE = 'https://dealhub.atlassian.net/browse/';
/** Prefixes seen in real transcripts' browse links (DEV, CHR over all time; RH, INC in the last days). More are learned at run time. */
export const SEED_PREFIXES = ['DEV', 'CHR', 'RH', 'INC'];
export const INTERNAL_PREFIX = 'INT';
const LINKS_MAX = 6;
const URL_RE = /https?:\/\/[^\s<>"'`\\)\]]+/g;
const TRAILING = /[.,;:!?)\]>*_]+$/;
const KEY_RE = /\b[A-Z][A-Z0-9]+-\d+\b/g;
const BROWSE_RE = /atlassian\.net\/browse\/([A-Z][A-Z0-9]+)-\d+/g;
// An internal ticket is the branch remainder in full (`INT-20261111-panel-global-view`): two of one day must not merge.
const INTERNAL_RE = /\bINT-\d{8}(?:-[a-z0-9]+)*/g;
const BRANCH_NOISE = 'HEAD';
const PLACEHOLDER_HOSTS = /^(?:(?:[a-z0-9-]+\.)*example\.(?:com|org|net)|localhost|127\.0\.0\.1)$/i;

/** The same page written two ways (trailing slash, fragment) is one link. */
export const linkKey = (url) => String(url).replace(/#.*$/, '').replace(/\/+$/, '');

/** A url on example.com/.org/.net or localhost: a placeholder from a test or a sample, never a real source. */
export function isPlaceholder(url) {
  try { return PLACEHOLDER_HOSTS.test(new URL(url).hostname); } catch { return false; }
}

/** A url to show, or '' (not absolute http(s), a token in it, or too long). */
export function safeLink(raw) {
  const url = cleanHref(String(raw ?? '').replace(TRAILING, ''));
  return url !== '' && maskSecrets(url) === url ? url : '';
}

/** What kind of link this is, with a short label, or null when it is not one the view cares about. */
export function classify(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  const host = u.hostname.toLowerCase();
  const parts = u.pathname.split('/').filter(Boolean);
  if (host === 'bitbucket.org') {
    const at = parts.indexOf('pull-requests');
    return at >= 0 && /^\d+$/.test(parts[at + 1] ?? '') ? { kind: 'pr', label: `PR #${parts[at + 1]} ${parts.slice(0, at).slice(-1)[0] ?? ''}`.trim() } : null;
  }
  if (host === 'github.com') {
    const at = parts.indexOf('pull');
    return at === 2 && /^\d+$/.test(parts[3] ?? '') ? { kind: 'pr', label: `PR #${parts[3]} ${parts[1]}` } : null;
  }
  if (host.endsWith('.atlassian.net')) {
    const m = /^\/browse\/([A-Z][A-Z0-9]+-\d+)/.exec(u.pathname);
    if (m !== null) return { kind: 'jira', label: m[1] };
    return /^\/browse(?:\/|$)/.test(u.pathname) ? null : { kind: 'atlassian', label: 'Atlassian page' }; // a browse link with no key points nowhere
  }
  if (host === 'claude.ai' && parts[0] === 'artifact' && parts[1] !== undefined) return { kind: 'artifact', label: 'Artifact' };
  return null;
}

/** The urls of one text that are worth a link: [{ url, kind, label }], in order, no repeats. */
export function linksIn(text) {
  const out = [];
  for (const raw of String(text ?? '').match(URL_RE) ?? []) {
    const url = safeLink(raw);
    const c = url === '' ? null : classify(url);
    if (c !== null && !out.some((l) => linkKey(l.url) === linkKey(url))) out.push({ url, ...c });
  }
  return out;
}

/** Newest-last list + new links -> the latest few, newest first, no repeats. */
export function keepLatest(list, fresh, max = LINKS_MAX) {
  const merged = [...fresh.slice().reverse(), ...list.filter((l) => !fresh.some((f) => linkKey(f.url) === linkKey(l.url)))];
  return merged.slice(0, max);
}

/** Project prefixes named by browse links in a text. */
export function browsePrefixes(text) {
  return [...String(text ?? '').matchAll(BROWSE_RE)].map((m) => m[1]);
}

/**
 * Ticket keys in a text for the known prefixes (and internal `INT-...` ones): [{ key, internal }], no repeats.
 * `prefixes` is a Set of project prefixes seen in real links.
 */
export function ticketKeys(text, prefixes) {
  const t = String(text ?? '');
  const out = [];
  const add = (key, internal) => { if (!out.some((k) => k.key === key)) out.push({ key, internal }); };
  for (const k of t.match(INTERNAL_RE) ?? []) add(k, true);
  for (const k of t.match(KEY_RE) ?? []) {
    const prefix = k.slice(0, k.lastIndexOf('-'));
    if (prefix !== INTERNAL_PREFIX && prefixes.has(prefix)) add(k, false);
  }
  return out;
}

/** The keys a git branch names (`feature/DEV-123-x`, `feature/INT-20261111-x`); `HEAD` names none. */
export const branchKeys = (branch, prefixes) => (branch === null || branch === BRANCH_NOISE ? [] : ticketKeys(branch, prefixes));

/** A key's browse url; internal keys and keys of an unknown project have none. */
export const jiraUrl = (key, internal) => (internal ? null : `${JIRA_BROWSE}${key}`);
