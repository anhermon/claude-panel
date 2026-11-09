// A codex attempt that never started (T77): clean data, the row's words, the grey ring, the hollow bar, the detail's fact list.
// node --test web/builtin/agents-info/not-started.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CAPS, normalizeData, sortAgents, summaryOf } from './agents-info-logic.mjs';
import { NOT_STARTED_WORD, chipText, ringPctOf } from './avatar-model.mjs';
import { endMarkOf, spanOf, tooltipOf } from './gantt-logic.mjs';
import { factsOf, harnessWord, normalizeRun } from './detail-run-logic.mjs';

const MIN = 60_000;
const NOW = Date.UTC(2026, 10, 9, 12, 0, 0);
const NOTE = 'Not started: machine busy (load governor)';
const LONG_NAME = 'Write the migration for the orders table and its three indexes';
const raw = (over = {}) => ({ id: 'run-x', state: 'waiting', name: 'Harder autonomy traps', short: 'Harder', startedAt: NOW - MIN, endedAt: NOW - MIN + 500, harness: 'codex', model: 'gpt-6.1-sol', effort: 'high', ...over });
const agentsOf = (...rows) => normalizeData({ overall: 'working', agents: rows }).agents;
const notStarted = (over = {}) => agentsOf(raw({ notStarted: true, note: NOTE, ...over }))[0];

test('normalize: notStarted and the note are kept; any other value of notStarted is false; the note is capped', () => {
  assert.equal(notStarted().notStarted, true);
  assert.equal(notStarted().note, NOTE);
  assert.equal(agentsOf(raw({ notStarted: 'yes' }))[0].notStarted, false);
  assert.equal(notStarted({ note: 'x'.repeat(500) }).note.length, CAPS.note);
});

test('a long codex description is not cut at 28 characters; the id has its own, longer cap', () => {
  assert.ok(CAPS.name > 28);
  assert.equal(notStarted({ name: LONG_NAME }).name, LONG_NAME);
  assert.equal(notStarted({ name: LONG_NAME, id: 'run-' + 'a'.repeat(60) }).id.length, 64);
});

test('the summary counts a not-started attempt apart: never as done or waiting', () => {
  const agents = agentsOf(raw({ id: 'a', state: 'done' }), raw({ id: 'b', notStarted: true, note: NOTE }), raw({ id: 'c', state: 'waiting' }), raw({ id: 'm', isMain: true, state: 'working' }));
  assert.equal(summaryOf(agents), '1 waiting · 1 done · 1 not started');
  assert.ok(!summaryOf(agentsOf(raw({ notStarted: true }))).includes('done'));
});

test('sorting puts a not-started attempt after the finished ones', () => {
  const agents = agentsOf(raw({ id: 'ns', notStarted: true }), raw({ id: 'done', state: 'done' }), raw({ id: 'run', state: 'working' }));
  assert.deepEqual(sortAgents(agents).map((a) => a.id), ['run', 'done', 'ns']);
});

test('the ring is empty and the chip says "Not started"; the plain waiting agent keeps its own', () => {
  assert.equal(ringPctOf(notStarted({ pct: 60 })), 0);
  assert.equal(chipText(notStarted()), NOT_STARTED_WORD);
  assert.notEqual(chipText(agentsOf(raw())[0]), NOT_STARTED_WORD);
});

test('the bar: no check mark or cross, the tooltip says not started with the reason and the try time, the span says "tried"', () => {
  const a = notStarted({ state: 'done' });
  assert.equal(endMarkOf(a), null);
  const tip = tooltipOf(a, NOW);
  assert.ok(tip.includes('not started') && tip.includes(NOTE) && tip.includes('tried'));
  assert.ok(!tip.includes('ended') && !tip.includes('running'));
  assert.match(spanOf(a, NOW), /^tried \d{1,2}:\d{2}/);
  assert.equal(endMarkOf(agentsOf(raw({ state: 'done', endedAt: NOW }))[0]), 'check');
});

const runRaw = (over = {}) => ({ harness: 'codex', status: 'Not started', recordStatus: 'deferred', isNotStarted: true, startedAt: NOW - MIN, endedAt: null, model: 'gpt-6.1-sol', effort: 'high', title: 'Harder autonomy traps', verdict: null, tokens: null, reason: 'load_governor: load 11', prompt: { text: 'Do it', source: 'head' }, result: null, absent: ['no rollout found for this run'], ...over });
const clock = (t) => `t${t - NOW}`;

test('detail run: junk is no run; a good one is cleaned and capped', () => {
  for (const junk of [null, undefined, 5, 'x', [], {}, { status: 7 }]) assert.equal(normalizeRun(junk), null);
  const run = normalizeRun(runRaw({ absent: Array.from({ length: 30 }, (_, i) => `n${i}`), prompt: { text: 'y'.repeat(9000), source: 'weird' } }));
  assert.equal(run.absent.length, 8);
  assert.equal(run.prompt.text.length, 4000);
  assert.equal(run.prompt.source, 'head');
  assert.equal(run.result, null);
  assert.equal(harnessWord('codex'), 'Codex');
  assert.equal(harnessWord(''), '');
});

test('detail run facts: status first, then time, model:effort, description, reason; a not-started attempt says "Tried at" and has no end', () => {
  const rows = factsOf(normalizeRun(runRaw()), clock);
  assert.deepEqual(rows.map((r) => r[0]), ['Status', 'Tried at', 'Model', 'Description', 'Why it did not start']);
  assert.equal(rows[0][1], 'Not started (deferred)');
  assert.equal(rows[2][1], 'gpt-6.1-sol:high');
  const done = factsOf(normalizeRun(runRaw({ status: 'Finished', recordStatus: 'ok', isNotStarted: false, endedAt: NOW, verdict: 'PASS', tokens: 4200, reason: null })), clock).map((r) => r[0]);
  assert.deepEqual(done, ['Status', 'Started', 'Ended', 'Model', 'Description', 'Verdict', 'Tokens']);
});
