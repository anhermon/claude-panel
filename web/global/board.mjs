// What a session's own panel board says, read from the panel's state folder (`$TMPDIR/claude-panel/`, which is the folder of the
// server's state file): `panel-<sessionId>.json` (task, ask, choices) and `board/<sessionId>/live/board-model.json` (the frames
// the curating model wrote: a "needs you" html frame, steps). It is the richest needs-you signal. The files outlive their
// session until the OS cleans the temp folder, so a file older than the window is ignored. Text from the files is untrusted:
// html goes through the board's own sanitiser first, links through the same safe-link rule, and every text is masked and cut.
// Read-only, never throws; a file is re-read only when its mtime or size moved.
import fs from 'node:fs/promises';
import path from 'node:path';
import { sanitizeHtml } from '../builtin/board/sanitize.mjs';
import { oneLine } from './redact.mjs';
import { isPlaceholder, safeLink } from './links.mjs';

const TITLE_CHARS = 100;
const WHY_CHARS = 220;
const ITEMS_MAX = 12;
const STEPS_MAX = 30;
const NEEDS_FRAME = /need|decision|approv|ask|question|block|waiting|attention/i; // which html frames are needs-you / decision lists
const LI_RE = /<li\b[^>]*>([\s\S]*?)<\/li>/gi;
const BOLD_RE = /<(b|strong)\b[^>]*>([\s\S]*?)<\/\1>/i;
const HREF_RE = /<a\b[^>]*\shref="([^"]*)"/i;
const TAG_RE = /<[^>]*>/g;
const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"' };

const decode = (s) => s.replace(/&(?:amp|lt|gt|quot);/g, (e) => ENTITIES[e]);
const plain = (html) => decode(html.replace(/<br\s*\/?>/gi, ' · ').replace(TAG_RE, ' ')).replace(/\s+/g, ' ').replace(/^[\s·]+|[\s·]+$/g, '');

/** One html frame -> needs-you items: one per <li>, else one for the frame (a bold lead is the title, the rest the why; no bold: the text is the title). `{ title, why, link }` (link: '' when none). */
export function itemsFromHtml(html) {
  const clean = sanitizeHtml(html);
  const lis = [...clean.matchAll(LI_RE)].map((m) => m[1]);
  const chunks = lis.length > 0 ? lis : [clean];
  const out = [];
  for (const chunk of chunks.slice(0, ITEMS_MAX)) {
    const bold = BOLD_RE.exec(chunk);
    const text = plain(bold === null ? chunk : chunk.replace(bold[0], ' '));
    const title = oneLine(bold === null ? text : plain(bold[2]), TITLE_CHARS);
    const href = HREF_RE.exec(chunk)?.[1];
    const link = href === undefined ? '' : safeLink(decode(href));
    if (title === '' || (link !== '' && isPlaceholder(link))) continue; // an item whose only source is a placeholder url (example.com, localhost) is a test fixture
    out.push({ title, why: bold === null ? '' : oneLine(text, WHY_CHARS), link });
  }
  return out;
}

async function readJson(cache, file, maxAgeMs, now) {
  let st;
  try { st = await fs.stat(file); } catch { cache.delete(file); return null; }
  if (now - st.mtimeMs > maxAgeMs) return null;
  const sig = `${st.mtimeMs}:${st.size}`;
  const hit = cache.get(file);
  if (hit !== undefined && hit.sig === sig) return hit.value;
  let value = null;
  try {
    const obj = JSON.parse(await fs.readFile(file, 'utf8'));
    value = obj !== null && typeof obj === 'object' && !Array.isArray(obj) ? obj : null;
  } catch { /* partial write or not JSON: no board */ }
  cache.set(file, { sig, value });
  return value;
}

/**
 * The board of one session, or null: { task: {title, why}|null, steps: [{t, state}]|null, needs: [{ kind, title, why, link, may:false }] }.
 * `stateDir` is the panel's state folder; `maxAgeMs` the window.
 */
export async function readBoard(cache, stateDir, sessionId, now, maxAgeMs) {
  const panel = await readJson(cache, path.join(stateDir, `panel-${sessionId}.json`), maxAgeMs, now);
  const model = await readJson(cache, path.join(stateDir, 'board', sessionId, 'live', 'board-model.json'), maxAgeMs, now);
  if (panel === null && model === null) return null;
  const needs = [];
  let steps = null;
  for (const f of Array.isArray(model?.frames) ? model.frames : []) {
    if (f === null || typeof f !== 'object') continue;
    if (f.type === 'html' && typeof f.html === 'string' && NEEDS_FRAME.test(`${f.id ?? ''} ${f.title ?? ''}`)) {
      for (const i of itemsFromHtml(f.html)) needs.push({ kind: 'board', may: false, ...i });
    } else if (f.type === 'ask' && typeof f.q === 'string') {
      const options = Array.isArray(f.options) ? f.options.filter((o) => typeof o === 'string').slice(0, 4).join(' / ') : '';
      needs.push({ kind: 'board-ask', may: false, title: oneLine(f.q, TITLE_CHARS), why: oneLine(options === '' ? 'Question on the session board' : `Options: ${options}`, WHY_CHARS), link: '' });
    } else if (f.type === 'steps' && Array.isArray(f.items) && steps === null) {
      steps = f.items.filter((i) => i !== null && typeof i === 'object' && typeof i.t === 'string').slice(0, STEPS_MAX)
        .map((i) => ({ t: oneLine(i.t, 140), state: ['todo', 'doing', 'done', 'failed'].includes(i.state) ? i.state : 'todo' }));
    }
  }
  if (typeof panel?.ask === 'string' && panel.ask.trim() !== '') {
    const choices = Array.isArray(panel.choices) ? panel.choices.map((c) => c?.label).filter((l) => typeof l === 'string').slice(0, 4).join(' / ') : '';
    needs.push({ kind: 'board-ask', may: false, title: oneLine(panel.ask, TITLE_CHARS), why: oneLine(choices === '' ? 'Question on the session board' : `Options: ${choices}`, WHY_CHARS), link: '' });
  }
  const t = panel?.task;
  const task = t !== null && typeof t === 'object' && typeof t.title === 'string' && t.title.trim() !== '' ? { title: oneLine(t.title, 140), why: oneLine(String(t.why ?? ''), 200) } : null;
  return { task, steps, needs };
}
