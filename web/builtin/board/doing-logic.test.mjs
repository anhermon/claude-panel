// doing-logic.test.mjs - the rows of the "doing" frame and the swimlane's data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { doingRows, laneDuration, legendKinds, normalizeSwimlane, share } from './doing-logic.mjs';

const insight = (o = {}) => ({ kind: 'logic', headline: 'Writing logic', files: ['a.ts', 'b.ts', 'c.ts'], lastCallAt: 1000, isBusy: true, isMain: false, ...o });
const lane = (id, state, ins) => ({ id, label: `Agent ${id}`, state, insight: ins });

test('doingRows: running agents first, rows without insight dropped, at most two files', () => {
  const rows = doingRows([lane('a', 'done', insight({ kind: 'done' })), lane('b', 'working', insight()), { id: 'x', label: 'x', state: 'working' }, lane('c', 'testing', insight({ kind: 'tests' }))], 2000);
  assert.deepEqual(rows.map((r) => r.id), ['b', 'c', 'a']);
  assert.deepEqual(rows[0].files, ['a.ts', 'b.ts']);
  assert.equal(rows[2].running, false);
});

test('doingRows: a stale kind of work reads as thinking', () => {
  const rows = doingRows([lane('a', 'working', insight({ isBusy: false, lastCallAt: 1000 }))], 1000 + 60_000);
  assert.equal(rows[0].kind, 'thinking');
});

test('doingRows survives junk', () => {
  assert.deepEqual(doingRows(null, 0), []);
  assert.deepEqual(doingRows([null, 3, { insight: 4 }], 0), []);
});

test('legendKinds lists only the kinds present, in the fixed order', () => {
  assert.deepEqual(legendKinds([{ kind: 'tests' }, { kind: 'ui' }, { kind: 'tests' }]), ['ui', 'tests']);
  assert.deepEqual(legendKinds([]), []);
});

test('normalizeSwimlane: unknown kinds and empty segments go, the lane ends at its last segment, kinds are collected in order', () => {
  const s = normalizeSwimlane({ items: [{ label: 'main', state: 'working', from: 0, to: 100, segs: [{ k: 'tests', a: 0, b: 10 }, { k: 'nope', a: 10, b: 20 }, { k: 'ui', a: 20, b: 20 }, { k: 'ui', a: 30, b: 130 }] }, { label: 'x', state: '?', from: 5, to: 4, segs: 'bad' }] });
  assert.equal(s.items[0].segs.length, 2);
  assert.equal(s.items[0].to, 130);
  assert.equal(s.items[1].state, 'done');
  assert.equal(s.items[1].to, 5);
  assert.equal(s.end, 130);
  assert.deepEqual(s.kinds, ['ui', 'tests']);
  assert.deepEqual(normalizeSwimlane({}), { items: [], end: 1, kinds: [] });
});

test('laneDuration and share', () => {
  assert.equal(laneDuration({ from: 10, to: 10 + 26 * 60 + 4 }), '26 min 4 s');
  assert.equal(share(50, 100), 0.5);
  assert.equal(share(500, 100), 1);
});
