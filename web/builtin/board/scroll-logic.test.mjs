// scroll-logic.test.mjs - the board's scroll mode: when it replaces the fit plan, what it lays out, and the scroll bookkeeping.
import test from 'node:test';
import assert from 'node:assert/strict';
import { NARROW_MAX_PX, SHAPES, planGrid } from './grid-plan.mjs';
import {
  END_SLACK_PX, MODE_FIT, MODE_SCROLL, NARROW_HINT_PX, SCROLL_MAX_FRAMES, chooseMode, scrollCols, hasMoreBelow, maxScrollTop, nextScrollTop, planScroll, positionLabel, reachedCount, scrollRowPx,
} from './scroll-logic.mjs';

const metric = (i, size = 's') => ({ id: `m${i}`, type: 'metric', size, value: String(i) });
const many = (n, size) => Array.from({ length: n }, (_, i) => metric(i, size));
const PHONE = { width: 360, height: 730, aspect: 360 / 730 };
const WIDE = { width: 1920, height: 1080, aspect: 1920 / 1080 };
const LIVE_PANE = { width: 720, height: 1280, aspect: 720 / 1280 };

test('chooseMode: scroll exactly when the fit plan had to leave frames out', () => {
  assert.equal(chooseMode(planGrid(many(4), WIDE)), MODE_FIT);
  assert.equal(chooseMode(planGrid(many(SHAPES.landscape.max), WIDE)), MODE_FIT);
  assert.equal(chooseMode(planGrid(many(SHAPES.landscape.max + 1), WIDE)), MODE_SCROLL);
  assert.equal(chooseMode(planGrid(many(12), LIVE_PANE)), MODE_SCROLL, 'more than the portrait cap');
  assert.equal(chooseMode(planGrid(many(14, 'm'), PHONE)), MODE_SCROLL, 'a phone-width board that cannot fit them');
  assert.equal(chooseMode(planGrid([], WIDE)), MODE_FIT);
});

test('planScroll: every frame is placed (none hidden), in order, whatever the count', () => {
  for (const view of [PHONE, LIVE_PANE, WIDE]) {
    const frames = many(SCROLL_MAX_FRAMES + 5);
    const plan = planScroll(frames, view);
    assert.equal(plan.hidden, 0);
    assert.deepEqual(plan.cells.map((c) => c.id), frames.slice(0, SCROLL_MAX_FRAMES).map((f) => f.id));
  }
});

test('planScroll: columns follow the width, sizes map to spans (a wide board is never one narrow column)', () => {
  const frames = [metric(0, 's'), metric(1, 'm'), metric(2, 'l'), metric(3, 'xl')];
  const wide = planScroll(frames, WIDE);
  assert.equal(wide.cols, scrollCols(WIDE.width));
  assert.deepEqual(wide.cells.map((c) => [c.w, c.h]), [[1, 1], [2, 1], [2, 2], [4, 1]]);
  const tallWide = planScroll(frames, { width: 1500, height: 2000, aspect: 0.75 });
  assert.equal(tallWide.cols, 4, 'a tall 1500 px window still gets 4 columns');
  assert.deepEqual(tallWide.cells.map((c) => [c.w, c.h]), [[1, 1], [2, 1], [2, 2], [4, 1]]);
  const pane = planScroll(frames, LIVE_PANE);
  assert.equal(pane.cols, 2);
  assert.deepEqual(pane.cells.map((c) => [c.w, c.h]), [[1, 1], [1, 1], [1, 2], [2, 3]], 'two columns: m and l are half the board, xl a full-width tower');
  assert.ok(wide.cells.every((c) => c.px === 0), 'rows come from the grid, not a px height');
  assert.deepEqual([399, 800, 1100, 1500, 1920, 5000].map(scrollCols), [2, 2, 2, 4, 4, 6]);
});

test('planScroll: a frame is never given less than its minimum (a 5-step list is not squeezed into a small cell)', () => {
  const steps = { id: 's', type: 'steps', size: 's', items: [1, 2, 3, 4, 5] };
  const [cell] = planScroll([steps], LIVE_PANE).cells;
  assert.notEqual(cell.size, 's');
});

test('planScroll on a narrow board: one column, px heights from the need and the size hint', () => {
  assert.ok(PHONE.width <= NARROW_MAX_PX);
  const plan = planScroll([metric(0, 's'), metric(1, 'l'), metric(2, 'xl')], PHONE);
  assert.equal(plan.cols, 1);
  assert.equal(plan.narrow, true);
  const [s, l, xl] = plan.cells;
  assert.ok(s.px > 0 && l.px >= NARROW_HINT_PX.l && xl.px >= NARROW_HINT_PX.xl);
  assert.ok(s.px < l.px && l.px < xl.px, 'a bigger hint is a taller frame');
  const long = planScroll([{ id: 't', type: 'text', size: 's', text: 'x'.repeat(100) }, { id: 'u', type: 'text', size: 's', text: 'x' }], PHONE).cells;
  assert.ok(long[0].px > long[1].px, 'a headline that wraps needs the extra lines');
});

test('scrollRowPx: a row follows the cell width, kept between the bounds', () => {
  assert.ok(scrollRowPx(720, 2) < scrollRowPx(1440, 2));
  assert.equal(scrollRowPx(100, 4), scrollRowPx(1, 4));
  assert.equal(scrollRowPx(100000, 1), scrollRowPx(200000, 1));
});

test('nextScrollTop: a re-render keeps the offset (clamped to the new end); at the top it stays at the top', () => {
  assert.equal(nextScrollTop({ prev: 300, max: 900 }), 300);
  assert.equal(nextScrollTop({ prev: 300, max: 120 }), 120, 'the content got shorter');
  assert.equal(nextScrollTop({ prev: 0, max: 900 }), 0, 'at the top: still at the top, new frames below do not pull the view');
  assert.equal(nextScrollTop({ prev: -5, max: 900 }), 0);
  assert.equal(nextScrollTop({ prev: Number.NaN, max: 900 }), 0);
  assert.equal(nextScrollTop({ prev: 50, max: -10 }), 0);
  assert.equal(maxScrollTop({ scrollHeight: 1000, clientHeight: 700 }), 300);
  assert.equal(maxScrollTop({ scrollHeight: 500, clientHeight: 700 }), 0);
});

test('position cue: frames seen whole over the total, nothing when nothing scrolls; the fade says there is more', () => {
  const bottoms = [100, 220, 340, 460, 580, 700];
  assert.equal(reachedCount({ bottoms, scrollTop: 0, viewHeight: 400 }), 3);
  assert.equal(reachedCount({ bottoms, scrollTop: 300, viewHeight: 400 }), 6, 'everything above the view counts as seen');
  assert.equal(reachedCount({ bottoms: [900], scrollTop: 0, viewHeight: 400 }), 1, 'never 0 of N');
  assert.equal(positionLabel({ reached: 3, total: 8, max: 600 }), '3/8');
  assert.equal(positionLabel({ reached: 9, total: 8, max: 600 }), '8/8');
  assert.equal(positionLabel({ reached: 3, total: 8, max: 0 }), '');
  assert.equal(positionLabel({ reached: 3, total: 8, max: END_SLACK_PX }), '');
  assert.equal(positionLabel({ reached: 0, total: 0, max: 600 }), '');
  assert.equal(hasMoreBelow({ scrollTop: 0, max: 600 }), true);
  assert.equal(hasMoreBelow({ scrollTop: 600, max: 600 }), false);
  assert.equal(hasMoreBelow({ scrollTop: 600 - END_SLACK_PX, max: 600 }), false);
  assert.equal(hasMoreBelow({ scrollTop: 0, max: 0 }), false);
});
