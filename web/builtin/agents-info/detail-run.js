// The Transcript tab of a run of another harness with no transcript (see detail-run-logic.mjs): what its record says, as a fact list, the brief
// and the final report when the record has them, and one line for everything it does not hold. Data arrived scrubbed from the host.
import { h } from './dom.js';
import { clockOf } from './detail-logic.mjs';
import { factsOf, harnessWord } from './detail-run-logic.mjs';

const PROMPT_TITLE = Object.freeze({ file: 'Brief this run was given', head: 'Start of the brief (as delegation-kit kept it)' });

function textBlock(title, text) {
  const card = h('details', 'brief');
  card.open = true;
  card.append(h('summary', '', title), h('p', 'brief-text', text));
  return card;
}

/** The node of one run's record; `run` is a normalized run (normalizeRun). */
export function renderRun(run) {
  const box = h('section', 'run-record');
  box.dataset.notStarted = String(run.isNotStarted);
  const dl = h('dl', 'run-facts');
  for (const [label, value] of factsOf(run, clockOf)) dl.append(h('dt', '', label), h('dd', '', value));
  box.append(h('h3', 'run-head', `${harnessWord(run.harness) || 'Agent'} run`), dl);
  if (run.prompt) box.append(textBlock(PROMPT_TITLE[run.prompt.source], run.prompt.text));
  if (run.result) box.append(textBlock('Final report', run.result));
  if (run.absent.length > 0) {
    const ul = h('ul', 'run-absent');
    for (const s of run.absent) ul.append(h('li', '', s));
    box.append(ul);
  }
  return box;
}
