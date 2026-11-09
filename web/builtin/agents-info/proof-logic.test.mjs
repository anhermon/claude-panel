import assert from 'node:assert/strict';
import { test } from 'node:test';

import { normalizeData } from './agents-info-logic.mjs';
import { CHIP_NO_EVAL, CHIP_NOT_PASSED, isUnproven, normalizeProof, proofView } from './proof-logic.mjs';

const agent = (proof, state = 'done') => ({ id: 'a', state, proof });

test('normalizeProof keeps a well-formed proof and drops junk (a non-ticket agent has none)', () => {
  assert.deepEqual(normalizeProof({ eval: ' run the  tests ', what: 'run the tests', result: 'pass' }), { eval: 'run the tests', what: 'run the tests', result: 'pass' });
  for (const bad of [null, undefined, 'x', [], {}, { result: 'maybe' }, { eval: 'x', result: 7 }]) assert.equal(normalizeProof(bad), null);
  assert.equal(normalizeProof({ eval: 'x'.repeat(500), what: 'y'.repeat(500), result: 'fail' }).what.length, 60);
});

test('a finished ticket agent with a passing eval shows the proof line and no chip', () => {
  const v = proofView(agent({ eval: 'run all tests', what: 'run all tests', result: 'pass' }));
  assert.equal(v.line, 'Eval passed: run all tests');
  assert.equal(v.chip, '');
  assert.equal(v.tone, 'ok');
  assert.equal(isUnproven(agent({ eval: 'e', what: 'e', result: 'pass' })), false);
});

test('a finished ticket agent with no Eval line shows "no eval"; a PASS cannot prove a missing eval', () => {
  const v = proofView(agent({ eval: '', what: '', result: 'none' }));
  assert.deepEqual([v.chip, v.line, v.tone], [CHIP_NO_EVAL, '', 'warn']);
  assert.equal(proofView(agent({ eval: '', what: '', result: 'pass' })).chip, CHIP_NO_EVAL);
});

test('an eval without a stated PASS is "eval not passed": danger for FAIL, warn when nothing was said', () => {
  assert.deepEqual([proofView(agent({ eval: 'e', what: 'e', result: 'fail' })).chip, proofView(agent({ eval: 'e', what: 'e', result: 'fail' })).tone], [CHIP_NOT_PASSED, 'danger']);
  assert.deepEqual([proofView(agent({ eval: 'e', what: 'e', result: 'none' })).chip, proofView(agent({ eval: 'e', what: 'e', result: 'none' })).tone], [CHIP_NOT_PASSED, 'warn']);
});

test('an agent that is not a ticket (proof null or missing) and a running agent are never flagged', () => {
  assert.equal(proofView(agent(null)), null);
  assert.equal(proofView({ id: 'a', state: 'done' }), null);
  assert.equal(proofView(agent({ eval: '', what: '', result: 'none' }, 'working')), null);
  assert.equal(isUnproven(agent(null)), false);
});

test('normalizeData carries the proof through; a missing one is null', () => {
  const raw = { id: 'a', state: 'done', name: 'A' };
  const d = normalizeData({ agents: [{ ...raw, proof: { eval: 'e', what: 'e', result: 'pass' } }, { ...raw, id: 'b' }] });
  assert.equal(d.agents[0].proof.result, 'pass');
  assert.equal(d.agents[1].proof, null);
});
