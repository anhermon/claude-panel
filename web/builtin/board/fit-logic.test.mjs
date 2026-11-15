import assert from 'node:assert/strict';
import test from 'node:test';
import { headlineFloorTimes } from './fit-logic.mjs';

test('a one-sentence headline keeps its readable floor; several lines may shrink to the body floor so they fit whole', () => {
  assert.equal(headlineFloorTimes(1), 1.5);
  assert.equal(headlineFloorTimes(0), 1.5);
  assert.equal(headlineFloorTimes(2), 1);
  assert.equal(headlineFloorTimes(8), 1);
});
