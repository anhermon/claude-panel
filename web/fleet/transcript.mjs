// Reads a session transcript (~/.claude/projects/<slug>/<sessionId>.jsonl) INCREMENTALLY and folds its rows into a small
// accumulator: title, model, tokens, tool counts, errors, last prompt, the unanswered tool call, turn durations.
//   * transcripts reach gigabytes: only the last `tailBytes` are read on first sight, then only appended bytes, gated on size
//   * a last line that is cut off (the writer is mid-row) is carried to the next read, never counted as broken
//   * version drift: unknown row types are only counted, a missing field is null, a row that is not JSON is counted; nothing throws
//   * assistant rows are written once per content block with the same message id and usage: tokens are de-duplicated by id
// Every text passes ./redact.mjs before it enters the accumulator. Pure except `pollFile` (stat + read).
import fs from 'node:fs';
import { oneLine } from './redact.mjs';
import { kindOfCall } from './kinds.mjs';

const NEWLINE = 0x0a;
const SKIP_PREFIXES = ['{"type":"api-request', '{"type":"file-history-snapshot']; // huge rows the fleet never needs: not even parsed
const KNOWN_IGNORED = new Set(['mode', 'permission-mode', 'session-owner', 'dev-mods', 'atis-latch', 'queue-operation', 'attachment', 'progress', 'summary', 'custom-title', 'agent-name', 'worktree-state', 'pr-link', 'content-replacement', 'frame-link', 'artifact-autoreact-ledger', 'cost-state', 'artifact-comment-monitor', 'tools-used', 'relocated', 'file-history-delta']);
const UNKNOWN_TYPES_MAX = 30;
const TOOL_NAMES_MAX = 60;
const OTHER_NAME = '(other)';
const PENDING_MAX = 24;
const SYNTHETIC_MODEL = '<synthetic>';
const COMMAND_TAG = /<command-name>\s*([^<]*?)\s*<\/command-name>(?:[\s\S]*?<command-args>([\s\S]*?)<\/command-args>)?/;
const HOME_PATH = /^(?:\/Users|\/home)\/[^/]+/;
const USAGE_FIELDS = [['in', 'input_tokens'], ['out', 'output_tokens'], ['cacheRead', 'cache_read_input_tokens'], ['cacheWrite', 'cache_creation_input_tokens']];

const num = (v) => (Number.isFinite(v) && v > 0 ? v : 0);
const tsOf = (row) => { const t = Date.parse(row?.timestamp); return Number.isFinite(t) ? t : null; };
const zeroUsage = () => ({ in: 0, out: 0, cacheRead: 0, cacheWrite: 0 });
export const textOf = (content) => (typeof content === 'string' ? content : Array.isArray(content) ? content.map((b) => (b !== null && typeof b === 'object' && typeof b.text === 'string' ? b.text : '')).join('\n') : '');

export function newAcc() {
  return {
    title: null, model: null, cwd: null, version: null, slug: null, gitBranch: null, entrypoint: null,
    lastPrompt: null, lastPromptTs: null, lastSay: null, firstTs: null, lastTs: null,
    usage: zeroUsage(), usageSeen: new Map(), buckets: new Map(),
    toolsSeen: new Set(), tools: { total: 0, byName: {}, byKind: {} }, resultsSeen: new Set(),
    errors: 0, lastError: null, lastErrorTs: null, apiErrors: 0, pending: new Map(),
    turns: { count: 0, lastMs: null, totalMs: 0, maxMs: 0 }, rows: 0, unparsed: 0, unknownTypes: {},
  };
}

/** The first line of a command or the main argument of a tool call, masked and cut. */
export function labelOf(name, input, max) {
  const i = input !== null && typeof input === 'object' ? input : {};
  const home = (s) => s.replace(HOME_PATH, '~');
  const pick = (v) => (typeof v === 'string' ? v : '');
  let raw = '';
  if (name === 'Bash') raw = pick(i.command).split('\n').find((l) => l.trim() !== '') ?? '';
  else if (name === 'Agent' || name === 'Task') raw = pick(i.description);
  else if (name === 'Grep' || name === 'Glob') raw = pick(i.pattern);
  else if (name === 'Skill') raw = pick(i.skill);
  else if (name === 'WebFetch') raw = pick(i.url);
  else if (name === 'WebSearch') raw = pick(i.query);
  else raw = pick(i.file_path) || pick(i.path) || pick(i.notebook_path) || pick(i.description) || pick(i.command);
  return oneLine(home(raw), max);
}

function bump(map, key, by = 1, cap = TOOL_NAMES_MAX) {
  const k = Object.hasOwn(map, key) || Object.keys(map).length < cap ? key : OTHER_NAME;
  map[k] = (map[k] ?? 0) + by;
}

function remember(set, id, max) {
  if (set.has(id)) return false;
  set.add(id);
  if (set.size > max) set.delete(set.values().next().value);
  return true;
}

function addUsage(acc, usage, id, ts, cfg) {
  if (usage === null || typeof usage !== 'object') return;
  const prev = (id !== null && acc.usageSeen.get(id)) || zeroUsage();
  const next = { ...prev };
  const delta = zeroUsage();
  for (const [field, key] of USAGE_FIELDS) {
    const cur = num(usage[key]);
    if (cur > prev[field]) { delta[field] = cur - prev[field]; next[field] = cur; }
  }
  if (id !== null) {
    acc.usageSeen.delete(id);
    acc.usageSeen.set(id, next);
    if (acc.usageSeen.size > cfg.seenIdsMax) acc.usageSeen.delete(acc.usageSeen.keys().next().value);
  }
  for (const [field] of USAGE_FIELDS) acc.usage[field] += delta[field];
  if (ts === null) return;
  const key = Math.floor(ts / cfg.bucketMs) * cfg.bucketMs;
  const b = acc.buckets.get(key) ?? zeroUsage();
  for (const [field] of USAGE_FIELDS) b[field] += delta[field];
  acc.buckets.set(key, b);
  if (acc.buckets.size > cfg.bucketsMax) acc.buckets.delete(Math.min(...acc.buckets.keys()));
}

export function promptText(row) {
  if (row.isMeta === true || row.isSidechain === true) return null;
  const content = row.message?.content;
  if (Array.isArray(content) && content.some((b) => b?.type === 'tool_result')) return null;
  const text = textOf(content).trim();
  if (text === '') return null;
  const cmd = COMMAND_TAG.exec(text);
  if (cmd !== null) return `${cmd[1]}${cmd[2] ? ` ${cmd[2]}` : ''}`.trim();
  return text.startsWith('<') || text.startsWith('[Request interrupted') ? null : text;
}

function onAssistant(acc, row, ts, cfg) {
  const msg = row.message;
  if (msg === null || typeof msg !== 'object') return;
  if (typeof msg.model === 'string' && msg.model !== SYNTHETIC_MODEL && msg.model !== '') acc.model = msg.model.slice(0, 80);
  if (row.isApiErrorMessage === true) acc.apiErrors += 1;
  addUsage(acc, msg.usage, typeof msg.id === 'string' ? msg.id : null, ts, cfg);
  for (const b of Array.isArray(msg.content) ? msg.content : []) {
    if (b === null || typeof b !== 'object') continue;
    if (b.type === 'text' && typeof b.text === 'string' && b.text.trim() !== '') acc.lastSay = oneLine(b.text, cfg.promptChars);
    if (b.type !== 'tool_use' || typeof b.name !== 'string') continue;
    const id = typeof b.id === 'string' ? b.id : null;
    if (id !== null && !remember(acc.toolsSeen, id, cfg.seenIdsMax)) continue;
    acc.tools.total += 1;
    bump(acc.tools.byName, b.name);
    const kind = kindOfCall(b.name, b.input ?? {});
    if (kind !== undefined) bump(acc.tools.byKind, kind, 1, Number.POSITIVE_INFINITY);
    if (id !== null) {
      acc.pending.set(id, { name: b.name.slice(0, 80), label: labelOf(b.name, b.input, cfg.toolLabelChars), ts });
      if (acc.pending.size > PENDING_MAX) acc.pending.delete(acc.pending.keys().next().value);
    }
  }
}

function onUser(acc, row, ts, cfg) {
  const content = row.message?.content;
  for (const b of Array.isArray(content) ? content : []) {
    if (b === null || typeof b !== 'object' || b.type !== 'tool_result') continue;
    const id = typeof b.tool_use_id === 'string' ? b.tool_use_id : null;
    if (id !== null) acc.pending.delete(id);
    if (b.is_error === true && (id === null || remember(acc.resultsSeen, id, cfg.seenIdsMax))) {
      acc.errors += 1;
      acc.lastError = oneLine(textOf(b.content).split('\n').find((l) => l.trim() !== '') ?? '', cfg.errorChars);
      acc.lastErrorTs = ts;
    }
  }
  const prompt = promptText(row);
  if (prompt !== null) { acc.lastPrompt = oneLine(prompt, cfg.promptChars); acc.lastPromptTs = ts; }
}

/** Folds one parsed row into the accumulator. Never throws on odd shapes. */
export function applyRow(acc, row, cfg) {
  if (row === null || typeof row !== 'object' || Array.isArray(row)) { acc.unparsed += 1; return; }
  acc.rows += 1;
  const ts = tsOf(row);
  if (ts !== null) { acc.firstTs = acc.firstTs === null ? ts : Math.min(acc.firstTs, ts); acc.lastTs = acc.lastTs === null ? ts : Math.max(acc.lastTs, ts); }
  if (typeof row.cwd === 'string') acc.cwd = row.cwd.slice(0, 400);
  if (typeof row.version === 'string') acc.version = row.version.slice(0, 40);
  if (typeof row.entrypoint === 'string') acc.entrypoint = row.entrypoint.slice(0, 40);
  if (typeof row.gitBranch === 'string') acc.gitBranch = row.gitBranch.slice(0, 80);
  if (typeof row.slug === 'string') acc.slug = row.slug.slice(0, 80);
  switch (row.type) {
    case 'ai-title': if (typeof row.aiTitle === 'string') acc.title = oneLine(row.aiTitle, cfg.titleChars); break;
    case 'last-prompt': if (typeof row.lastPrompt === 'string') acc.lastPrompt = oneLine(row.lastPrompt, cfg.promptChars); break;
    case 'assistant': onAssistant(acc, row, ts, cfg); break;
    case 'user': onUser(acc, row, ts, cfg); break;
    case 'system':
      if (row.subtype === 'turn_duration' && Number.isFinite(row.durationMs)) {
        acc.turns.count += 1; acc.turns.lastMs = row.durationMs; acc.turns.totalMs += row.durationMs; acc.turns.maxMs = Math.max(acc.turns.maxMs, row.durationMs);
      }
      break;
    default:
      if (!KNOWN_IGNORED.has(row.type)) {
        const key = typeof row.type === 'string' ? row.type.slice(0, 40) : '(none)';
        bump(acc.unknownTypes, key, 1, UNKNOWN_TYPES_MAX);
      }
  }
}

/** The most recent unanswered tool call, or null. */
export function pendingTool(acc) {
  let last = null;
  for (const p of acc.pending.values()) last = p;
  return last;
}

/** Tokens over time as sorted [{t, in, out, cacheRead, cacheWrite}]. */
export const bucketList = (acc) => [...acc.buckets.entries()].sort((a, b) => a[0] - b[0]).map(([t, v]) => ({ t, ...v }));

// ---- incremental file reading -------------------------------------------------------------------------------------------

export function newTracker(file) {
  return { file, offset: 0, size: -1, mtimeMs: -1, carry: Buffer.alloc(0), acc: newAcc(), bytesRead: 0, gaps: 0, resets: 0, error: null };
}

function consume(tr, lines, cfg, counters) {
  for (const raw of lines) {
    if (raw.length === 0) continue;
    const line = raw.toString('utf8');
    if (SKIP_PREFIXES.some((p) => line.startsWith(p))) { counters.rowsSkipped += 1; continue; }
    let row;
    try { row = JSON.parse(line); } catch { tr.acc.unparsed += 1; counters.rowsUnparsed += 1; continue; }
    counters.rowsParsed += 1;
    applyRow(tr.acc, row, cfg);
  }
}

/**
 * Reads what was appended since the last call. Returns true when anything was read. A file that shrank is read again from
 * its tail; more new bytes than `tailBytes` skips ahead (a gap, counted) so one poll never reads gigabytes.
 */
export function pollFile(tr, cfg, counters) {
  let st;
  try { st = fs.statSync(tr.file); } catch (err) { tr.error = err.code ?? 'stat'; return false; }
  tr.error = null;
  if (st.size === tr.size && st.mtimeMs === tr.mtimeMs) { counters.filesSkipped += 1; return false; }
  if (st.size < tr.offset) { tr.acc = newAcc(); tr.offset = 0; tr.carry = Buffer.alloc(0); tr.resets += 1; }
  let start = tr.offset;
  let dropFirst = false;
  if (st.size - start > cfg.tailBytes) {
    if (start > 0) tr.gaps += 1;
    start = st.size - cfg.tailBytes;
    dropFirst = start > 0;
    tr.carry = Buffer.alloc(0);
  }
  const len = st.size - start;
  const buf = Buffer.alloc(len);
  try {
    const fd = fs.openSync(tr.file, 'r');
    try { fs.readSync(fd, buf, 0, len, start); } finally { fs.closeSync(fd); }
  } catch (err) { tr.error = err.code ?? 'read'; return false; }
  counters.filesRead += 1; counters.bytesRead += len; tr.bytesRead += len;
  let data = tr.carry.length > 0 ? Buffer.concat([tr.carry, buf]) : buf;
  if (dropFirst) { const nl = data.indexOf(NEWLINE); data = nl < 0 ? Buffer.alloc(0) : data.subarray(nl + 1); }
  const lines = [];
  let from = 0;
  for (let nl = data.indexOf(NEWLINE, from); nl >= 0; nl = data.indexOf(NEWLINE, from)) { lines.push(data.subarray(from, nl)); from = nl + 1; }
  let rest = data.subarray(from);
  if (rest.length > 0) {
    let isWhole = false;
    try { JSON.parse(rest.toString('utf8')); isWhole = true; } catch { /* a cut-off row */ }
    if (isWhole) { lines.push(rest); rest = Buffer.alloc(0); }
    else if (rest.length > cfg.rowMaxBytes) { counters.rowsDropped += 1; rest = Buffer.alloc(0); }
  }
  tr.carry = Buffer.from(rest);
  consume(tr, lines, cfg, counters);
  tr.offset = st.size; tr.size = st.size; tr.mtimeMs = st.mtimeMs;
  return true;
}
