// Reads a session transcript (~/.claude/projects/<slug>/<sessionId>.jsonl) INCREMENTALLY and folds its rows into a small
// accumulator: title, branch, the last prompt, the unanswered tool calls, the todo/checklist state, links, API errors.
//   * transcripts reach gigabytes: only the last `tailBytes` are read on first sight, then only appended bytes, gated on size + mtime
//   * a last line that is cut off (the writer is mid-row) is carried to the next read, never counted as broken
//   * version drift: an unknown row type or shape is ignored, a missing field is null, a row that is not JSON is skipped; nothing throws
// Every text passes ./redact.mjs before it enters the accumulator. Pure except `pollTail` (stat + read).
import fs from 'node:fs/promises';
import { oneLine } from './redact.mjs';
import { browsePrefixes, keepLatest, linksIn } from './links.mjs';

export const TAIL_BYTES = 512 * 1024;
export const SUBAGENT_TAIL_BYTES = 128 * 1024;
const HEAD_BYTES = 64 * 1024;
const ROW_MAX_BYTES = 4 * 1024 * 1024;
const NEWLINE = 0x0a;
const SKIP_PREFIXES = ['{"type":"api-request', '{"type":"file-history-snapshot']; // huge rows never needed: not even parsed
const PENDING_MAX = 24;
const PROMPTS_MAX = 20;
const ITEMS_MAX = 30;
const TITLE_CHARS = 120;
const PROMPT_CHARS = 400;
const SAY_CHARS = 1200;
const BRIEF_CHARS = 4000;
const LABEL_CHARS = 140;
const ITEM_CHARS = 140;
const SYNTHETIC_MODEL = '<synthetic>';
const ASK_TOOL = 'AskUserQuestion';
const MCP_PREFIX = /^mcp__.+?__/;
const COMMAND_TAG = /<command-name>\s*([^<]*?)\s*<\/command-name>(?:[\s\S]*?<command-args>([\s\S]*?)<\/command-args>)?/;
const ENDS_QUESTION = /\?[\s*_`"')\]>]*$/;
const TASK_ID = /Task #(\d+)/;
const SENTENCE = /^(.+?[.!?])(?=\s|$)/;
const TOOL_DETAIL_KEYS = ['description', 'command', 'file_path', 'path', 'pattern', 'url', 'query'];

export const textOf = (content) => (typeof content === 'string' ? content : Array.isArray(content) ? content.map((b) => (b !== null && typeof b === 'object' && typeof b.text === 'string' ? b.text : '')).join('\n') : '');
const tsOf = (row) => { const t = Date.parse(row?.timestamp); return Number.isFinite(t) ? t : null; };

/** `sidechain: true` keeps sidechain rows: a subagent's own transcript is all sidechain rows. */
export function newAcc({ sidechain = false } = {}) {
  return {
    sidechain,
    title: null, cwd: null, gitBranch: null, slug: null, firstTs: null, lastTs: null,
    lastPrompt: null, lastPromptTs: null, prompts: [], brief: null,
    said: null, saidTs: null, endsQuestion: false, turnError: null, turnErrorTs: null,
    pending: new Map(), list: null, tasks: new Map(), taskCreates: new Map(), listIsTasks: false,
    links: [], prefixes: new Set(), rows: 0,
  };
}

/** `<Tool>: <description | command | file | pattern>` for one tool_use block (the mcp prefix dropped), masked and cut. */
export function toolLabel(name, input) {
  const tool = typeof name === 'string' ? name.replace(MCP_PREFIX, '') : '';
  const o = input !== null && typeof input === 'object' ? input : {};
  const key = TOOL_DETAIL_KEYS.find((k) => typeof o[k] === 'string' && o[k].trim() !== '');
  return oneLine(key === undefined ? tool : `${tool}: ${o[key]}`, LABEL_CHARS);
}

/** The first sentence of an assistant text with the markdown marks taken out. */
export function firstSentence(text) {
  const plain = String(text).replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/^\s*(?:#{1,6}|>|[-*+])\s+/gm, '').replace(/[*`]|~~/g, '').replace(/\s+/g, ' ').trim();
  return SENTENCE.exec(plain)?.[1] ?? plain;
}

/** A user row's text when it is a person's prompt; null for tool results, meta rows, command tags and interrupts. */
export function promptText(row, sidechain = false) {
  if (row.isMeta === true || (row.isSidechain === true && !sidechain)) return null;
  const content = row.message?.content;
  if (Array.isArray(content) && content.some((b) => b?.type === 'tool_result')) return null;
  const text = textOf(content).trim();
  if (text === '') return null;
  const cmd = COMMAND_TAG.exec(text);
  if (cmd !== null) return `${cmd[1]}${cmd[2] ? ` ${cmd[2]}` : ''}`.trim();
  return text.startsWith('<') || text.startsWith('[Request interrupted') ? null : text;
}

const stateOfStatus = (s) => {
  const v = String(s ?? '').toLowerCase();
  if (v === 'completed' || v === 'done' || v === 'complete') return 'done';
  if (v === 'in_progress' || v === 'doing' || v === 'active') return 'doing';
  if (v === 'failed' || v === 'error') return 'failed';
  return 'todo';
};

const itemsOf = (list, textKeys) => (Array.isArray(list) ? list : []).filter((i) => i !== null && typeof i === 'object').slice(0, ITEMS_MAX)
  .map((i) => ({ t: oneLine(String(textKeys.map((k) => i[k]).find((v) => typeof v === 'string' && v.trim() !== '') ?? ''), ITEM_CHARS), state: stateOfStatus(i.status) }))
  .filter((i) => i.t !== '');

function onToolUse(acc, b, ts) {
  const name = b.name;
  const id = typeof b.id === 'string' ? b.id : null;
  const input = b.input !== null && typeof b.input === 'object' ? b.input : {};
  if (name === 'TodoWrite') { acc.list = itemsOf(input.todos, ['activeForm', 'content']); acc.listIsTasks = false; }
  else if (name.endsWith('__checklist')) { acc.list = itemsOf(input.items, ['content', 'text', 'title']); acc.listIsTasks = false; }
  else if (name === 'TaskCreate' && id !== null) {
    acc.taskCreates.set(id, oneLine(String(input.subject ?? ''), ITEM_CHARS));
    if (acc.taskCreates.size > PENDING_MAX) acc.taskCreates.delete(acc.taskCreates.keys().next().value);
  } else if (name === 'TaskUpdate' && typeof input.taskId === 'string') {
    const task = acc.tasks.get(input.taskId);
    if (input.status === 'deleted') acc.tasks.delete(input.taskId);
    else if (task !== undefined) task.state = input.status === undefined ? task.state : stateOfStatus(input.status);
    acc.listIsTasks = true;
  }
  if (id === null) return;
  const entry = { name: name.slice(0, 80), label: toolLabel(name, input), ts };
  if (name === ASK_TOOL) {
    const q = Array.isArray(input.questions) ? input.questions.find((x) => x !== null && typeof x === 'object') : undefined;
    entry.ask = { header: oneLine(String(q?.header ?? ''), 60), question: oneLine(String(q?.question ?? ''), 240) };
  }
  acc.pending.set(id, entry);
  if (acc.pending.size > PENDING_MAX) acc.pending.delete(acc.pending.keys().next().value);
}

function onAssistant(acc, row, ts) {
  const msg = row.message;
  if (msg === null || typeof msg !== 'object' || (row.isSidechain === true && !acc.sidechain)) return;
  if (row.isApiErrorMessage === true) {
    acc.turnError = oneLine(textOf(msg.content).split('\n').find((l) => l.trim() !== '') ?? 'API error', 200);
    acc.turnErrorTs = ts;
  } else if (msg.model !== SYNTHETIC_MODEL) {
    acc.turnError = null;
  }
  for (const b of Array.isArray(msg.content) ? msg.content : []) {
    if (b === null || typeof b !== 'object') continue;
    if (b.type === 'text' && typeof b.text === 'string' && b.text.trim() !== '' && row.isApiErrorMessage !== true) {
      acc.said = oneLine(firstSentence(b.text), 240);
      acc.saidTs = ts;
      acc.endsQuestion = ENDS_QUESTION.test(b.text.trimEnd());
      for (const p of browsePrefixes(b.text)) acc.prefixes.add(p);
      const found = linksIn(b.text.slice(0, SAY_CHARS * 8));
      if (found.length > 0) acc.links = keepLatest(acc.links, found.map((l) => ({ ...l, ts })));
    } else if (b.type === 'tool_use' && typeof b.name === 'string') {
      acc.endsQuestion = false;
      onToolUse(acc, b, ts);
    }
  }
}

function onUser(acc, row, ts) {
  const content = row.message?.content;
  for (const b of Array.isArray(content) ? content : []) {
    if (b === null || typeof b !== 'object' || b.type !== 'tool_result') continue;
    const id = typeof b.tool_use_id === 'string' ? b.tool_use_id : null;
    if (id === null) continue;
    acc.pending.delete(id);
    if (acc.taskCreates.has(id)) {
      const made = row.toolUseResult?.task?.id ?? TASK_ID.exec(textOf(b.content))?.[1];
      if (made !== undefined && made !== null) acc.tasks.set(String(made), { t: acc.taskCreates.get(id), state: 'todo' });
      acc.taskCreates.delete(id);
      acc.listIsTasks = true;
    }
  }
  const prompt = promptText(row, acc.sidechain);
  if (prompt === null) return;
  acc.lastPrompt = oneLine(prompt, PROMPT_CHARS);
  acc.lastPromptTs = ts;
  acc.prompts.push(acc.lastPrompt);
  if (acc.prompts.length > PROMPTS_MAX) acc.prompts.shift();
  for (const p of browsePrefixes(prompt)) acc.prefixes.add(p);
  // what the assistant said before this prompt is about the previous turn
  acc.said = null; acc.saidTs = null; acc.endsQuestion = false; acc.turnError = null; acc.turnErrorTs = null;
}

/** Folds one parsed row into the accumulator. Never throws on odd shapes. */
export function applyRow(acc, row) {
  if (row === null || typeof row !== 'object' || Array.isArray(row)) return;
  acc.rows += 1;
  const ts = tsOf(row);
  if (ts !== null) { acc.firstTs = acc.firstTs === null ? ts : Math.min(acc.firstTs, ts); acc.lastTs = acc.lastTs === null ? ts : Math.max(acc.lastTs, ts); }
  if (typeof row.cwd === 'string') acc.cwd = row.cwd.slice(0, 400);
  if (typeof row.gitBranch === 'string') acc.gitBranch = row.gitBranch.slice(0, 120);
  if (typeof row.slug === 'string') acc.slug = row.slug.slice(0, 80);
  switch (row.type) {
    case 'ai-title': if (typeof row.aiTitle === 'string') acc.title = oneLine(row.aiTitle, TITLE_CHARS); break;
    case 'custom-title': if (typeof row.customTitle === 'string' && row.customTitle.trim() !== '') acc.title = oneLine(row.customTitle, TITLE_CHARS); break;
    case 'last-prompt': if (typeof row.lastPrompt === 'string' && !row.lastPrompt.trim().startsWith('<')) acc.lastPrompt = oneLine(row.lastPrompt, PROMPT_CHARS); break;
    case 'assistant': onAssistant(acc, row, ts); break;
    case 'user': onUser(acc, row, ts); break;
    default:
  }
}

/** The newest unanswered tool call, or null. */
export function lastPending(acc) {
  let last = null;
  for (const p of acc.pending.values()) last = p;
  return last;
}

/** The unanswered AskUserQuestion calls, newest last. */
export const pendingAsks = (acc) => [...acc.pending.values()].filter((p) => p.ask !== undefined);

/** The todo / checklist state: [{ t, state }] from whichever source was written last. */
export function todosOf(acc) {
  if (acc.listIsTasks) return [...acc.tasks.values()].slice(0, ITEMS_MAX);
  return acc.list ?? [];
}

// ---- incremental file reading -------------------------------------------------------------------------------------------

export function newTracker(file, accOptions = {}) {
  return { file, accOptions, offset: 0, size: -1, mtimeMs: -1, carry: Buffer.alloc(0), acc: newAcc(accOptions), headDone: false, error: null };
}

function consume(tr, lines) {
  for (const raw of lines) {
    if (raw.length === 0) continue;
    const line = raw.toString('utf8');
    if (SKIP_PREFIXES.some((p) => line.startsWith(p))) continue;
    try { applyRow(tr.acc, JSON.parse(line)); } catch { /* not JSON: skipped */ }
  }
}

async function readRange(file, start, len) {
  const fh = await fs.open(file, 'r');
  try {
    const buf = Buffer.alloc(len);
    const { bytesRead } = await fh.read(buf, 0, len, start);
    return buf.subarray(0, bytesRead);
  } finally { await fh.close(); }
}

/**
 * The first bytes of a transcript, read once: a long transcript's tail may hold no title row, and a subagent's first user row
 * is its brief (which names the ticket), written before the tail starts.
 */
async function readHead(tr) {
  tr.headDone = true;
  try {
    const head = (await readRange(tr.file, 0, HEAD_BYTES)).toString('utf8').split('\n').slice(0, -1);
    for (const line of head) {
      if (SKIP_PREFIXES.some((p) => line.startsWith(p))) continue;
      const isTitle = line.includes('-title"');
      const isBrief = tr.acc.sidechain && tr.acc.brief === null && line.startsWith('{') && line.includes('"type":"user"');
      if (!isTitle && !isBrief) continue;
      const row = JSON.parse(line);
      if (row.type === 'ai-title' && typeof row.aiTitle === 'string') tr.acc.title ??= oneLine(row.aiTitle, TITLE_CHARS);
      if (row.type === 'custom-title' && typeof row.customTitle === 'string') tr.acc.title ??= oneLine(row.customTitle, TITLE_CHARS);
      if (isBrief && row.type === 'user' && row.isMeta !== true) {
        const text = textOf(row.message?.content).trim();
        if (text !== '') {
          tr.acc.brief = oneLine(text, BRIEF_CHARS);
          for (const p of browsePrefixes(text)) tr.acc.prefixes.add(p);
        }
      }
    }
  } catch { /* nothing from the head */ }
}

/**
 * Reads what was appended since the last call; `st` is the file's fresh stat. Returns true when anything was read. A file
 * that shrank is read again from its tail; more new bytes than `tailBytes` skips ahead so one poll never reads gigabytes.
 */
export async function pollTail(tr, st, tailBytes = TAIL_BYTES) {
  if (st.size === tr.size && st.mtimeMs === tr.mtimeMs) return false;
  if (st.size < tr.offset) { tr.acc = newAcc(tr.accOptions); tr.offset = 0; tr.carry = Buffer.alloc(0); tr.headDone = false; }
  let start = tr.offset;
  let dropFirst = false;
  if (st.size - start > tailBytes) {
    start = st.size - tailBytes;
    dropFirst = start > 0;
    tr.carry = Buffer.alloc(0);
  }
  let buf;
  try { buf = await readRange(tr.file, start, st.size - start); } catch (err) { tr.error = err.code ?? 'read'; return false; }
  tr.error = null;
  let data = tr.carry.length > 0 ? Buffer.concat([tr.carry, buf]) : buf;
  if (dropFirst) { const nl = data.indexOf(NEWLINE); data = nl < 0 ? Buffer.alloc(0) : data.subarray(nl + 1); }
  const lines = [];
  let from = 0;
  for (let nl = data.indexOf(NEWLINE, from); nl >= 0; nl = data.indexOf(NEWLINE, from)) { lines.push(data.subarray(from, nl)); from = nl + 1; }
  let rest = data.subarray(from);
  if (rest.length > 0) {
    let isWhole = false;
    try { JSON.parse(rest.toString('utf8')); isWhole = true; } catch { /* a cut-off row */ }
    if (isWhole) { lines.push(rest); rest = Buffer.alloc(0); } else if (rest.length > ROW_MAX_BYTES) rest = Buffer.alloc(0);
  }
  tr.carry = Buffer.from(rest);
  consume(tr, lines);
  tr.offset = st.size; tr.size = st.size; tr.mtimeMs = st.mtimeMs;
  const needsHead = tr.acc.sidechain ? tr.acc.brief === null : tr.acc.title === null && st.size > tailBytes;
  if (needsHead && !tr.headDone) await readHead(tr);
  return true;
}
