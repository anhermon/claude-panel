// narrow-plan.test.mjs - a half-width board: one column, agents first, lowest priority dropped into "+N more".
import test from 'node:test';
import assert from 'node:assert/strict';
import { NARROW_MAX_PX, narrowNeedPx, planGrid } from './grid-plan.mjs';

const lanes = (n) => ({ id: 'lanes', type: 'lanes', lanes: Array.from({ length: n }, (_, i) => ({ id: `l${i}` })) });
const frames = [
  lanes(3),
  { id: 'flow', type: 'diagram', nodes: [], edges: [] },
  { id: 'now', type: 'now', text: 'x' },
  { id: 'steps', type: 'steps', items: [1, 2, 3, 4] },
  { id: 'bars', type: 'bars', items: [1, 2, 3] },
];
const NARROW = { aspect: 0.49, width: 360, height: 600 };

test('narrow board: one column, rows weighted by need, nothing placed twice', () => {
  const plan = planGrid(frames, NARROW);
  assert.equal(plan.cols, 1);
  assert.equal(plan.rows, plan.cells.length);
  assert.equal(plan.weights.length, plan.cells.length);
  assert.deepEqual(plan.cells.map((c) => c.row), plan.cells.map((_, i) => i));
});

test('narrow board: lanes stay, low-priority frames are dropped and counted', () => {
  const plan = planGrid(frames, NARROW);
  const ids = plan.cells.map((c) => c.id);
  assert.ok(ids.includes('lanes') && ids.includes('now'));
  assert.ok(!ids.includes('bars'));
  assert.equal(plan.hidden, frames.length - plan.cells.length);
  assert.deepEqual(ids, frames.map((f) => f.id).filter((id) => ids.includes(id)), 'kept frames keep their order');
});

test('narrow board: total need of what is shown fits the height; a tall board shows everything', () => {
  const tall = planGrid(frames, { ...NARROW, height: 2000 });
  assert.equal(tall.cells.length, frames.length);
  assert.equal(tall.hidden, 0);
  const plan = planGrid(frames, NARROW);
  assert.ok(plan.weights.reduce((a, b) => a + b, 0) <= NARROW.height);
});

test('a huge lanes frame is still shown on a tiny board; wide boards use the normal planner', () => {
  assert.equal(planGrid([lanes(6)], { aspect: 0.3, width: 300, height: 200 }).cells.length, 1);
  assert.equal(planGrid(frames, { aspect: 0.49, width: NARROW_MAX_PX + 1, height: 730 }).narrow, undefined);
});

test('narrowNeedPx: a long heading costs a second line', () => {
  assert.ok(narrowNeedPx({ type: 'now', title: 'PANE HOLDS SEVERAL MAIN FRAMES' }) > narrowNeedPx({ type: 'now', title: 'Short' }));
});
