// list-plan.test.mjs - the list frames (agent rows, doing, swimlane) are sized by what their rows need: the narrow estimate,
// the scroll grid, and "a cell too short for even the tightest wording counts as hidden" (so the board scrolls, never clips a row).
import test from 'node:test';
import assert from 'node:assert/strict';
import { TEXT_FLOOR_MIN_PX, floorPx, listBodyPx, minSizeFor, narrowNeedPx, planGrid } from './grid-plan.mjs';
import { chooseMode, planScroll } from './scroll-logic.mjs';

const row = (i, insight = true) => ({ id: `a${i}`, label: `Agent ${i}`, ...(insight ? { insight: { kind: 'ui' } } : {}) });
const lanes = (n, insight = true) => ({ id: 'lanes', type: 'lanes', lanes: Array.from({ length: n }, (_, i) => row(i, insight)) });
const doing = (n) => ({ id: 'now-doing', type: 'doing', lanes: Array.from({ length: n }, (_, i) => row(i)) });
const swimlane = (n) => ({ id: 'activity-timeline', type: 'swimlane', items: Array.from({ length: n }, () => ({ label: 'x', segs: [] })) });
const now = { id: 'now', type: 'now', text: 'x' };

test('floorPx follows board.css: 14 px at least, 1.46 vu above it', () => {
  assert.equal(floorPx(360, 730), TEXT_FLOOR_MIN_PX);
  assert.equal(floorPx(0, 0), TEXT_FLOOR_MIN_PX);
  assert.ok(Math.abs(floorPx(1280, 900) - 18.7) < 0.1);
});

test('listBodyPx: the compact wording is shorter than the roomy one, a bigger text floor needs more px, plain rows keep their size', () => {
  for (const frame of [lanes(4), doing(4), swimlane(4)]) assert.ok(listBodyPx(frame, { compact: true }) < listBodyPx(frame), frame.type);
  assert.ok(listBodyPx(lanes(3, false)) >= 3 * 110, 'plain rows keep their 110 px each');
  assert.ok(listBodyPx(lanes(3, true), { floor: 28 }) > listBodyPx(lanes(3, true)), 'a bigger text floor needs more px');
  assert.ok(listBodyPx(doing(20)) === listBodyPx(doing(8)), 'the doing frame lists at most 8 agents');
});

test('narrowNeedPx counts doing and swimlane rows, and agent rows with an insight need more than the old fixed 110', () => {
  assert.ok(narrowNeedPx(doing(6)) > narrowNeedPx(doing(2)));
  assert.ok(narrowNeedPx(swimlane(6)) > narrowNeedPx(swimlane(2)));
  assert.ok(narrowNeedPx(lanes(1)) < narrowNeedPx(lanes(5)));
});

test('minSizeFor: doing and swimlane grow with their rows', () => {
  assert.equal(minSizeFor(doing(3), 'portrait'), 's');
  assert.equal(minSizeFor(doing(6), 'landscape'), 's');
  assert.equal(minSizeFor(doing(6), 'square'), 'm');
  assert.equal(minSizeFor(swimlane(2), 'square'), 's');
  assert.equal(minSizeFor(swimlane(4), 'landscape'), 'm');
  assert.equal(minSizeFor(swimlane(6), 'landscape'), 'l');
});

test('a six-agent board does not fit 720x730: the planner reports it and the board scrolls; 1280x900 fits the same four frames in compact wording', () => {
  const frames = [now, doing(6), lanes(6), swimlane(6)];
  const small = planGrid(frames, { width: 720, height: 730, aspect: 720 / 730 });
  assert.ok(small.hidden > 0);
  assert.equal(chooseMode(small), 'scroll');
  assert.equal(planGrid(frames, { width: 1280, height: 900, aspect: 1280 / 900 }).hidden, 0);
});

test('a short list of agents fits a tall board without scrolling (the rows are not counted as clipped)', () => {
  const plan = planGrid([now, doing(2), lanes(2)], { width: 1280, height: 900, aspect: 1280 / 900 });
  assert.equal(plan.hidden, 0);
});

test('the scroll grid gives a list frame as many rows as its roomy wording needs; other frames keep their size', () => {
  const view = { width: 1280, height: 900, aspect: 1280 / 900 };
  const plan = planScroll([now, lanes(6), swimlane(6)], view);
  const cell = (id) => plan.cells.find((c) => c.id === id);
  assert.ok(cell('lanes').h * plan.rowPx >= 46 + listBodyPx(lanes(6), { floor: floorPx(1280, 900) }));
  assert.ok(cell('activity-timeline').h * plan.rowPx >= 46 + listBodyPx(swimlane(6), { floor: floorPx(1280, 900) }));
  assert.equal(cell('now').h, 1);
});

test('on a narrow board the scroll px of agent rows is the roomy estimate', () => {
  const plan = planScroll([lanes(6)], { width: 360, height: 730, aspect: 0.49 });
  assert.ok(plan.cells[0].px >= narrowNeedPx(lanes(6)));
});
