// node --test web/builtin/agents-info/title-of.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { clipTitle, idHint, plainTitle, retitle, titleOf } from './title-of.mjs';

test('plainTitle drops the leading ticket id, the model suffix and capitalises', () => {
  assert.equal(plainTitle('T63 · Redesign agent avatars (sonnet/high)'), 'Redesign agent avatars');
  assert.equal(plainTitle('t61: fix transcript lookup'), 'Fix transcript lookup');
  assert.equal(plainTitle('T61 - /panel watch folder'), '/panel watch folder');
  assert.equal(plainTitle('Fix lanes (haiku/low) (x)'), 'Fix lanes (haiku/low) (x)');
  assert.equal(plainTitle('Worker 01-slugify'), 'Worker slugify');
  assert.equal(plainTitle('03-ui'), 'Ui');
  assert.equal(plainTitle(undefined), '');
});

test('clipTitle cuts at a word with an ellipsis', () => {
  assert.equal(clipTitle('Short title'), 'Short title');
  const c = clipTitle('Redesign the agent avatars and their labels');
  assert.ok(c.length <= 28 && c.endsWith('…') && !c.includes('labels'), c);
  assert.equal(clipTitle('Supercalifragilisticexpialidocious_longword', 12).length, 12);
});

test('titleOf: ticket title first, then the label, then the role; never an id', () => {
  assert.equal(titleOf({ name: 'T64 Avatar rework', ticket: null, role: null }), 'Avatar rework');
  assert.equal(titleOf({ name: 'Worker 01-slugify', role: 'worker', ticket: { id: '01-slugify', stage: 'verified', text: 'verified 4/4' } }), 'Worker');
  assert.equal(titleOf({ name: 'Worker 01-slugify', role: 'worker', ticket: { id: '01-slugify', title: 'Slugify text', stage: 'x', text: '' } }), 'Slugify text');
  assert.equal(titleOf({ name: 'Verifier 02-is-palindrome', role: 'verifier', ticket: { id: '02-is-palindrome', stage: 'x', text: '' } }), 'Verifier');
  assert.equal(titleOf({ name: 'T9', role: null, ticket: null }), 'Agent');
  assert.equal(titleOf({ isMain: true, name: 'Me' }), 'This session');
  assert.equal(titleOf({ isMain: true, name: 'Me', title: 'T83 · Add search box to notes list' }), 'Add search box to notes list');
});

test('titleOf: an unnamed agent gets its role or its kind of work, not "Agent 1348"', () => {
  assert.equal(titleOf({ name: 'Agent 1348', role: null, kind: 'visual', kindLabel: 'Visual' }), 'Visual agent');
  assert.equal(titleOf({ name: 'Agent 4d20', role: 'verifier', kind: 'tests', kindLabel: 'Tests' }), 'Verifier');
  assert.equal(titleOf({ name: 'Agent 1348', role: null, kind: null, kindLabel: 'Working' }), 'Agent');
});

test('idHint uses the human title for a tooltip', () => {
  assert.equal(idHint({ name: 'T43 Note search', ticket: null }), 'Note search');
  assert.equal(idHint({ name: 'x', ticket: { id: '01-a' } }), 'X');
});

test('retitle swaps ids in sentences for titles and drops unknown ids', () => {
  const agents = [{ name: 'T43 Note search', short: 'T43', ticket: null, role: null }, { name: 'T40 Empty-note export', short: 'T40', ticket: null, role: null }];
  assert.equal(retitle('T43 testing', agents), 'Note search testing');
  assert.equal(retitle('Delegating: T43, T40, T99', agents), 'Delegating: Note search, Empty-note export');
  assert.doesNotMatch(retitle('main -> T40', agents), /T\d/);
});
