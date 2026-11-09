// lane-logic.test.mjs - the agent rows' pure logic: wording (lane-format), fitting (fit-logic), lane normalising.
import test from 'node:test';
import assert from 'node:assert/strict';
import { callsLabel, elapsedMs, formatElapsed, lanePct, laneTitle } from './lane-format.mjs';
import { ceilFont, fitFont, spreadGap } from './fit-logic.mjs';
import { LANE_ORDER, isCallsBars, moreCount, normalizeData, sortLanes } from './board-logic.mjs';

test('formatElapsed: seconds, minutes, hours, days; junk -> null', () => {
  assert.equal(formatElapsed(20_000), '<1 min');
  assert.equal(formatElapsed(3 * 60_000 + 5_000), '3 min');
  assert.equal(formatElapsed(125 * 60_000), '2 h 05 min');
  assert.equal(formatElapsed(26 * 3_600_000), '1 d 2 h');
  for (const bad of [-1, NaN, undefined, '5']) assert.equal(formatElapsed(bad), null);
});

test('elapsedMs: running counts up to now, done freezes at its last update, no start -> null', () => {
  assert.equal(elapsedMs({ state: 'working', startedAt: 1000, updatedAt: 5000 }, 61_000), 60_000);
  assert.equal(elapsedMs({ state: 'done', startedAt: 1000, updatedAt: 5000 }, 61_000), 4000);
  assert.equal(elapsedMs({ state: 'working', startedAt: 0, updatedAt: 0 }, 61_000), null);
  assert.equal(elapsedMs({ state: 'done', startedAt: 1000, updatedAt: 0 }, 61_000), null);
});

test('callsLabel, laneTitle, lanePct', () => {
  assert.equal(callsLabel(12), '12 calls');
  assert.equal(callsLabel(1), '1 call');
  assert.equal(callsLabel(undefined), '');
  assert.equal(callsLabel(-3), '');
  assert.equal(laneTitle({ goal: 'Fix the board', label: 'T34' }), 'Fix the board');
  assert.equal(laneTitle({ goal: '', label: 'T34' }), 'T34');
  assert.equal(lanePct({ pct: 40, dod: [] }), 40);
  assert.equal(lanePct({ pct: null, dod: [{ state: 'done' }, { state: 'todo' }, { state: 'doing' }, { state: 'done' }] }), 50);
  assert.equal(lanePct({ pct: null, dod: [] }), null);
});

test('sortLanes keeps goal, checklist, calls and times; order working, testing, blocked, waiting, done', () => {
  assert.deepEqual(LANE_ORDER, ['working', 'testing', 'blocked', 'waiting', 'done']);
  const out = sortLanes([
    { id: 'd', state: 'done' }, { id: 'w', state: 'waiting' }, { id: 'b', state: 'blocked' }, { id: 't', state: 'testing' },
    { id: 'a', state: 'working', label: 'L'.repeat(200), goal: 'G', dod: [{ t: 'x', state: 'done' }, { t: 'y', state: 'weird' }, 5], at: 1, calls: 12, startedAt: 10, updatedAt: 20 },
  ]);
  assert.deepEqual(out.map((l) => l.id), ['a', 't', 'b', 'w', 'd']);
  const a = out[0];
  assert.equal(a.goal, 'G');
  assert.deepEqual(a.dod, [{ t: 'x', state: 'done' }, { t: 'y', state: 'todo' }]);
  assert.equal(a.at, 1);
  assert.equal(a.calls, 12);
  assert.equal(a.startedAt, 10);
  assert.ok(a.label.length <= 80);
  assert.equal(out[1].calls, undefined);
  assert.equal(sortLanes([{ id: 'a', at: 9, dod: [{ t: 'x' }] }])[0].at, null, 'at must index into dod');
  assert.equal(sortLanes([{ id: 'a', calls: 1.5 }])[0].calls, undefined);
});

test('normalizeData: a lanes frame carries the new lane fields', () => {
  const d = normalizeData({ lanes: [{ id: 'a', label: 'A', state: 'working', calls: 3, goal: 'g' }], frames: [{ id: 'l', type: 'lanes' }] });
  assert.equal(d.frames[0].lanes[0].calls, 3);
  assert.equal(d.frames[0].lanes[0].goal, 'g');
});

test('fitFont: the largest size that fits, the floor when nothing does, fractional floors kept', () => {
  assert.equal(fitFont({ floor: 14, ceil: 40, fits: (px) => px <= 26 }), 26);
  assert.equal(fitFont({ floor: 14, ceil: 40, fits: () => true }), 40);
  assert.equal(fitFont({ floor: 14, ceil: 40, fits: () => false }), 14);
  assert.equal(fitFont({ floor: 16.79, ceil: 40, fits: () => false }), 16.79);
  assert.equal(fitFont({ floor: 14, ceil: 10, fits: (px) => px <= 14 }), 14, 'ceil below floor never goes under the floor');
  let calls = 0;
  fitFont({ floor: 10, ceil: 1000, fits: (px) => { calls++; return px <= 500; } });
  assert.ok(calls <= 12, 'binary search, not a scan');
});

test('spreadGap and ceilFont', () => {
  assert.equal(spreadGap({ spare: 90, n: 4, maxGap: 100 }), 30);
  assert.equal(spreadGap({ spare: 900, n: 4, maxGap: 20 }), 20);
  assert.equal(spreadGap({ spare: -5, n: 4, maxGap: 20 }), 0);
  assert.equal(spreadGap({ spare: 50, n: 1, maxGap: 20 }), 0);
  assert.equal(ceilFont({ width: 1000, share: 0.05, floor: 14, maxTimes: 3 }), 42);
  assert.equal(ceilFont({ width: 200, share: 0.05, floor: 14, maxTimes: 3 }), 14);
  assert.equal(ceilFont({ width: 9000, share: 0.05, floor: 14, maxTimes: 3 }), 42);
});

test('moreCount ignores redundant hidden frames; isCallsBars spots the mod\'s calls frame', () => {
  assert.equal(moreCount({ total: 5, targeted: 5, mounted: 5, placed: 4, redundant: 1 }), 0);
  assert.equal(moreCount({ total: 6, targeted: 6, mounted: 6, placed: 4, redundant: 1 }), 1);
  assert.equal(isCallsBars({ type: 'bars', unit: 'calls' }), true);
  assert.equal(isCallsBars({ type: 'bars', unit: 'ms' }), false);
  assert.equal(isCallsBars({ type: 'text', unit: 'calls' }), false);
});
