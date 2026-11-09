// The Progress tab: what the agent is doing NOW, its phases over real time, the checklist (posted by the agent, or derived from its brief
// with evidence-based marks), what is done so far, the decisions it stated, and what is wrong or needs you. Every line comes from the
// transcript, the pulse or the lane the agent posted (hooks/agent-progress.ts); a section with nothing to say says so in one muted line.
import { h } from './dom.js';
import { clockShort } from './detail-logic.mjs';
import { NOT_SHOWN, folderLine, mmss, phaseSegments, planCount, planMark } from './detail-progress-logic.mjs';
import { formatDuration } from './agents-info-logic.mjs';

const ISSUE_WORD = Object.freeze({ failure: 'Failed', question: 'Question', deviation: 'Deviation', wait: 'Wait' });

function section(title, note) {
  const sec = h('section', 'p-sec');
  const head = h('h3', 'p-head', title);
  if (note) head.append(h('small', '', note));
  sec.append(head);
  return sec;
}

const muted = (words) => h('p', 'p-empty', words);

/** The labelled phase bar plus the list of phases with their times. `progress.phases` empty -> one line saying why, never ticks. */
export function phaseBar(progress) {
  const box = h('div', 'p-phases');
  const segs = phaseSegments(progress.phases);
  if (segs.length === 0) {
    box.append(muted(progress.phaseNote || 'No phases can be shown: the transcript has no tool calls yet.'));
    return box;
  }
  const bar = h('div', 'p-bar');
  bar.setAttribute('role', 'img');
  bar.setAttribute('aria-label', `The run in ${segs.length} phases: ${segs.map((s) => `${s.label} ${s.time}`).join(', ')}`);
  const key = h('ol', 'p-phase-list');
  for (const s of segs) {
    const seg = h('div', 'p-seg');
    seg.dataset.kind = s.kind;
    seg.style.flex = `${s.pct} 1 0`;
    seg.title = s.title;
    if (s.failed) seg.dataset.failed = 'true';
    if (s.isCurrent) seg.dataset.current = 'true';
    if (s.showLabel) seg.append(h('span', 'p-seg-label', s.label), h('b', 'p-seg-time', s.time));
    bar.append(seg);
    const li = h('li', 'p-phase');
    li.dataset.kind = s.kind;
    if (s.failed) li.dataset.failed = 'true';
    if (s.isCurrent) li.dataset.current = 'true';
    li.append(h('i', 'p-dot'), h('span', 'p-phase-name', s.label), h('b', 'p-phase-time', s.time));
    key.append(li);
  }
  box.append(bar, key);
  return box;
}

function nowSection(d) {
  const p = d.progress;
  const sec = section('Now');
  const lines = h('div', 'p-now');
  const running = d.endedAt === null && d.state !== 'done';
  if (p.now.call) lines.append(h('p', 'p-call', `${p.now.call.text} · ${formatDuration(p.now.call.runningMs) || '<1 s'}`));
  if (p.now.say) lines.append(h('p', 'p-say', p.now.say));
  if (p.now.say && p.now.sayT) lines.append(h('small', 'p-when', `said at ${clockShort(p.now.sayT)}`));
  if (p.now.laneStep) lines.append(h('p', 'p-lane', `Posted step: ${p.now.laneStep}${p.now.laneNote ? ` · ${p.now.laneNote}` : ''}`));
  if (p.now.pace) lines.append(h('p', 'p-pace', p.now.pace));
  if (lines.children.length === 0) lines.append(muted(running ? 'Nothing said or called yet in the part of the transcript that was read.' : 'Nothing read from the transcript.'));
  sec.append(lines);
  return sec;
}

function planSection(d) {
  const plan = d.progress.plan;
  const count = planCount(plan);
  const sec = section('Checklist', count.text);
  if (plan.items.length === 0) {
    sec.append(muted('No checklist: the agent posted none and its brief has no list of steps.'));
    return sec;
  }
  sec.append(h('p', 'p-source', plan.label));
  const ul = h('ul', 'p-plan');
  for (const item of plan.items) {
    const m = planMark(item, plan.source);
    const li = h('li', 'p-item');
    li.dataset.state = item.state;
    const word = item.evidence ? `${m.word}: ${item.evidence}` : m.word;
    li.append(h('span', 'p-mark', m.mark), h('span', 'p-item-text', item.text), h('small', 'p-item-note', item.state === 'todo' && m.word === NOT_SHOWN ? NOT_SHOWN : word));
    ul.append(li);
  }
  sec.append(ul);
  return sec;
}

function doneSection(d) {
  const done = d.progress.done;
  const sec = section('Done so far', done.files > 0 ? `${done.files} file${done.files === 1 ? '' : 's'} written` : '');
  const empty = done.files === 0 && done.checks.length === 0 && done.imageCount === 0;
  if (empty) {
    sec.append(muted('No file written, no check run and no image read yet.'));
    return sec;
  }
  const ul = h('ul', 'p-done');
  for (const f of done.folders) {
    const li = h('li', 'p-folder');
    li.append(h('b', '', folderLine(f)), h('small', '', f.names.map((n) => (n.n > 1 ? `${n.name} x${n.n}` : n.name)).join(', ')));
    ul.append(li);
  }
  for (const c of done.checks) {
    const li = h('li', 'p-check');
    li.dataset.outcome = c.outcome;
    const when = c.t ? ` at ${clockShort(c.t)}` : '';
    li.append(h('b', '', c.label), h('span', 'p-check-result', `${c.result || c.outcome}${c.runs > 1 ? ` (last of ${c.runs} runs)` : ''}${when}`), h('small', 'p-check-cmd', c.cmd));
    ul.append(li);
  }
  if (done.imageCount > 0) {
    const li = h('li', 'p-images');
    li.append(h('b', '', `Looked at ${done.imageCount} image${done.imageCount === 1 ? '' : 's'}`), h('small', '', done.images.join(', ')));
    ul.append(li);
  }
  sec.append(ul);
  return sec;
}

function decisionsSection(d) {
  const sec = section('Decisions', 'extracted from the agent\'s own text');
  if (d.progress.decisions.length === 0) {
    sec.append(muted('No decision stated in the part of the transcript that was read.'));
    return sec;
  }
  const ul = h('ul', 'p-decisions');
  for (const x of d.progress.decisions) {
    const li = h('li', 'p-decision');
    li.append(h('time', 'p-time', clockShort(x.t)), h('q', '', x.quote));
    ul.append(li);
  }
  sec.append(ul);
  return sec;
}

function issuesSection(d) {
  const issues = d.progress.issues;
  const sec = section('Issues and what needs you', issues.openCount > 0 ? `${issues.openCount} open` : '');
  sec.dataset.open = String(issues.openCount > 0);
  sec.append(h('p', 'p-summary', issues.summary || (issues.list.length === 0 ? 'No failures so far.' : '')));
  if (issues.list.length === 0) return sec;
  const ul = h('ul', 'p-issues');
  for (const i of issues.list) {
    const li = h('li', 'p-issue');
    li.dataset.outcome = i.outcome;
    const top = h('div', 'p-issue-top');
    top.append(h('span', 'p-issue-kind', ISSUE_WORD[i.kind]), h('b', 'p-issue-title', i.title), h('span', 'p-chip', i.outcome === 'open' ? 'open' : 'resolved'));
    li.append(top);
    if (i.evidence) li.append(h('code', 'p-quote', i.evidence));
    if (i.t) li.append(h('time', 'p-time', clockShort(i.t)));
    ul.append(li);
  }
  sec.append(ul);
  return sec;
}

export function renderProgress(root, detail) {
  root.replaceChildren();
  const p = detail.progress;
  const phases = section('Phases', p.phases.length > 0 ? `${mmss(p.phases.reduce((s, x) => s + x.ms, 0))} in ${p.phases.length}` : '');
  phases.append(phaseBar(p));
  const grid = h('div', 'p-grid');
  const left = h('div', 'p-col');
  const right = h('div', 'p-col');
  left.append(planSection(detail), decisionsSection(detail));
  right.append(issuesSection(detail), doneSection(detail));
  grid.append(left, right);
  root.append(nowSection(detail), phases, grid);
}
