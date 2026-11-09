// Pure maths of the avatars: node --test web/builtin/agents-info/*.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CARD_MIN_W, MOOD_FIGURE, CREW_MAX_LABELLED, FIGURE_STATES, FIGURE_THEME, MOODS, MOOD_COLORS, FIGURE_PROP, approach, blinkAmount, chipText, crewCells, crewSplit, figurePose, figureState, hash01 } from './avatar-model.mjs';

test('every mood has a color', () => {
  for (const m of MOODS) assert.match(MOOD_COLORS[m], /^#[0-9a-f]{6}$/);
});

test('blinkAmount: open most of the time, shut once per period', () => {
  assert.equal(blinkAmount(1), 0);
  assert.ok(blinkAmount(0.08) > 0.9);
  assert.equal(blinkAmount(4.2 + 1), 0);
});

test('approach: eases toward a target, or jumps', () => {
  assert.equal(approach(0, 10, 0.1, Infinity), 10);
  const a = approach(0, 10, 0.1, 5);
  assert.ok(a > 0 && a < 10);
  assert.equal(approach(10, 10, 0.1, 5), 10);
});


test('hash01 is stable and in [0,1)', () => {
  const h = hash01('abc');
  assert.equal(h, hash01('abc'));
  assert.ok(h >= 0 && h < 1);
});

const agent = (o = {}) => ({ state: 'working', kind: 'logic', pct: null, ticket: null, ...o });

test('figureState: the panel states plus failed (ticket) and thinking (running in no kind of work)', () => {
  assert.equal(figureState(agent()), 'working');
  assert.equal(figureState(agent({ kind: null })), 'thinking');
  assert.equal(figureState(agent({ kind: 'waiting' })), 'thinking');
  assert.equal(figureState(agent({ state: 'testing' })), 'testing');
  assert.equal(figureState(agent({ state: 'blocked' })), 'blocked');
  assert.equal(figureState(agent({ state: 'done', ticket: { id: 'x', stage: 'failed', text: 'failed 1/4' } })), 'failed');
  assert.equal(figureState(agent({ state: 'done' })), 'done');
});

test('every figure state has a theme, a word and a pose; the story shows in eyes and limbs, never in the body colour', () => {
  for (const s of FIGURE_STATES) {
    assert.match(FIGURE_THEME[s].accent, /^#[0-9a-f]{6}$/);
    assert.equal(FIGURE_THEME[s].body, undefined);
    const p = figurePose(s, 0);
    assert.ok(['open', 'squint', 'cross'].includes(p.eyes));
    assert.equal(p.legs.length, 4);
    assert.ok(Number.isFinite(p.lid) && Number.isFinite(p.armL) && Number.isFinite(p.sy));
    assert.ok(s in FIGURE_PROP);
  }
  assert.equal(new Set(FIGURE_STATES.map((s) => FIGURE_THEME[s].word)).size, FIGURE_STATES.length);
  assert.equal(figurePose('working', 0).eyes, 'squint');
  assert.equal(figurePose('thinking', 0).eyes, 'squint');
  assert.equal(figurePose('failed', 0).eyes, 'cross');
  assert.ok(figurePose('failed', 0).armL < 0, 'a failed figure droops');
  assert.ok(figurePose('done', 0).lid > 1, 'a done figure opens its eyes wide');
  assert.ok(figurePose('done', 0).armL > 1, 'and raises its arms');
  assert.ok(figurePose('waiting', 0).lid < 0.5 && figurePose('waiting', 0).dim < 1, 'a waiting figure is sleepy and dim');
  assert.equal(figurePose('working', 0).running, 1);
  assert.equal(figurePose('waiting', 0).running, 0);
});

test('legs step alternately while working, not while thinking', () => {
  const p = figurePose('working', 0.3);
  assert.ok(p.legs.some((l) => l > 0));
  assert.equal(p.legs[0] > 0 && p.legs[1] > 0, false, 'the two pairs alternate');
  assert.ok(figurePose('thinking', 0.3).legs.every((l) => l === 0));
  assert.ok(figurePose('working', 0).legs.every((l) => l === 0));
});

test('figurePose: the still pose has no motion; a live pose moves; a finished one hops once', () => {
  const still = figurePose('working', 0);
  assert.equal(still.bob, 0);
  assert.equal(still.shakeX, 0);
  assert.notEqual(figurePose('working', 0.1).bob, 0);
  assert.ok(figurePose('done', 1, 0.45).lift > 0);
  assert.equal(figurePose('done', 1, 5).lift, 0);
  assert.ok(figurePose('failed', 1, 0.1).shakeX !== 0);
  assert.equal(figurePose('failed', 1, 5).shakeX, 0);
});

test('chipText: the state word, with the percentage while it runs', () => {
  assert.equal(chipText(agent({ pct: 40 })), 'Working · 40%');
  assert.equal(chipText(agent({ state: 'blocked' })), 'Blocked');
  assert.equal(chipText(agent({ state: 'done', pct: 100 })), 'Done');
  assert.equal(chipText(agent({ state: 'testing', pct: 10 })), 'Testing · 10%');
});

test('crewSplit: up to six labelled figures, the rest collapse into one +N chip', () => {
  assert.deepEqual(crewSplit(4, 6), { shown: 4, hidden: 0 });
  assert.deepEqual(crewSplit(6, 9), { shown: 6, hidden: 0 });
  assert.deepEqual(crewSplit(9, 9), { shown: CREW_MAX_LABELLED, hidden: 3 });
  assert.deepEqual(crewSplit(7, 6), { shown: 5, hidden: 2 });
  assert.deepEqual(crewSplit(5, 4), { shown: 3, hidden: 2 });
  assert.deepEqual(crewSplit(0, 4), { shown: 0, hidden: 0 });
  assert.deepEqual(crewSplit(3, 1), { shown: 1, hidden: 2 });
});

test('crewCells: columns by width, rows by height', () => {
  assert.deepEqual(crewCells(336, 330), { cols: 2, cells: 4 });
  assert.deepEqual(crewCells(800, 840), { cols: 3, cells: 9 });
  assert.equal(crewCells(CARD_MIN_W * 2, 300).cols, 2);
  assert.equal(crewCells(50, 100).cols, 1);
});

test('every mood of the team head maps to a figure state', () => {
  for (const m of MOODS) assert.ok(FIGURE_STATES.includes(MOOD_FIGURE[m]), m);
});
