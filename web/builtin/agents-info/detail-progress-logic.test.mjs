// Pure logic of the Progress and Struggles tabs: node --test web/builtin/agents-info/*.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { LABEL_SEGMENT_PCT, MIN_SEGMENT_PCT, NOT_SHOWN, countText, folderLine, hasOpenIssue, mmss, normalizeProgress, normalizeStruggles, phaseSegments, planCount, planMark, struggleGroups, whenRange } from './detail-progress-logic.mjs';

const T = 1_767_000_000_000;
const phase = (label, ms, over = {}) => ({ label, kind: 'read', a: 0, b: ms, ms, n: 1, failed: false, isCurrent: false, ...over });

test('normalizeProgress: garbage and a missing field give the empty progress, never a throw', () => {
  for (const v of [undefined, null, 1, 'x', [], {}]) {
    const p = normalizeProgress(v);
    assert.equal(p.plan.items.length, 0);
    assert.equal(p.phases.length, 0);
    assert.equal(p.now.call, null);
    assert.equal(p.issues.openCount, 0);
  }
  assert.equal(normalizeProgress(undefined).isEmpty, true);
  assert.equal(normalizeProgress({}).isEmpty, false);
});

test('normalizeProgress keeps what is valid and drops what is not (unknown states, phases that end before they start)', () => {
  const p = normalizeProgress({
    now: { say: 'Editing.', sayT: T, call: { text: 'running tsc', runningMs: 5000 }, pace: '', laneStep: 's', laneNote: 'n' },
    plan: { source: 'brief', label: "from the agent's brief", items: [{ text: 'a', state: 'done', evidence: 'edited a.ts' }, { text: 'b', state: 'weird' }, { text: '' }, 5] },
    phases: [{ label: 'tests', kind: 'tests', a: 10, b: 5 }, { label: 'read files', kind: 'read', a: 0, b: 90_000, n: 3 }, { label: 'x', kind: 'mystery', a: 0, b: 1 }],
    issues: { openCount: 0, summary: 's', list: [{ kind: 'failure', title: 'tsc failed', evidence: 'error TS1', t: T, outcome: 'open' }, { title: '' }] },
  });
  assert.deepEqual(p.plan.items.map((i) => i.state), ['done', 'todo']);
  assert.deepEqual(p.phases.map((x) => [x.label, x.kind]), [['read files', 'read'], ['x', 'other']]);
  assert.equal(p.issues.openCount, 1);
  assert.equal(hasOpenIssue(p), true);
  assert.equal(p.now.call.runningMs, 5000);
});

test('normalizeStruggles: only known kinds with a time; an old array shape gives an empty report', () => {
  const r = normalizeStruggles({
    headline: '1 test failure still open', badge: 1, open: 1, resolved: 0,
    items: [{ kind: 'edit-test-cycle', title: 't', evidence: 'expected T43', t: T, lastT: T + 5000, n: 4, outcome: 'open', hint: 'h' }, { kind: 'mystery', title: 'x', t: T }, { kind: 'slow-call', title: 'no time' }],
    calm: [{ title: 'Iterating on a.js (11 edits, no failures)', n: 11 }, 3],
  });
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].n, 4);
  assert.equal(r.calm.length, 1);
  assert.deepEqual(normalizeStruggles([{ kind: 'error', text: 'x' }]).items, []);
  assert.equal(normalizeStruggles(undefined).badge, 0);
});

test('mmss reads like a stopwatch', () => {
  assert.equal(mmss(130_000), '2:10');
  assert.equal(mmss(42_000), '0:42');
  assert.equal(mmss(3_730_000), '1:02:10');
  assert.equal(mmss(-5), '0:00');
});

test('phaseSegments: widths add up to 100, follow the real time, never vanish; only wide segments carry their label', () => {
  const segs = phaseSegments([phase('read files', 130_000), phase('edit crew-view.js', 220_000), phase('tests', 65_000), phase('read files', 1_000)]);
  assert.equal(Math.round(segs.reduce((s, x) => s + x.pct, 0)), 100);
  assert.ok(segs[1].pct > segs[0].pct && segs[0].pct > segs[2].pct);
  assert.ok(segs[3].pct >= MIN_SEGMENT_PCT * 0.9);
  assert.deepEqual(segs.map((s) => s.time), ['2:10', '3:40', '1:05', '0:01']);
  assert.equal(segs[1].showLabel, true);
  assert.equal(segs[3].showLabel, false);
  assert.ok(segs[1].pct >= LABEL_SEGMENT_PCT);
  assert.deepEqual(phaseSegments([]), []);
});

test('planCount and planMark: a brief-derived list says "shown done" and "not shown yet"; a posted one says "done" and "to do"', () => {
  const brief = { source: 'brief', items: [{ state: 'done' }, { state: 'todo' }, { state: 'doing' }] };
  assert.equal(planCount(brief).text, '1 of 3 shown done');
  assert.equal(planMark({ state: 'todo' }, 'brief').word, NOT_SHOWN);
  assert.equal(planCount({ source: 'lane', items: [{ state: 'done' }, { state: 'done' }] }).text, '2 of 2 done');
  assert.equal(planMark({ state: 'todo' }, 'lane').word, 'to do');
  assert.equal(planCount({ source: 'none', items: [] }).text, '');
});

test('struggleGroups puts open problems first and leaves empty groups out; counts and times read well', () => {
  const item = (outcome, over = {}) => ({ kind: 'failing-loop', title: 't', evidence: 'e', t: T, lastT: T, n: 1, outcome, hint: '', recent: false, ...over });
  const groups = struggleGroups({ items: [item('resolved'), item('open'), item('resolved')] });
  assert.deepEqual(groups.map((g) => [g.id, g.items.length]), [['open', 1], ['resolved', 2]]);
  assert.deepEqual(struggleGroups({ items: [item('resolved')] }).map((g) => g.id), ['resolved']);
  assert.deepEqual(struggleGroups({ items: [] }), []);
  assert.equal(countText(1), '');
  assert.equal(countText(4), 'x4');
  assert.equal(whenRange(item('open', { lastT: T + 60_000 }), (t) => String((t - T) / 1000)), '0–60');
  assert.equal(whenRange(item('open'), () => '10:00'), '10:00');
  assert.equal(folderLine({ dir: 'hooks', created: 1, edited: 3 }), 'hooks: 1 created, 3 edited');
});
