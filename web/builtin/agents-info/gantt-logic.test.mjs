// Pure logic of the agent gantt: node --test web/builtin/agents-info/gantt-logic.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CLOCK_ABOVE_MS, EMPTY_WINDOW_MS, HOUR_WINDOW_MS, LABEL_FIT_PX, MAX_FIT_WINDOW_MS, MIN_BAR_PX, MIN_TICK_PX, MIN_WINDOW_MS, barOf, chevronLabel, endMarkOf, labelSideOf, mixOf, placeBar, segmentsIn, spanOf, ticksOf, tooltipOf, windowOf } from './gantt-logic.mjs';

const MIN = 60_000;
const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 10, 9, 12, 0, 0);
const agent = (over = {}) => ({ id: 'a', isMain: false, state: 'working', startedAt: NOW - 20 * MIN, endedAt: null, kind: 'logic', kindColor: '#34d399', segs: [], ticket: null, ...over });
const main = (over = {}) => agent({ id: 'main', isMain: true, startedAt: NOW - (24 * 60 + 37) * MIN, ...over });
const kinds = { logic: { label: 'Logic', color: '#34d399', glyph: 'l' }, tests: { label: 'Tests', color: '#fbbf24', glyph: 't' } };

test('windowOf fit: starts at the earliest SUBAGENT, so a day-long main session does not shrink them', () => {
  const win = windowOf([main(), agent({ startedAt: NOW - 50 * MIN }), agent({ id: 'b', startedAt: NOW - 10 * MIN })], NOW);
  assert.equal(win.end, NOW);
  assert.ok(win.span >= 50 * MIN && win.span <= 55 * MIN, `span ${win.span / MIN} min`);
  assert.equal(win.mode, 'fit');
});

test('windowOf fit: capped at the named maximum; no subagent: the last 30 minutes; never shorter than the minimum', () => {
  assert.equal(windowOf([main(), agent({ startedAt: NOW - 20 * HOUR })], NOW).span, MAX_FIT_WINDOW_MS);
  assert.equal(windowOf([main()], NOW).span, EMPTY_WINDOW_MS);
  assert.equal(windowOf([], NOW).span, EMPTY_WINDOW_MS);
  assert.ok(windowOf([agent({ startedAt: NOW - 20_000 })], NOW).span >= MIN_WINDOW_MS);
});

test('windowOf: "Last hour" and "Whole session"', () => {
  assert.equal(windowOf([main(), agent()], NOW, 'hour').span, HOUR_WINDOW_MS);
  assert.equal(windowOf([main(), agent()], NOW, 'session').start, main().startedAt);
});

test('barOf: the main session is clipped to the window and fills the track; a subagent keeps its place', () => {
  const win = windowOf([main(), agent({ startedAt: NOW - 50 * MIN })], NOW);
  const m = barOf(main(), win, NOW);
  assert.deepEqual([m.l, m.w, m.clipped, m.running], [0, 1, true, true]);
  const sub = barOf(agent({ startedAt: NOW - 50 * MIN }), win, NOW);
  assert.ok(sub.w >= 0.9 && sub.clipped === false);
  const done = barOf(agent({ startedAt: NOW - 30 * MIN, endedAt: NOW - 10 * MIN }), win, NOW);
  assert.ok(done.l > 0 && done.l + done.w < 1 && done.running === false);
  assert.equal(barOf(agent({ startedAt: NOW - 3 * HOUR, endedAt: NOW - 2 * HOUR }), win, NOW).outside, true);
});

test('placeBar: a very short agent keeps the minimum width and stays inside the track', () => {
  const px = 300;
  assert.equal(placeBar({ l: 0.5, w: 0.0001 }, px).width, MIN_BAR_PX);
  const edge = placeBar({ l: 0.999, w: 0.001 }, px);
  assert.equal(edge.width, MIN_BAR_PX);
  assert.ok(edge.left + edge.width <= px);
  assert.deepEqual(placeBar({ l: 0.2, w: 0.5 }, px), { left: 60, width: 150 });
});

test('segmentsIn: clipped to the window, relative to the bar; a running agent extends to now; no segs: one stretch in the agent colour', () => {
  const win = windowOf([main(), agent({ startedAt: NOW - 60 * MIN })], NOW, 'hour');
  const m = main({ segs: [{ k: 'logic', a: NOW - 5 * HOUR, b: NOW - 2 * HOUR }, { k: 'tests', a: NOW - 30 * MIN, b: NOW - 10 * MIN }, { k: 'logic', a: NOW - 10 * MIN, b: NOW - 9 * MIN }] });
  const segs = segmentsIn(m, win, NOW, kinds);
  assert.deepEqual(segs.map((s) => s.k), ['tests', 'logic']);
  assert.equal(segs[0].color, '#fbbf24');
  assert.ok(Math.abs(segs[0].l - 0.5) < 1e-9 && Math.abs(segs[0].w - 1 / 3) < 1e-9);
  const open = segmentsIn(agent({ startedAt: NOW - 20 * MIN, segs: [{ k: 'logic', a: NOW - 20 * MIN, b: NOW - 5 * MIN }] }), win, NOW, kinds);
  assert.ok(Math.abs(open[0].l + open[0].w - 1) < 1e-9);
  assert.deepEqual(segmentsIn(agent({ kindColor: '#123456' }), win, NOW, kinds), [{ k: 'logic', l: 0, w: 1, color: '#123456' }]);
  assert.deepEqual(segmentsIn(agent({ startedAt: NOW - 3 * HOUR, endedAt: NOW - 2 * HOUR }), win, NOW, kinds), []);
});

test('ticksOf: "-N min" up to an hour, clock times above, always ends with "now" and keeps its distance', () => {
  const short = ticksOf(windowOf([], NOW), 330);
  assert.deepEqual(short.at(-1), { frac: 1, label: 'now', anchor: 'end' });
  assert.ok(short.length >= 3 && short.slice(0, -1).every((t) => /^-\d+ min$/.test(t.label)), JSON.stringify(short));
  const long = ticksOf(windowOf([agent({ startedAt: NOW - 5 * HOUR })], NOW), 330);
  assert.ok(windowOf([agent({ startedAt: NOW - 5 * HOUR })], NOW).span > CLOCK_ABOVE_MS);
  assert.ok(long.slice(0, -1).every((t) => /^\d\d:\d\d$/.test(t.label)), JSON.stringify(long));
  for (const ticks of [short, long]) {
    const fr = ticks.map((t) => t.frac);
    assert.deepEqual([...fr].sort((a, b) => a - b), fr);
    assert.ok(fr.every((f, i) => i === 0 || (f - fr[i - 1]) * 330 >= MIN_TICK_PX * 0.9), 'ticks keep their distance');
  }
});

test('chevronLabel, endMarkOf, mixOf and tooltipOf use words, never ids', () => {
  assert.equal(chevronLabel(main(), NOW), 'started 24 h 37 min ago');
  assert.equal(endMarkOf(agent({ state: 'done' })), 'check');
  assert.equal(endMarkOf(agent({ state: 'done', ticket: { stage: 'failed' } })), 'cross');
  assert.equal(endMarkOf(agent()), null);
  const a = agent({ id: 'secret-id-123', startedAt: NOW - 20 * MIN, endedAt: NOW - 3 * MIN, state: 'done', segs: [{ k: 'tests', a: NOW - 20 * MIN, b: NOW - 12 * MIN }, { k: 'logic', a: NOW - 12 * MIN, b: NOW - 3 * MIN }] });
  assert.deepEqual(mixOf(a, NOW).map((m) => m.k), ['logic', 'tests']);
  assert.equal(mixOf(a, NOW).reduce((s, m) => s + m.pct, 0), 100);
  const tip = tooltipOf(a, NOW, kinds);
  assert.match(tip, /^started \d\d:\d\d · ended \d\d:\d\d · 17 min · Logic 53%, Tests 47%$/);
  assert.ok(!tip.includes('secret-id-123'));
  assert.match(tooltipOf(agent(), NOW, kinds), /running/);
});

test('spanOf: an open arrow while running, a range once ended', () => {
  assert.match(spanOf(agent(), NOW), /^\d\d:\d\d \u2192$/);
  assert.match(spanOf(agent({ endedAt: NOW - MIN }), NOW), /^\d\d:\d\d \u2192 \d\d:\d\d$/);
});

const TRACK_PX = 396;

test('default mode: one 10 min agent beside a 25 h main session gets at least 60% of the track (running and finished)', () => {
  const longMain = main({ startedAt: NOW - 25 * HOUR });
  const running = agent({ startedAt: NOW - 10 * MIN });
  const done = agent({ startedAt: NOW - 3 * HOUR, endedAt: NOW - 3 * HOUR + 10 * MIN, state: 'done' });
  for (const a of [running, done]) {
    const win = windowOf([longMain, a], NOW);
    const share = barOf(a, win, NOW).w;
    assert.ok(share >= 0.6, `bar share ${share}`);
    assert.ok(placeBar(barOf(a, win, NOW), TRACK_PX).width >= 0.6 * TRACK_PX);
    assert.equal(barOf(longMain, win, NOW).clipped, true);
  }
});

test('windowOf fit: when every subagent has finished the window ends at the last end, not at now, and the axis says clock times', () => {
  const a = agent({ startedAt: NOW - 3 * HOUR, endedAt: NOW - 2 * HOUR, state: 'done' });
  const win = windowOf([main(), a], NOW);
  assert.equal(win.live, false);
  assert.ok(win.end > a.endedAt && win.end < NOW);
  const ticks = ticksOf(win, TRACK_PX);
  assert.match(ticks.at(-1).label, /^\d\d:\d\d$/);
  assert.equal(windowOf([main(), a, agent({ id: 'r' })], NOW).live, true);
  assert.equal(ticksOf(windowOf([agent()], NOW), TRACK_PX).at(-1).label, 'now');
});

test('a bar is at least 12 px; a bar too narrow for its duration gets it written outside (right, else left)', () => {
  assert.equal(MIN_BAR_PX, 12);
  assert.equal(labelSideOf({ left: 100, width: LABEL_FIT_PX }, TRACK_PX), null);
  assert.equal(labelSideOf({ left: 100, width: MIN_BAR_PX }, TRACK_PX), 'right');
  assert.equal(labelSideOf({ left: TRACK_PX - MIN_BAR_PX, width: MIN_BAR_PX }, TRACK_PX), 'left');
  assert.equal(labelSideOf({ left: TRACK_PX - 80, width: MIN_BAR_PX }, TRACK_PX, 19), 'left');
});
