// The send-message contract between the page's server and the mod's hub (hooks/fleet-contract.ts holds the twin numbers,
// web/fleet/contract.test.mjs fails when they differ). The server writes <commandsDir>/<id>.json; the hub validates it again,
// claims it, sends, and writes <resultsDir>/<id>.json. Only this templated text message crosses: no other control exists.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DIR_MODE, FILE_MODE } from './config.mjs';
import { isSessionId } from './registry.mjs';
import { writeAtomic } from './feed.mjs';

export const ORIGIN = 'fleet-ui';
export const ORIGIN_PREFIX = '[sent from fleet control panel by the user]';
export const COMMAND_ID = /^[0-9a-f]{32}$/;
export const STATUS = Object.freeze({ PENDING: 'pending', QUEUED: 'queued', REFUSED: 'refused', FAILED: 'failed' });
const PENDING_COMMANDS_MAX = 50;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/** Validates what the browser posted against the current state. Returns { ok:true, text, session } or { ok:false, reason }. */
export function checkSend(body, state, cfg) {
  if (body === null || typeof body !== 'object') return { ok: false, reason: 'body must be a JSON object' };
  if (!isSessionId(body.sessionId)) return { ok: false, reason: 'sessionId is not a session id' };
  if (typeof body.text !== 'string') return { ok: false, reason: 'text must be a string' };
  const text = body.text.replace(CONTROL, '').trim();
  if (text === '') return { ok: false, reason: 'the message is empty' };
  if (text.length > cfg.messageMaxChars) return { ok: false, reason: `the message is longer than ${cfg.messageMaxChars} characters` };
  if (text.includes(ORIGIN_PREFIX)) return { ok: false, reason: 'the message already carries the fleet marker' };
  const session = state.sessions.find((s) => s.id === body.sessionId.toLowerCase());
  if (session === undefined) return { ok: false, reason: 'no such session in the fleet' };
  if (!session.live || session.pid === null) return { ok: false, reason: 'that session is not running' };
  return { ok: true, text, session };
}

/** Writes the command file (0600, atomic). Refuses when too many commands are waiting. */
export function enqueue(cfg, session, text, now = Date.now()) {
  fs.mkdirSync(cfg.commandsDir, { recursive: true, mode: DIR_MODE });
  if (fs.readdirSync(cfg.commandsDir).filter((n) => n.endsWith('.json')).length >= PENDING_COMMANDS_MAX) return { ok: false, reason: 'too many messages are waiting for the hub' };
  const id = crypto.randomBytes(16).toString('hex');
  const command = { id, sessionId: session.id, pid: session.pid, procStart: session.procStart, text, ts: now, origin: ORIGIN };
  writeAtomic(path.join(cfg.commandsDir, `${id}.json`), JSON.stringify(command));
  return { ok: true, id };
}

/** The result for a command id: { status:'pending' } until the hub wrote one. */
export function readResult(cfg, id) {
  if (!COMMAND_ID.test(id)) return null;
  try {
    const r = JSON.parse(fs.readFileSync(path.join(cfg.resultsDir, `${id}.json`), 'utf8'));
    return { id, status: String(r.status ?? STATUS.FAILED), reason: typeof r.reason === 'string' ? r.reason.slice(0, 300) : null, ts: Number.isFinite(r.ts) ? r.ts : null };
  } catch { return { id, status: STATUS.PENDING, reason: null, ts: null }; }
}

export { FILE_MODE };
