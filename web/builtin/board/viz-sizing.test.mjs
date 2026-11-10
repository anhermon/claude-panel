import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { planGrid } from './grid-plan.mjs';
import { chooseMode, MODE_FIT, MODE_SCROLL, planScroll } from './scroll-logic.mjs';
import { sizeVizPlan } from './viz-sizing.mjs';

const PHONE = { width: 360, height: 730, aspect: 360 / 730 };
const WIDE = { width: 1280, height: 730, aspect: 1280 / 730 };
const GAP_PX = 10;
const TALL_PX = 980;
const SHORT_PX = 120;
const SMALL_VIEW_PX = 20;
const GRID_COLUMNS = 2;
const GRID_ROWS = 3;
const HINTS = ['s', 'm', 'l', 'xl'];
const KINDS = ['limits', 'sources'];
const viz = (size, kind) => ({ id: kind, type: 'viz', size, kind });
const measured = (plan, heights, view) => sizeVizPlan(plan, heights, { height: view.height, gap: GAP_PX });

test('every viz kind and size hint switches to scroll if its measured content exceeds a single fit tile', () => {
  for (const view of [PHONE, WIDE]) for (const kind of KINDS) for (const size of HINTS) {
    const frames = [viz(size, kind)];
    const heights = new Map([[kind, TALL_PX]]);
    const fit = measured(planGrid(frames, view), heights, view);
    assert.equal(chooseMode(fit), MODE_SCROLL);
    const scroll = measured(planScroll(frames, view), heights, view);
    const [cell] = scroll.cells;
    assert.ok(view === PHONE ? cell.px >= TALL_PX : cell.h * scroll.rowPx + (cell.h - 1) * GAP_PX >= TALL_PX);
    assert.equal(scroll.hidden, 0);
  }
});

test('fit sizing checks both weighted narrow rows and wide multi-row spans, without mutating the plan', () => {
  const frames = [viz(HINTS[0], KINDS[0]), { id: 'now', type: 'now', text: 'Working' }];
  const narrow = planGrid(frames, PHONE);
  const before = structuredClone(narrow);
  assert.equal(chooseMode(measured(narrow, new Map([[KINDS[0], TALL_PX]]), PHONE)), MODE_SCROLL);
  assert.deepEqual(narrow, before);
  const wide = { cols: GRID_COLUMNS, rows: GRID_ROWS, hidden: 0, cells: [{ id: KINDS[0], row: 0, h: GRID_COLUMNS }] };
  assert.equal(chooseMode(measured(wide, new Map([[KINDS[0], TALL_PX]]), WIDE)), MODE_SCROLL);
  assert.equal(chooseMode(measured(wide, new Map([[KINDS[0], SHORT_PX]]), WIDE)), MODE_FIT);
});

test('short viz content stays in fit mode and missing measurements preserve the original plans', () => {
  for (const view of [PHONE, WIDE]) {
    const frames = [viz(HINTS[0], KINDS[0])];
    const fit = planGrid(frames, view);
    assert.deepEqual(measured(fit, new Map(), view), fit);
    assert.equal(chooseMode(measured(fit, new Map([[KINDS[0], SHORT_PX]]), view)), MODE_FIT);
    const scroll = planScroll(frames, view);
    assert.deepEqual(measured(scroll, new Map(), view), scroll);
    assert.equal(chooseMode(measured(fit, new Map([[KINDS[0], SHORT_PX]]), { ...view, height: SMALL_VIEW_PX })), MODE_SCROLL);
  }
});

test('viz layers can scroll during measurement, and no Limits rule overrides planned tile heights', () => {
  const css = readFileSync(new URL('./board.css', import.meta.url), 'utf8');
  assert.match(css, /\.layer\[data-kind\]\s*\{[^}]*overflow:\s*auto/);
  assert.match(css, /\.layer\[data-kind\] > \.pa:not\(\.pa-fill\)\s*\{[^}]*flex:\s*none/);
  assert.doesNotMatch(css, /data-kind="limits"|height:\s*auto\s*!important/);
});
