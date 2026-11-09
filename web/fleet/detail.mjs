// The drill-down of one session: the recent transcript as readable events (what the person said, what the assistant said,
// each tool call with its outcome, errors, turn ends), newest first and paginated. Read on demand from the last
// `detailBytes` of the file and cached by size+mtime; every text is masked (./redact.mjs) and cut. Thinking blocks and
// successful tool output are never kept. Pure except `readEvents` (one stat + one read).
import fs from 'node:fs';
import { block, oneLine } from './redact.mjs';
import { kindOfCall } from './kinds.mjs';
import { labelOf, promptText, textOf } from './transcript.mjs';

const NEWLINE = 0x0a;
const EVENTS_MAX = 600;
const COMMAND_CHARS = 400;
const cache = new Map(); // file -> { size, mtimeMs, events }
const CACHE_MAX = 16;

const tsOf = (row) => { const t = Date.parse(row?.timestamp); return Number.isFinite(t) ? t : null; };

/** Rows (parsed) -> display events, oldest first. */
export function eventsFromRows(rows, cfg) {
  const events = [];
  const calls = new Map();
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue;
    const ts = tsOf(row);
    if (row.type === 'user') {
      for (const b of Array.isArray(row.message?.content) ? row.message.content : []) {
        if (b?.type !== 'tool_result') continue;
        const call = calls.get(b.tool_use_id);
        if (call !== undefined) { call.done = true; call.ms = ts !== null && call.ts !== null ? ts - call.ts : null; }
        if (b.is_error === true) {
          const text = block(textOf(b.content), cfg.detailResultChars);
          if (call !== undefined) call.error = text; else events.push({ t: 'error', ts, text });
        }
      }
      const prompt = promptText(row);
      if (prompt !== null) events.push({ t: 'user', ts, text: block(prompt, cfg.detailTextChars) });
    } else if (row.type === 'assistant' && Array.isArray(row.message?.content)) {
      for (const b of row.message.content) {
        if (b?.type === 'text' && typeof b.text === 'string' && b.text.trim() !== '') events.push({ t: 'say', ts, text: block(b.text, cfg.detailTextChars) });
        else if (b?.type === 'tool_use' && typeof b.name === 'string') {
          const input = b.input ?? {};
          const ev = { t: 'tool', ts, name: b.name.slice(0, 80), kind: kindOfCall(b.name, input) ?? null, label: labelOf(b.name, input, cfg.toolLabelChars), done: false, error: null, ms: null };
          if (b.name === 'Bash' && typeof input.command === 'string') ev.command = block(input.command, COMMAND_CHARS);
          events.push(ev);
          if (typeof b.id === 'string') calls.set(b.id, ev);
        }
      }
    } else if (row.type === 'system' && row.subtype === 'turn_duration' && Number.isFinite(row.durationMs)) {
      events.push({ t: 'turn', ts, ms: row.durationMs });
    }
  }
  return events.slice(-EVENTS_MAX).map((e, i) => ({ i, ...e }));
}

/** Reads the tail of a transcript file into rows (a cut first/last line is dropped). */
export function readRows(file, cfg) {
  const st = fs.statSync(file);
  const start = Math.max(0, st.size - cfg.detailBytes);
  const buf = Buffer.alloc(st.size - start);
  const fd = fs.openSync(file, 'r');
  try { fs.readSync(fd, buf, 0, buf.length, start); } finally { fs.closeSync(fd); }
  let from = 0;
  if (start > 0) { const nl = buf.indexOf(NEWLINE); from = nl < 0 ? buf.length : nl + 1; }
  const rows = [];
  for (const line of buf.subarray(from).toString('utf8').split('\n')) {
    if (line === '' || line.startsWith('{"type":"api-request') || line.startsWith('{"type":"file-history-snapshot')) continue;
    try { rows.push(JSON.parse(line)); } catch { /* a cut or broken line */ }
  }
  return { rows, stat: st, isPartial: start > 0 };
}

/** Events of a transcript, cached by size and mtime. Throws when the file cannot be read (the caller answers 404/500). */
export function readEvents(file, cfg) {
  const st = fs.statSync(file);
  const hit = cache.get(file);
  if (hit !== undefined && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit;
  const { rows, isPartial } = readRows(file, cfg);
  const entry = { size: st.size, mtimeMs: st.mtimeMs, events: eventsFromRows(rows, cfg), isPartial };
  cache.delete(file);
  cache.set(file, entry);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  return entry;
}

/** One page, newest first: events with index < `before` (default: the end), at most `limit`. */
export function pageOf(events, before, limit) {
  const end = Number.isInteger(before) && before >= 0 ? Math.min(before, events.length) : events.length;
  const start = Math.max(0, end - limit);
  return { events: events.slice(start, end).reverse(), total: events.length, next: start > 0 ? start : null };
}

export { oneLine };
