import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseControlLine } from './live.mjs';
import { SCROLL_COUNT_MAX, SCROLL_EDGE_PX, SCROLL_PAGE_FRACTION, SCROLL_STEP_PX, parseScroll, wheelDeltas } from './scroll-math.mjs';

test('wheelDeltas: steps and pages add up, a page is a share of the tile, an edge goes first', () => {
  assert.deepEqual(wheelDeltas({ steps: 1 }, 800), [SCROLL_STEP_PX]);
  assert.deepEqual(wheelDeltas({ steps: -2 }, 800), [-2 * SCROLL_STEP_PX]);
  assert.deepEqual(wheelDeltas({ pages: 1 }, 800), [Math.round(800 * SCROLL_PAGE_FRACTION)]);
  assert.deepEqual(wheelDeltas({ steps: 1, pages: -1 }, 1000), [SCROLL_STEP_PX - Math.round(1000 * SCROLL_PAGE_FRACTION)]);
  assert.deepEqual(wheelDeltas({ edge: 'top', steps: 2 }, 800), [-SCROLL_EDGE_PX, 2 * SCROLL_STEP_PX]);
  assert.deepEqual(wheelDeltas({ edge: 'bottom' }, 800), [SCROLL_EDGE_PX]);
  assert.deepEqual(wheelDeltas({ steps: 1, pages: -1 }, 0), [SCROLL_STEP_PX], 'a tile of no height has no page');
  assert.deepEqual(wheelDeltas({}, 800), []);
});

test('parseScroll: whole counts in range, a known edge, and something to move', () => {
  assert.deepEqual(parseScroll({ steps: 3 }), { cmd: 'scroll', steps: 3, pages: 0 });
  assert.deepEqual(parseScroll({ edge: 'top' }), { cmd: 'scroll', edge: 'top', steps: 0, pages: 0 });
  for (const bad of [{}, { steps: 0 }, { steps: 1.5 }, { steps: '1' }, { pages: SCROLL_COUNT_MAX + 1 }, { edge: 'middle' }]) {
    assert.equal(parseScroll(bad), null, JSON.stringify(bad));
  }
});

test('live.mjs control lines: scroll is accepted, normalised, and refused when malformed', () => {
  assert.deepEqual(parseControlLine('{"cmd":"scroll","steps":2,"pages":-1}'), { cmd: 'scroll', steps: 2, pages: -1 });
  assert.deepEqual(parseControlLine('{"cmd":"scroll","edge":"bottom"}'), { cmd: 'scroll', edge: 'bottom', steps: 0, pages: 0 });
  assert.equal(parseControlLine('{"cmd":"scroll"}'), null);
  assert.equal(parseControlLine('{"cmd":"scroll","steps":1e9}'), null);
});
