// The row the Agents tile opens for a card of the board's "Other sessions" frame: built from the page's own message, never trusted blind.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sessionRowOf } from './session-row.mjs';

const ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

test('a session message becomes a row the detail view can head: name, state word, not the main session, no role or ticket', () => {
  const row = sessionRowOf({ id: ID, title: 'Fix login', state: 'waiting' });
  assert.deepEqual([row.id, row.loop, row.name, row.state, row.isMain, row.role, row.ticket], [ID, ID, 'Fix login', 'waiting', false, null, null]);
  assert.equal(sessionRowOf({ id: ID, title: 'x', state: 'busy' }).state, 'working');
  assert.equal(sessionRowOf({ id: ID, title: 'x', state: 'idle' }).state, 'done');
});

test('no title falls back to the id start; a bad id, a missing message or an unknown state is no row (state falls back to working only when absent)', () => {
  assert.equal(sessionRowOf({ id: ID }).name, 'aaaaaaaa');
  assert.equal(sessionRowOf({ id: ID }).state, 'working');
  assert.equal(sessionRowOf({ id: ID, title: 'x'.repeat(200) }).name.length, 70);
  for (const bad of [null, undefined, 5, {}, { id: '../x' }, { id: 5 }, { id: 'x'.repeat(65) }]) assert.equal(sessionRowOf(bad), null, JSON.stringify(bad));
});
