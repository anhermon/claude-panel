import test from 'node:test';
import assert from 'node:assert/strict';
import { identLine, modelEffortOf, splitType, typeOf } from './ident-logic.mjs';
import { normalizeData } from './agents-info-logic.mjs';

const row = (extra) => ({ id: 'a1', state: 'working', ...extra });

test('a namespaced type is shown verbatim, with model:effort next to it', () => {
  const a = normalizeData({ agents: [row({ agentType: 'example-tools:worker', model: 'sonnet', effort: 'high' })] }).agents[0];
  assert.equal(typeOf(a), 'example-tools:worker');
  const parts = splitType(typeOf(a));
  assert.equal(parts.head + parts.tail, 'example-tools:worker'); // shown verbatim, in two spans
  assert.equal(modelEffortOf(a), 'sonnet:high');
  assert.equal(identLine(a), 'example-tools:worker · sonnet:high');
});

test('plain types stay as they are; Explore keeps its capital', () => {
  for (const t of ['general-purpose', 'Explore', 'Plan', 'pstack:poteto-agent']) assert.equal(typeOf(normalizeData({ agents: [row({ agentType: t })] }).agents[0]), t);
});

test('an inherited effort keeps its star; an unknown part is left out, never invented', () => {
  assert.equal(modelEffortOf({ model: 'sonnet', effort: 'high*' }), 'sonnet:high*');
  assert.equal(modelEffortOf({ model: 'haiku', effort: null }), 'haiku');
  assert.equal(modelEffortOf({ model: null, effort: 'high*' }), 'high*');
  assert.equal(modelEffortOf({ model: null, effort: null }), '');
  assert.equal(typeOf({ agentType: null }), '');
  assert.equal(identLine({}), '');
});

test('a type splits into a shrinkable head and a fixed tail that join back to the exact name (middle ellipsis in CSS)', () => {
  for (const t of ['example-tools:worker', 'general-purpose', 'Plan', '']) {
    const { head, tail } = splitType(t);
    assert.equal(head + tail, t);
    assert.ok(tail.length <= 8);
  }
  assert.equal(splitType('example-tools:worker').tail, 's:worker');
  assert.equal(identLine({ agentType: 'example-tools:worker', model: 'sonnet', effort: 'high' }), 'example-tools:worker · sonnet:high');
});
