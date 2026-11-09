import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FX, captionOf, fxKindOf, recentFor } from './event-fx.mjs';

const agent = (o = {}) => ({ id: 't9', name: 'T9 · Fix transcript lookup (sonnet/high)', short: 'T9', role: 'worker', isMain: false, state: 'working', kind: 'logic', kindLabel: 'Logic', ticket: null, ...o });
const ev = (o) => ({ id: 1, t: 0, agent: 't9', from: '', to: '', kind: 'state', text: '', ...o });

test('every animation kind an event can pick is defined', () => {
  for (const e of [ev({ kind: 'spawn' }), ev({ kind: 'handoff' }), ev({ kind: 'work' }), ev({ to: 'done' }), ev({ to: 'blocked' }), ev({ to: 'testing' }), ev({ to: 'failed' })]) assert.ok(FX[fxKindOf(e, agent())], e.kind + e.to);
  assert.equal(fxKindOf(ev({ kind: 'progress' }), agent()), null);
});

test('a state change plays by what the agent became; a failed ticket is an error', () => {
  assert.equal(fxKindOf(ev({ to: 'done' }), agent({ state: 'done' })), 'done');
  assert.equal(fxKindOf(ev({ to: 'blocked' }), agent()), 'blocked');
  assert.equal(fxKindOf(ev({ to: 'testing' }), agent()), 'change');
  assert.equal(fxKindOf(ev({ to: 'done' }), agent({ state: 'done', ticket: { id: 'x', stage: 'failed', text: '', title: '' } })), 'error');
  assert.equal(fxKindOf(ev({ to: 'failed' }), null), 'error');
});

test('captions name the task by its title, never by id', () => {
  const rows = [agent()];
  assert.equal(captionOf(ev({ to: 'done' }), rows), 'Fix transcript lookup: done');
  assert.equal(captionOf(ev({ kind: 'handoff', from: 'main', to: 't9' }), rows), 'Fix transcript lookup: started');
  assert.equal(captionOf(ev({ kind: 'spawn' }), rows), 'Fix transcript lookup: created');
  assert.equal(captionOf(ev({ to: 'blocked' }), rows), 'Fix transcript lookup: blocked');
  assert.equal(captionOf(ev({ kind: 'progress', to: '40' }), rows), 'Fix transcript lookup: 40%');
  assert.equal(captionOf(ev({ kind: 'work', text: 'T9 · Tests' }), rows), 'Fix transcript lookup: tests');
  assert.equal(captionOf(ev({ agent: 'gone', to: 'done' }), rows), 'Agent: done');
  for (const c of [captionOf(ev({ to: 'failed' }), rows)]) assert.doesNotMatch(c, /\bT\d+\b/);
  assert.equal(captionOf(ev({ to: 'done' }), [agent({ ticket: { id: 'x', stage: 'failed', text: '', title: '' } })]), 'Fix transcript lookup: failed');
});

test('recentFor keeps the newest events of one agent', () => {
  const list = [ev({ id: 1 }), ev({ id: 5 }), ev({ id: 3, agent: 'other' }), ev({ id: 4 }), ev({ id: 2 }), ev({ id: 6 })];
  assert.deepEqual(recentFor(list, 't9').map((e) => e.id), [6, 5, 4]);
  assert.deepEqual(recentFor(list, 't9', 1).map((e) => e.id), [6]);
});
