// The Pulse scene's pure logic (web/builtin/pulse/pulse-logic.mjs, pulse-view.mjs) and the shape of its files.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import * as L from './builtin/pulse/pulse-logic.mjs';
import { applySnapshot, makeGeom, newView, stepView } from './builtin/pulse/pulse-view.mjs';
import { createSim } from './pulse-feed.mjs';

const DIR = join(dirname(fileURLToPath(import.meta.url)), 'builtin', 'pulse');
const MAX_FILE_LINES = 800;
const SCENE_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.(html|css|js|mjs|json|svg|txt)$/;

test('the scene folder is flat, copyable by the mod, below 800 lines a file, and loads nothing from the network', () => {
  const names = readdirSync(DIR);
  assert.ok(names.includes('index.html') && names.includes('pulse.js') && names.includes('pulse.css'));
  for (const name of names) {
    assert.match(name, SCENE_FILE, `${name} would not be copied by the mod`);
    const text = readFileSync(join(DIR, name), 'utf8');
    assert.ok(text.split('\n').length <= MAX_FILE_LINES, `${name} is over ${MAX_FILE_LINES} lines`);
    assert.doesNotMatch(text, /https?:\/\//, `${name} names an absolute url`);
    assert.doesNotMatch(text, /\beval\(|new Function\(/, `${name} evaluates code`);
  }
});

test('toolKind sorts tools into colours; an unknown tool is "other"', () => {
  assert.equal(L.toolKind('Read'), 'read');
  assert.equal(L.toolKind('Grep'), 'read');
  assert.equal(L.toolKind('Edit'), 'edit');
  assert.equal(L.toolKind('Bash'), 'shell');
  assert.equal(L.toolKind('BashOutput'), 'shell');
  assert.equal(L.toolKind('WebFetch'), 'web');
  assert.equal(L.toolKind('spawn'), 'spawn');
  assert.equal(L.toolKind('lane'), 'lane');
  assert.equal(L.toolKind('mcp__x__y'), 'other');
  assert.equal(L.toolKind('constructor'), 'other', 'inherited keys are not tools');
  for (const kind of Object.values({ a: 'read', b: 'edit', c: 'shell', d: 'web', e: 'agent', f: 'other', g: 'spawn', h: 'lane' })) assert.ok(L.KIND_COLORS[kind]);
});

test('the clock, relative mode (a mod clock that is not epoch time): never backwards, follows the freshest write, ignores an unchanged file', () => {
  const clock = L.createClock(() => 1_800_000_000_000);
  assert.equal(clock.isReady(), false);
  assert.equal(clock.sync(10_000, 1000), true);
  assert.equal(clock.isReady(), true);
  assert.equal(clock.server(1000), 10_000);
  assert.equal(clock.server(2000), 11_000);
  assert.equal(clock.display(2000), 11_000 - L.DELAY_MS);
  // the same file again (nothing was written): no new information
  assert.equal(clock.sync(10_000, 2500), false);
  // a write that was fetched late looks older: the offset keeps the faster estimate
  assert.equal(clock.sync(11_100, 2600), true);
  assert.ok(clock.server(2600) >= 11_100);
  // a quicker fetch moves the clock forward, and what was shown is never taken back
  const before = clock.server(3000);
  clock.sync(12_900, 3000);
  assert.ok(clock.server(3000) >= before);
  assert.ok(clock.server(2999) >= clock.server(3000), 'monotonic even when asked about the past');
  assert.equal(clock.sync(Number.NaN, 1), false);
  assert.equal(clock.sync('x', 1), false);
});

test('the clock, wall mode (the mod writes epoch time on the same machine): a stale file is seen as old', () => {
  const wall = { now: 1_800_000_000_000 };
  const clock = L.createClock(() => wall.now);
  assert.equal(clock.sync(wall.now - 400, 10), true, 'a fresh write');
  assert.equal(clock.server(10), wall.now);
  wall.now += 5000;
  assert.equal(clock.server(5010), wall.now, 'follows the machine clock between polls');
  wall.now -= 2000;
  assert.ok(clock.server(5011) >= 1_800_000_005_000, 'a clock step back does not move the picture back');
  const old = L.createClock(() => wall.now);
  old.sync(wall.now - 3_600_000, 10);
  assert.ok(old.server(10) - (wall.now - 3_600_000) >= 3_600_000, 'an hour-old file is an hour old');
  assert.equal(L.createClock(() => wall.now).sync(wall.now + 60_000, 1), true, 'a clock far ahead still reads, in relative mode');
});

const ev = (t, loop, tool, target, extra = {}) => ({ t, loop, tool, target, ...extra });

test('the store keeps each event once, in time order, and learns an error that arrives later', () => {
  const store = L.createStore();
  const first = store.ingest([ev(1000, 'main', 'Read', 'a.ts'), ev(1100, 'main', 'Edit', 'a.ts')]);
  assert.equal(first.length, 2);
  assert.equal(first[0].kind, 'read');
  const again = store.ingest([ev(1000, 'main', 'Read', 'a.ts'), ev(1100, 'main', 'Edit', 'a.ts', { err: true }), ev(1200, 'agent-1', 'Bash', 'git')]);
  assert.equal(again.length, 1, 'only the new one');
  assert.equal(store.list.length, 3);
  assert.equal(store.list[1].err, true, 'the failure that was recorded after the first poll shows');
  assert.deepEqual(store.list.map((e) => e.t), [1000, 1100, 1200]);
  assert.equal(store.lastT(), 1200);
  // identical calls in the same millisecond are two events, and stay two when the window slides
  const twin = L.createStore();
  assert.equal(twin.ingest([ev(5, 'main', 'Read', 'x'), ev(5, 'main', 'Read', 'x')]).length, 2);
  assert.equal(twin.ingest([ev(5, 'main', 'Read', 'x'), ev(5, 'main', 'Read', 'x'), ev(6, 'main', 'Read', 'y')]).length, 1);
  // junk is skipped
  assert.equal(L.createStore().ingest([null, 3, { t: 'x' }, { t: 1 }, ev(2, 'm', 'Read', 'z')]).length, 1);
  assert.equal(L.createStore().ingest('nope').length, 0);
});

test('the store is bounded', () => {
  const store = L.createStore();
  store.ingest(Array.from({ length: L.MAX_EVENTS + 50 }, (_, i) => ev(i, 'main', 'Read', `f${i}`)));
  assert.equal(store.list.length, L.MAX_EVENTS);
  assert.equal(store.list[0].t, 50);
});

test('activity rises with recent calls of that loop and fades', () => {
  const list = [ev(1000, 'a', 'Read', 'x'), ev(1200, 'a', 'Read', 'y'), ev(1300, 'b', 'Read', 'z')];
  const now = L.activityOf(list, 'a', 1400);
  assert.ok(now > 0.5 && now < 1, String(now));
  assert.ok(L.activityOf(list, 'a', 1400 + L.ACT_TAU_MS * 4) < 0.05);
  assert.ok(L.activityOf(list, 'a', 1400) > L.activityOf(list, 'b', 1400));
  assert.equal(L.activityOf(list, 'nobody', 1400), 0);
  assert.equal(L.activityOf([], 'a', 1), 0);
});

const GEOM = { w: 960, h: 540, cx: 480, cy: 260, rx: 345, ry: 190, gap: 9, tagH: 15 };
const measure = (s) => s.length * 6.6;
const label = (e) => L.shortName(e.target, 24);

test('tag placement: a stable angle per name, no two live tags overlap, the same name keeps its place', () => {
  const store = L.createStore();
  const names = ['register.tsx', 'pulse-model.ts', 'state.ts', 'spec.ts', 'pulse-flush.ts', 'scene.ts', 'README.md', 'pane.tsx', 'index.html', 'pulse.css', 'types.d.ts', 'boot.ts', 'layout.ts', 'git', 'node'];
  const fresh = store.ingest(names.map((n, i) => ev(10_000 + i * 50, 'main', 'Read', n)));
  for (const e of fresh) L.placeTag(e, store.list, GEOM, measure, label);
  const rects = fresh.map((e) => L.tagRect(GEOM, e.a, measure(label(e)), GEOM.tagH));
  for (let i = 0; i < rects.length; i++)
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i];
      const b = rects[j];
      const apart = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
      assert.ok(apart, `${names[i]} overlaps ${names[j]}`);
    }
  for (const r of rects) assert.ok(r.x >= 0 && r.x + r.w <= GEOM.w, 'inside the canvas');
  // the same name later (while the first is shown) lands in the same place
  const [again] = store.ingest([ev(12_000, 'main', 'Edit', 'state.ts')]);
  L.placeTag(again, store.list, GEOM, measure, label);
  assert.equal(again.a, fresh[names.indexOf('state.ts')].a);
  // a name with no target still lands on the ring; a spawn and a lane do not
  const [bare, spawn, lane] = store.ingest([ev(13_000, 'main', 'Task', ''), ev(13_001, 'main', 'spawn', 'agent-x'), ev(13_002, 'main', 'lane', 't25')]);
  for (const e of [bare, spawn, lane]) L.placeTag(e, store.list, GEOM, measure, label);
  assert.equal(typeof bare.a, 'number');
  assert.equal(spawn.a, null);
  assert.equal(lane.a, null);
});

test('live tags: one per name with a count, fading in and out, gone after their life', () => {
  const store = L.createStore();
  const fresh = store.ingest([ev(1000, 'main', 'Read', 'a.ts'), ev(1200, 'main', 'Edit', 'a.ts'), ev(1300, 'main', 'Read', 'b.ts')]);
  for (const e of fresh) L.placeTag(e, store.list, GEOM, measure, label);
  const at = (T) => L.liveTags(store.list, T, label);
  assert.equal(at(1000).length, 0, 'the spark is still in flight');
  const mid = at(1000 + L.SPARK_MS + 2000);
  assert.deepEqual(mid.map((t) => [t.text, t.n]).sort(), [['a.ts', 2], ['b.ts', 1]]);
  for (const t of mid) assert.ok(t.alpha > 0.9);
  const early = at(1000 + L.SPARK_MS + 100);
  assert.ok(early[0].alpha < 0.5, 'fading in');
  const late = at(1300 + L.SPARK_MS + L.TAG_LIFE_MS - 500);
  assert.ok(late.length > 0 && late.every((t) => t.alpha < 0.3), 'fading out');
  assert.equal(at(1300 + L.SPARK_MS + L.TAG_LIFE_MS + 1).length, 0);
});

test('the timeline bins the last minute by second and by kind', () => {
  const T = 100_000;
  const list = [ev(T - 70_000, 'm', 'Read', 'old'), ev(T - 5400, 'm', 'Read', 'a'), ev(T - 5300, 'm', 'Edit', 'b'), ev(T - 5200, 'm', 'Read', 'c', { err: true }), ev(T - 100, 'm', 'Bash', 'git')];
  const bins = L.timelineBins(list.map((e) => ({ ...e, kind: L.toolKind(e.tool) })), T);
  assert.equal(bins.length, 2, 'the old one is outside');
  assert.deepEqual(bins[0].kinds, { read: 1, edit: 1, error: 1 });
  assert.equal(bins[0].total, 3);
  assert.equal(bins[1].kinds.shell, 1);
  assert.ok(bins[0].start < bins[1].start);
});

test('counts ease toward their target and snap when close', () => {
  assert.equal(L.easeCount(0, 0, 16), 0);
  const step = L.easeCount(0, 100, 16);
  assert.ok(step > 0 && step < 20);
  assert.ok(L.easeCount(0, 100, 1000) > 95);
  assert.equal(L.easeCount(99.7, 100, 16), 100);
  assert.equal(L.easeCount(50, 10, 16) < 50, true, 'counts down too');
});

test('a finished loop lingers, then fades out; main and running loops stay', () => {
  const done = { id: 'a', status: 'done', lastAt: 1000 };
  assert.ok(L.loopOpacity(done, 1000 + 1000) > 0.5);
  assert.equal(L.loopOpacity(done, 1000 + L.DONE_LINGER_MS + L.DONE_FADE_MS + 1), 0);
  const mid = L.loopOpacity(done, 1000 + L.DONE_LINGER_MS + L.DONE_FADE_MS / 2);
  assert.ok(mid > 0 && mid < 0.55);
  assert.equal(L.loopOpacity({ id: 'a', status: 'running', lastAt: 0 }, 1e9), 1);
  assert.equal(L.loopOpacity({ id: 'main', status: 'done', lastAt: 0 }, 1e9), 1);
});

test('lanes are grouped by the node they belong to; the rest stand free', () => {
  const lanes = [{ id: 'a', loop: 'main' }, { id: 'b', loop: 'agent-1' }, { id: 'c', loop: null }, { id: 'd', loop: 'gone' }, { id: 'e', loop: 'agent-1' }, null, { nope: 1 }];
  const { byLoop, free } = L.groupLanes(lanes, new Set(['main', 'agent-1']));
  assert.deepEqual(byLoop.get('agent-1').map((l) => l.id), ['b', 'e']);
  assert.deepEqual(byLoop.get('main').map((l) => l.id), ['a']);
  assert.deepEqual(free.map((l) => l.id), ['c', 'd'], 'a lane of a loop that is not on stage stands free');
  assert.deepEqual(L.groupLanes('x', new Set()).free, []);
});

test('quiet means nothing for 30 s of server time', () => {
  assert.equal(L.isQuiet(100_000, 80_000, 70_000), false);
  assert.equal(L.isQuiet(100_000, 60_000, 69_000), true);
  assert.equal(L.isQuiet(100_000, 69_000, 60_000), true);
  assert.equal(L.isQuiet(100_000, 60_000, 71_000), false, 'a changed file counts as activity');
});

test('small helpers: shortName keeps the extension, fmtDur and fmtInt read well, angles take the short way', () => {
  assert.equal(L.shortName('short.ts', 24), 'short.ts');
  const cut = L.shortName('a-very-long-component-name-for-a-test.spec.tsx', 24);
  assert.ok(cut.length <= 24 && cut.endsWith('.tsx') && cut.includes('…'), cut);
  assert.equal(L.fmtDur(4000), '4s');
  assert.equal(L.fmtDur(75_000), '1m 15s');
  assert.equal(L.fmtDur(3_700_000), '1h 01m');
  assert.equal(L.fmtDur(-5), '0s');
  assert.equal(L.fmtInt(1234), '1234');
  assert.equal(L.fmtInt(12345), '12 345');
  assert.ok(Math.abs(L.angDiff(0.1, 2 * Math.PI - 0.1) + 0.2) < 1e-9, 'wraps around');
  assert.ok(Math.abs(L.angDiff(0, 1) - 1) < 1e-9);
  assert.equal(L.clamp(5, 0, 1), 1);
  assert.equal(L.hashStr('a'), L.hashStr('a'));
  assert.notEqual(L.hashStr('a'), L.hashStr('b'));
  assert.ok(L.AGENT_COLORS.includes(L.agentColor('agent-1')));
});

test('the view: nodes ease to their orbit, lanes attach to their node, the numbers count up, nothing jumps', () => {
  const sim = createSim({ agents: 3, startedAt: 0 });
  const view = newView(960, 540);
  view.store = L.createStore();
  const now = 200_000;
  const snap = sim.tick(now, 5);
  applySnapshot(view, snap, 0, true);
  stepView(view, 16, 0, now, view.store.list);
  assert.equal(view.shownNodes.length, 2, 'the done agent has lingered only if it finished recently; this one finished long ago');
  const a = view.shownNodes[0];
  assert.ok(a.lanes.some((l) => l.id === 't25'), 'the lane sits on its node');
  assert.deepEqual(view.free.map((l) => l.id), ['plan', 'deploy', 'docs'].filter((id) => view.free.some((l) => l.id === id)));
  // a node never leaps: one frame moves it by at most a few pixels
  const x0 = a.x;
  const y0 = a.y;
  stepView(view, 16, 16, now + 16, view.store.list);
  assert.ok(Math.hypot(a.x - x0, a.y - y0) < 6);
  // counts approach the totals smoothly
  assert.ok(view.shown.calls > 0 && view.shown.calls < snap.totals.calls);
  for (let i = 0; i < 400; i++) stepView(view, 16, 32 + i * 16, now + 32 + i * 16, view.store.list);
  assert.equal(view.shown.calls, snap.totals.calls);
  // reduced motion: no drift, numbers at once
  const calm = newView(960, 540);
  calm.store = L.createStore();
  calm.isReduced = true;
  applySnapshot(calm, snap, 0, true);
  stepView(calm, 16, 5000, now, calm.store.list);
  assert.equal(calm.shown.calls, snap.totals.calls);
});

test('geometry fits the stage at 960x540, at full screen and in a narrow frame', () => {
  for (const [w, h] of [[960, 540], [1920, 1080], [480, 320], [390, 700]]) {
    const g = makeGeom(w, h);
    assert.ok(g.cx - g.rx >= 0 && g.cx + g.rx <= w, `ring fits horizontally at ${w}x${h}`);
    assert.ok(g.cy - g.ry >= g.headerH * 0.9 && g.cy + g.ry <= h - g.footH * 0.9, `ring fits vertically at ${w}x${h}`);
    assert.ok(g.ox < g.rx && g.oy < g.ry);
  }
});
