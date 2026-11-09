// The proof of a finished ticket agent under its title (T68): "Eval passed: <what>" (green) or a chip "no eval" / "eval not passed"
// (amber / red). One small element that follows `anchor`; none for an agent that is not a ticket or is still running. Updated in
// place (never rebuilt), so a row keeps its animation. Its own stylesheet (proof.css) is added once.
import { h } from './dom.js';
import { proofView } from './proof-logic.mjs';

const CSS_URL = new URL('./proof.css', import.meta.url).href;
const CLASS = 'proof';
/** The state word an unproven finished agent shows instead of "Done" (set after the host view wrote its own). */
const UNPROVEN_WORD = 'Unproven';
const STATE_WORD_SELECTOR = '.pill, .crew-chip';
let styled = false;

function ensureStyle() {
  if (styled) return;
  styled = true;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = CSS_URL;
  document.head.append(link);
}

/** Show (or remove) the proof element right after `anchor` for this agent. */
export function paintProof(anchor, agent) {
  const view = proofView(agent);
  const host = anchor.closest('li');
  if (host !== null) {
    if (view !== null && view.chip !== '') {
      host.dataset.proof = 'unproven';
      const word = host.querySelector(STATE_WORD_SELECTOR);
      if (word !== null) word.textContent = UNPROVEN_WORD;
    } else delete host.dataset.proof;
  }
  let el = anchor.nextElementSibling;
  if (el !== null && !el.classList.contains(CLASS)) el = null;
  if (view === null) {
    el?.remove();
    return;
  }
  ensureStyle();
  if (el === null) {
    el = h('span', CLASS);
    anchor.after(el);
  }
  el.dataset.tone = view.tone;
  el.dataset.kind = view.chip === '' ? 'passed' : 'chip';
  el.textContent = view.chip === '' ? `✓ ${view.line}` : view.chip;
  el.title = view.title;
}
