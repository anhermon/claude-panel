import { plainTitle } from '../../kit/panel/plain-title.mjs';
// Pure logic of the two router frames (frames/tickets.js, frames/checks.js): what the page keeps of what the mod sent, the
// stage -> look mapping that keeps "claimed done" and "verified done" visibly different, and the height each frame needs.
// No DOM, no clock. Tested by router-frames-logic.test.mjs. Contract: the router-kit state (ticket.json / verdict.checks).

export const STAGES = Object.freeze(['draft', 'ready', 'building', 'verifying', 'fixing', 'done', 'unproven', 'unverified', 'blocked']);
export const ROUTER_CAPS = Object.freeze({ items: 12, checks: 12, title: 60, id: 12, agent: 20, note: 120, evidence: 400, deps: 3, afterTitle: 24, evalWhat: 60, evalEvidence: 120 });
const TASK_TITLE = 'Task';
const PASS = 'PASS';
const FAIL = 'FAIL';

/** The looks a ticket row can have. `verified` and `unverified` are deliberately far apart: a claim is not a check. */
export const LOOKS = Object.freeze({
  verified: { label: 'Verified', mark: '✓', tone: 'ok' },
  unproven: { label: 'Done, unproven', mark: '!', tone: 'warn' },
  done: { label: 'Done, no verdict', mark: '!', tone: 'warn' },
  unverified: { label: 'Claimed done, not verified', mark: '!', tone: 'warn' },
  blocked: { label: 'Blocked', mark: '✕', tone: 'danger' },
  fixing: { label: 'Fixing', mark: '↻', tone: 'acc' },
  verifying: { label: 'Verifying', mark: '◎', tone: 'acc' },
  building: { label: 'Building', mark: '●', tone: 'acc' },
  ready: { label: 'Ready', mark: '○', tone: 'mut' },
  draft: { label: 'Draft', mark: '○', tone: 'mut' },
});

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const cut = (v, max) => {
  const s = typeof v === 'string' || typeof v === 'number' ? String(v).replace(/\s+/g, ' ').trim() : '';
  return s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
};
const arr = (v, max) => (Array.isArray(v) ? v.slice(0, max) : []);
const whole = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : null);
const verdictOf = (v) => (v === PASS || v === FAIL ? v : null);

/** The eval of a ticket as the page keeps it: an absent or odd one is "no eval". */
const EVAL_RESULTS = Object.freeze(['pass', 'fail', 'none']);
const evalOfItem = (v) => {
  const e = isObj(v) ? v : {};
  const what = cut(plainTitle(e.what, false), ROUTER_CAPS.evalWhat);
  const present = e.present === true && what !== '';
  return { present, what, result: EVAL_RESULTS.includes(e.result) ? e.result : 'none', evidence: cut(plainTitle(e.evidence, false), ROUTER_CAPS.evalEvidence) };
};
/** Is the eval a PASSING proof: present and passed. */
export const evalProves = (e) => e.present && e.result === 'pass';

/** Which look a (stage, verdict, eval) triple gets. Only done + PASS + a passed eval is "verified"; done + PASS without one is "unproven". */
export const lookOf = (stage, verdict, evalResult = 'none', evalPresent = false) => {
  if (stage === 'done') return verdict !== PASS ? 'done' : evalPresent && evalResult === 'pass' ? 'verified' : 'unproven';
  return Object.hasOwn(LOOKS, stage) ? stage : 'draft';
};

export function normalizeTickets(f) {
  const items = arr(f.items, ROUTER_CAPS.items).filter(isObj).map((it) => {
    const stage = STAGES.includes(it.stage) ? it.stage : 'draft';
    const verdict = verdictOf(it.verdict);
    const proof = evalOfItem(it.eval);
    const total = whole(it.checks?.total);
    const pass = total === null ? null : Math.min(total, whole(it.checks?.pass) ?? 0);
    const maxRounds = whole(it.maxRounds);
    return {
      id: cut(it.id, ROUTER_CAPS.id), title: cut(plainTitle(it.title || it.id, false), ROUTER_CAPS.title) || (it.id || it.title ? TASK_TITLE : ''), stage, verdict, proof, look: lookOf(stage, verdict, proof.result, proof.present),
      agent: cut(plainTitle(it.agent, false), ROUTER_CAPS.agent), note: cut(plainTitle(it.note, false), ROUTER_CAPS.note),
      checks: total === null || total === 0 ? null : { pass, total },
      round: whole(it.round) || null, maxRounds: maxRounds || null,
      after: arr(it.dependsOn, ROUTER_CAPS.deps).map((d) => cut(d, ROUTER_CAPS.id)).filter(Boolean),
    };
  }).filter((it) => it.title !== '' || it.id !== '');
  // "after 01-schema" reads as "after Booking schema": a dependency is named by its ticket's title when that ticket is in the list
  const titleOfId = new Map(items.map((it) => [it.id, it.title || it.id]));
  for (const it of items) it.after = it.after.map((d) => cut(titleOfId.get(d) ?? (plainTitle(d, false) || TASK_TITLE), ROUTER_CAPS.afterTitle));
  const verified = items.filter((it) => it.look === 'verified').length;
  const s = isObj(f.summary) ? f.summary : {};
  // the counts the mod sent win (it saw all tickets, the page may have cut some); else count what is here
  const count = (key, fallback) => whole(s[key]) ?? fallback;
  const summary = {
    total: count('total', items.length), verified: count('verified', verified),
    unproven: count('unproven', items.filter((it) => it.look === 'unproven').length),
    unverified: count('unverified', items.filter((it) => it.stage === 'unverified' || it.look === 'done').length),
    blocked: count('blocked', items.filter((it) => it.stage === 'blocked').length),
    inflight: count('inflight', items.filter((it) => ['building', 'verifying', 'fixing'].includes(it.stage)).length),
  };
  return { items, summary };
}

export function normalizeChecks(f) {
  const items = arr(f.items, ROUTER_CAPS.checks).filter(isObj).map((it) => ({
    item: cut(plainTitle(it.item, false), ROUTER_CAPS.title * 2), pass: it.pass === true ? true : it.pass === false ? false : null, evidence: cut(plainTitle(it.evidence, false), ROUTER_CAPS.evidence),
  })).filter((it) => it.item !== '');
  const maxRounds = whole(f.maxRounds);
  const round = whole(f.round);
  const passed = items.filter((it) => it.pass === true).length;
  return { result: verdictOf(f.result), round: round || null, maxRounds: maxRounds || null, items, passed };
}

/** The proof line of a verified row: "Eval passed: <what>"; '' for any other row (a claim carries no proof line). */
export const proofText = (it) => (it.look === 'verified' && it.proof.what !== '' ? `Eval passed: ${it.proof.what}` : '');
const NO_EVAL = 'no eval';
const EVAL_NOT_PASSED = 'eval not passed';
/** The chip of a row that says it is done but has no passing eval: `{ text, tone }`, else null. A failed eval is danger, a missing or unrun one warn. */
export const evalChipOf = (it) => {
  if (it.look !== 'unproven' && it.look !== 'unverified' && it.look !== 'done') return null;
  if (!it.proof.present) return { text: NO_EVAL, tone: 'warn' };
  return { text: EVAL_NOT_PASSED, tone: it.proof.result === 'fail' ? 'danger' : 'warn' };
};

/** "round 1/2" for a ticket row, only while it is being fixed (or ended unverified/blocked after fixing). */
export const roundText = (it) => (it.round && (it.stage === 'fixing' || it.stage === 'unverified' || it.stage === 'blocked') ? `round ${it.round}${it.maxRounds ? `/${it.maxRounds}` : ''}` : '');
/** "after 01, 02" */
export const afterText = (it) => (it.after.length > 0 ? `after ${it.after.join(', ')}` : '');
/** The header story: "3 of 5 verified". */
export const verifiedText = (s) => `${s.verified} of ${s.total} verified`;
/** Fix round line of the checks frame. */
export const fixRoundText = (c) => (c.round ? `fix round ${c.round}${c.maxRounds ? ` of ${c.maxRounds}` : ''}` : '');

// ---- the height each frame needs (em of the text floor) ---------------------------------------------------------------------
const EM = Object.freeze({ head: 2.2, gap: 0.5, tkRow: 4.6, tkRowCompact: 2.4, tkNote: 1.3, tkProof: 1.3, ckHead: 2.4, ckRow: 4.4, ckRowCompact: 1.6 });
const n = (v) => (Array.isArray(v) ? v.length : 0);

/** Px height of the body of a tickets / checks frame at a text floor; `compact` drops the second lines. 0 for another type. */
export function routerBodyPx(frame, { compact = false, floor = 14 } = {}) {
  let em = 0;
  if (frame.type === 'tickets') {
    const noted = compact ? 0 : frame.items?.filter?.((it) => it?.note).length ?? 0;
    const proved = frame.items?.filter?.((it) => it?.eval?.present && it?.eval?.result === 'pass' && it?.stage === 'done').length ?? 0;
    em = EM.head + Math.max(1, n(frame.items)) * ((compact ? EM.tkRowCompact : EM.tkRow) + EM.gap) + noted * EM.tkNote + proved * EM.tkProof;
  } else if (frame.type === 'checks') {
    em = EM.ckHead + Math.max(1, n(frame.items)) * ((compact ? EM.ckRowCompact : EM.ckRow) + EM.gap);
  }
  return Math.round(em * floor);
}
