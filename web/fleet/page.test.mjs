import test from 'node:test';
import assert from 'node:assert/strict';
import { age, ago, bytes, count, duration, modelName, pct } from './page/format.js';
import { filterSessions, groupSessions, sortSessions, titleOf, topEntries } from './page/model.js';

test('formatters give short phrases with units', () => {
  assert.equal(age(500), 'just now');
  assert.equal(ago(12_000), '12 s ago');
  assert.equal(ago(5 * 60_000), '5 min ago');
  assert.equal(ago(3 * 3_600_000), '3 h ago');
  assert.equal(ago(null), 'unknown');
  assert.equal(duration(33_000), '33 s');
  assert.equal(duration(125_000), '2 min 5 s');
  assert.equal(duration(3_780_000), '1 h 3 min');
  assert.equal(count(950), '950');
  assert.equal(count(12_345), '12k');
  assert.equal(count(1_234), '1.2k');
  assert.equal(count(3_400_000), '3.4M');
  assert.equal(bytes(52_812_794), '52.8 MB');
  assert.equal(modelName('claude-sonnet-5-5'), 'sonnet 5.5');
  assert.equal(modelName('claude-opus-4-20250514'), 'opus 4');
  assert.equal(modelName(null), 'unknown model');
  assert.equal(pct(1, 3), 33.3);
  assert.equal(pct(1, 0), 0);
});

const S = (over) => ({ id: 'a'.repeat(8) + '-0000', title: null, name: null, project: 'p', cwd: '~/p', model: 'm', lastPrompt: null, entrypoint: 'cli', branch: null, currentTool: null, pid: null, group: 'idle', lastWriteAt: 1, tokens: { out: 0 }, tools: { total: 0 }, errors: 0, ...over });

test('filter needs every word; sort keeps recency as the tie-break; groups are ordered and non-empty', () => {
  const list = [S({ id: 'x1', title: 'Fix login', group: 'running', lastWriteAt: 5, errors: 2 }), S({ id: 'x2', title: 'Write docs', group: 'earlier', lastWriteAt: 9, errors: 2 }), S({ id: 'x3', project: 'login-svc', group: 'idle', lastWriteAt: 7 })];
  assert.deepEqual(filterSessions(list, 'login').map((s) => s.id), ['x1', 'x3']);
  assert.deepEqual(filterSessions(list, 'LOGIN fix').map((s) => s.id), ['x1']);
  assert.equal(filterSessions(list, '   ').length, 3);
  assert.deepEqual(sortSessions(list, 'errors').map((s) => s.id), ['x2', 'x1', 'x3']);
  assert.deepEqual(sortSessions(list, 'activity').map((s) => s.id), ['x2', 'x3', 'x1']);
  assert.deepEqual(groupSessions(list).map((g) => g.group), ['running', 'idle', 'earlier']);
  assert.deepEqual(groupSessions([list[0]]).map((g) => g.group), ['running']);
});

test('topEntries folds the tail; titleOf falls back', () => {
  assert.deepEqual(topEntries({ a: 5, b: 3, c: 1, d: 1 }, 2), [{ name: 'a', count: 5 }, { name: 'b', count: 3 }, { name: 'other', count: 2 }]);
  assert.equal(titleOf({ id: 'abcdef012345', title: null, name: null, project: null }), 'abcdef01');
});
