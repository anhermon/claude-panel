// The proof of a delegated ticket as the Agents scene shows it (T68): a finished ticket agent must SHOW a passing eval.
// Pure (no DOM); tested by proof-logic.test.mjs. The mod sends `proof: { eval, what, result }` for an agent whose brief was a ticket
// (hooks/agent-proof.ts) and null for any other agent, which is never flagged. Never a ticket id in the text.

export const PROOF_RESULTS = Object.freeze(['pass', 'fail', 'none']);
export const PROOF_CAPS = Object.freeze({ eval: 200, what: 60 });
export const PROOF_TONES = Object.freeze({ ok: 'ok', warn: 'warn', danger: 'danger' });
export const CHIP_NO_EVAL = 'no eval';
export const CHIP_NOT_PASSED = 'eval not passed';
export const LINE_PASSED = 'Eval passed';
/** Only a FINISHED agent is judged: a running one has not reported yet. */
const FINISHED = 'done';

const clip = (v, max) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');

/** The wire proof -> { eval, what, result } or null (not a ticket, or junk). */
export function normalizeProof(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw) || !PROOF_RESULTS.includes(raw.result)) return null;
  return { eval: clip(raw.eval, PROOF_CAPS.eval), what: clip(raw.what, PROOF_CAPS.what), result: raw.result };
}

/**
 * What one agent shows about its proof: null (nothing: not a ticket, or still running), else
 * { tone, chip, line }: a chip ("no eval" / "eval not passed") for an unproven agent, a line ("Eval passed: <what>") for a proven one.
 */
export function proofView(agent) {
  const p = agent?.proof;
  if (!p || agent.state !== FINISHED) return null;
  if (p.eval === '') return { tone: PROOF_TONES.warn, chip: CHIP_NO_EVAL, line: '', title: 'The brief had no Eval line, so nothing proves this ticket is done' };
  if (p.result === 'pass') return { tone: PROOF_TONES.ok, chip: '', line: p.what ? `${LINE_PASSED}: ${p.what}` : LINE_PASSED, title: p.eval };
  const failed = p.result === 'fail';
  return { tone: failed ? PROOF_TONES.danger : PROOF_TONES.warn, chip: CHIP_NOT_PASSED, line: '', title: failed ? `The report says the eval failed: ${p.eval}` : `The report did not say the eval passed: ${p.eval}` };
}

/** Is a finished agent shown as proven? (A ticket agent without a passing eval is not.) */
export const isUnproven = (agent) => {
  const v = proofView(agent);
  return v !== null && v.chip !== '';
};
