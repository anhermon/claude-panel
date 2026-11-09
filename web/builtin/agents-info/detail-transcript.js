// The Transcript tab of the agent detail: the brief the agent was given, then what it said and did, oldest to newest.
// Everything shown arrived redacted from the host (hooks/transcript-redact.ts); this file only draws it.
import { h } from './dom.js';
import { CAPS, callTime, clockOf, coverageText } from './detail-logic.mjs';
import { renderRun } from './detail-run.js';

/** `isRecorded`: the entry comes from the pulse's record (no transcript), which keeps no durations: show none instead of "running". */
function entryNode(e, isRecorded = false) {
  const li = h('li', `entry entry-${e.kind}`);
  const time = h('time', 'entry-time', clockOf(e.t));
  if (e.kind === 'tool') {
    li.dataset.failed = String(e.error !== null && e.error !== '');
    const head = h('span', 'entry-head');
    head.append(h('b', 'entry-tool', e.tool), h('code', 'entry-label', e.label));
    const body = h('span', 'entry-body');
    body.append(head);
    if (e.error) body.append(h('span', 'entry-error', e.error));
    else if (e.note) body.append(h('span', 'entry-note', e.note));
    if (isRecorded) li.append(time, body);
    else li.append(time, body, h('span', 'entry-dur', e.ms === null ? 'running' : callTime(e.ms)));
    return li;
  }
  const body = h('span', 'entry-body');
  if (e.kind === 'user') body.append(h('span', 'entry-who', 'Message in'));
  if (e.kind === 'think') body.append(h('span', 'entry-who', 'Thinking'));
  body.append(h('span', 'entry-text', e.text));
  li.append(time, body);
  return li;
}

/** Fill `root` with the transcript of `detail`; `hooks.more()` asks for earlier entries. */
export function renderTranscript(root, detail, hooks) {
  root.replaceChildren();
  const t = detail.transcript;
  if (detail.brief) {
    const card = h('details', 'brief');
    card.open = true;
    card.append(h('summary', '', detail.isMain ? 'Your latest message' : 'Brief this agent was given'), h('p', 'brief-text', detail.brief));
    root.append(card);
  }
  if (!t.isAvailable) {
    // No transcript: one sentence on why, then what the pulse did record (its calls), so the tab is never a bare error line.
    // A run of another harness (codex) first lists what its own record says (detail-run.js), in its own terms.
    if (detail.run) root.append(renderRun(detail.run));
    root.append(h('p', 'note warn', t.reason || 'The transcript is not available.'));
    if (t.isFromPulse) {
      const ol = h('ol', 'entries');
      for (const e of t.entries) ol.append(entryNode(e, true));
      root.append(ol);
    } else if (!detail.brief && !detail.run) root.append(h('p', 'note', 'No call of this agent was recorded either.'));
    return;
  }
  const cap = coverageText(t);
  if (cap) root.append(h('p', 'caption', cap));
  if (t.hasMore) {
    if (t.pages < CAPS.maxPages) {
      const more = h('button', 'more', 'Show earlier entries');
      more.type = 'button';
      more.addEventListener('click', hooks.more);
      root.append(more);
    } else root.append(h('p', 'caption', 'Earlier entries are not loaded: the limit for one view is reached.'));
  }
  if (t.entries.length === 0) {
    root.append(h('p', 'note', 'Nothing readable yet in this part of the transcript.'));
    return;
  }
  const ol = h('ol', 'entries');
  for (const e of t.entries) ol.append(entryNode(e));
  root.append(ol);
}
