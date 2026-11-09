// Pure logic of the agent detail view: node --test web/builtin/agents-info/*.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CAPS, DEFAULT_TAB, TABS, callBuckets, currentStep, failureTone, longestGap, plainTitle, timelineTicks, tokenReason, TIMING, activitySplit, callTime, clockOf, clockShort, coverageText, fillState, kindBars, normalizeDetail, requestOf, seriesPath, tokensText } from './detail-logic.mjs';

const T = 1_767_000_000_000;
const raw = (over = {}) => ({
  id: 'a', name: 'A', isMain: false, state: 'working', startedAt: T - 1000, endedAt: null, updatedAt: T, brief: 'Do it',
  transcript: { isAvailable: true, reason: '', entries: [], hasMore: false, pages: 1, isWhole: true, fromT: null, toT: null },
  metrics: { elapsedMs: 1000, activeMs: 400, idleMs: 600, calls: 3, errors: 0, retries: 0, tokens: { total: 10, series: [], steps: 0, coveredFromT: null }, kinds: [], tools: [], files: [] },
  struggles: { headline: '', badge: 0, open: 0, resolved: 0, items: [], calm: [] },
  ...over,
});

test('normalizeDetail: garbage is null, never a throw', () => {
  for (const v of [null, undefined, 1, 'x', [], {}, { id: 'a' }, { id: '', transcript: {}, metrics: {} }, { id: 'a', transcript: [], metrics: {} }]) assert.equal(normalizeDetail(v), null);
});

test('normalizeDetail: entries are checked (kind, time, text), texts and counts capped, junk dropped', () => {
  const d = normalizeDetail(raw({
    transcript: {
      isAvailable: true, hasMore: true, pages: 99, entries: [
        { t: T, kind: 'say', text: 'x'.repeat(5000) }, { t: T, kind: 'say', text: '   ' }, { t: 'no', kind: 'say', text: 'hi' }, { t: T, kind: 'weird', text: 'hi' },
        { t: T, kind: 'tool', tool: 'Bash', label: 'npm test', ms: 5, error: 'boom' }, { t: T, kind: 'tool', tool: 'Read', label: 'a.ts', ms: -1, error: null }, { t: T, kind: 'user', text: 'u' },
      ],
    },
  }));
  assert.deepEqual(d.transcript.entries.map((e) => e.kind), ['say', 'tool', 'tool', 'user']);
  assert.ok(d.transcript.entries[0].text.length <= CAPS.text);
  assert.deepEqual(d.transcript.entries[1], { t: T, kind: 'tool', tool: 'Bash', label: 'npm test', ms: 5, error: 'boom' });
  assert.equal(d.transcript.entries[2].ms, null);
  assert.equal(d.transcript.entries[2].error, null);
  assert.equal(d.transcript.pages, CAPS.maxPages);
});

test('normalizeDetail: a number the host did not measure stays null; colors are checked', () => {
  const d = normalizeDetail(raw({
    metrics: { elapsedMs: 5, activeMs: 1, idleMs: 4, calls: -3, errors: null, retries: null, tokens: { total: 0, series: [{ t: T, tokens: 1 }, { t: 'x' }], steps: 2, coveredFromT: null }, kinds: [{ kind: 'logic', label: 'Logic', color: 'red', ms: 10 }, { kind: 'bad', ms: 0 }], tools: [{ tool: 'Read', n: 3 }, { n: 1 }], files: [{ name: 'a.ts', reads: 1, edits: 2 }, 5] },
  }));
  assert.equal(d.metrics.errors, null);
  assert.equal(d.metrics.retries, null);
  assert.equal(d.metrics.tokens.total, null);
  assert.equal(d.metrics.calls, 0);
  assert.equal(d.metrics.tokens.series.length, 1);
  assert.deepEqual(d.metrics.kinds.map((k) => [k.kind, k.color]), [['logic', '#64748b']]);
  assert.deepEqual(d.metrics.tools, [{ tool: 'Read', n: 3 }]);
  assert.deepEqual(d.metrics.files, [{ name: 'a.ts', reads: 1, edits: 2 }]);
});

test('requestOf clamps the pages to 1..max', () => {
  assert.deepEqual(requestOf('a', 0), { id: 'a', pages: 1 });
  assert.deepEqual(requestOf('a', 3.7), { id: 'a', pages: 3 });
  assert.deepEqual(requestOf('a', 99), { id: 'a', pages: CAPS.maxPages });
});

test('fillState: the detail of the open agent is ok, then stale; none yet is loading, then none', () => {
  const d = normalizeDetail(raw({ updatedAt: T }));
  assert.equal(fillState(d, 'a', T + 1000, T), 'ok');
  assert.equal(fillState(d, 'a', T + TIMING.staleMs + 1, T), 'stale');
  assert.equal(fillState(d, 'other', T + 1000, T), 'loading');
  assert.equal(fillState(null, 'a', T + TIMING.noAnswerMs + 1, T), 'none');
  assert.equal(fillState(null, 'a', T + 100, T), 'loading');
});

test('clock and call times', () => {
  assert.match(clockOf(T), /^\d\d:\d\d:\d\d$/);
  assert.equal(clockShort(T), clockOf(T).slice(0, 5));
  assert.equal(clockOf(0), '');
  assert.equal(clockOf(NaN), '');
  assert.equal(callTime(null), '');
  assert.equal(callTime(400), '<1 s');
  assert.equal(callTime(1400), '1.4 s');
  assert.equal(callTime(42_000), '42 s');
  assert.equal(callTime(200_000), '3 min 20 s');
});

test('kindBars: shares add up to 100, largest first; empty or zero time gives nothing', () => {
  const bars = kindBars([{ kind: 'a', ms: 1 }, { kind: 'b', ms: 1 }, { kind: 'c', ms: 1 }]);
  assert.equal(bars.reduce((s, b) => s + b.pct, 0), 100);
  assert.deepEqual(kindBars([{ kind: 'x', ms: 3 }, { kind: 'y', ms: 7 }]).map((b) => [b.kind, b.pct]), [['y', 70], ['x', 30]]);
  assert.deepEqual(kindBars([]), []);
  assert.deepEqual(kindBars([{ kind: 'z', ms: 0 }]), []);
});

test('activitySplit: whole percents that add up to 100; no run, no split; active never above the run', () => {
  assert.deepEqual(activitySplit({ elapsedMs: 1000, activeMs: 250, idleMs: 750 }), { activePct: 25, idlePct: 75 });
  assert.deepEqual(activitySplit({ elapsedMs: 0, activeMs: 0, idleMs: 0 }), { activePct: 0, idlePct: 0 });
  assert.deepEqual(activitySplit({ elapsedMs: 10, activeMs: 99, idleMs: 0 }), { activePct: 100, idlePct: 0 });
});

test('seriesPath: below two points there is no curve; otherwise a line and a closed area inside the box, ending at the highest value', () => {
  assert.equal(seriesPath([], 100, 50, 2), null);
  assert.equal(seriesPath([{ t: 1, tokens: 5 }], 100, 50, 2), null);
  const p = seriesPath([{ t: 0, tokens: 0 }, { t: 10, tokens: 50 }, { t: 20, tokens: 100 }], 100, 50, 2);
  assert.equal(p.max, 100);
  assert.equal(p.line, 'M2 48 L50 25 L98 2');
  assert.ok(p.area.endsWith('Z'));
  assert.equal(p.from, 0);
  assert.equal(p.to, 20);
});

test('tokensText and coverageText say what is and is not known', () => {
  assert.equal(tokensText(null), 'not measured');
  assert.equal(tokensText(1500), '1.5k tokens');
  const base = { isAvailable: true, entries: [{}], isWhole: true, hasMore: false, fromT: T, toT: T + 60_000 };
  assert.match(coverageText(base), /^The whole transcript/);
  assert.match(coverageText({ ...base, isWhole: false }), /^The latest part/);
  assert.match(coverageText({ ...base, hasMore: true }), /earlier entries can be loaded/);
  assert.equal(coverageText({ ...base, isAvailable: false }), '');
  assert.equal(coverageText({ ...base, entries: [] }), '');
});

test('plainTitle drops ticket id and model suffix', () => {
  assert.equal(plainTitle('T63 · fix the tab (sonnet/low)'), 'Fix the tab');
  assert.equal(plainTitle('T40: Deep insight'), 'Deep insight');
  assert.equal(plainTitle('Me'), 'Me');
  assert.equal(plainTitle(null), '');
});

test('ticks (positions for the sparkline), the longest gap and the current step', () => {
  const d = normalizeDetail(raw({ transcript: { isAvailable: true, isWhole: true, entries: [
    { t: T - 800, kind: 'tool', tool: 'Bash', label: 'npm test', ms: 5, error: 'boom' }, { t: T - 200, kind: 'tool', tool: 'Read', label: 'T5 a.ts', ms: 5, error: null }] } }));
  const ticks = timelineTicks(d);
  assert.equal(ticks.length, 2);
  assert.equal(ticks[0].failed, true);
  assert.ok(ticks[0].pos < ticks[1].pos);
  assert.equal(longestGap(d).ms, 600);
  assert.equal(currentStep(d), 'Read a.ts');
  assert.equal(callBuckets(d, 4).reduce((a, b) => a + b, 0), 2);
});

test('the current step is plain text: markdown marks of the agent text are dropped', () => {
  const d = normalizeDetail(raw({ transcript: { isAvailable: true, isWhole: true, entries: [{ t: T - 100, kind: 'say', text: '**1. Result: done.** The tile is `ready`' }] } }));
  assert.equal(currentStep(d), '1. Result: done. The tile is ready');
});

test('failureTone and tokenReason', () => {
  assert.equal(failureTone(0, 5), 'ok');
  assert.equal(failureTone(1, 1), 'bad');
  assert.equal(failureTone(null, 5), 'none');
  assert.match(tokenReason(normalizeDetail(raw({ transcript: { isAvailable: false } }))), /no transcript/);
});

test('the tabs: Progress first and the one that opens; the struggles and the progress are normalized, an old detail gets empty ones', () => {
  assert.deepEqual([...TABS], ['progress', 'transcript', 'metrics', 'struggles']);
  assert.equal(DEFAULT_TAB, 'progress');
  const old = normalizeDetail(raw({ struggles: [{ kind: 'error', text: 'x' }], progress: undefined }));
  assert.deepEqual(old.struggles.items, []);
  assert.equal(old.progress.isEmpty, true);
  assert.equal(old.progress.plan.items.length, 0);
  const fresh = normalizeDetail(raw({ progress: { now: { say: 'Editing the view.' }, phases: [{ label: 'read files', kind: 'read', a: T - 5000, b: T - 1000 }] } }));
  assert.equal(fresh.progress.isEmpty, false);
  assert.equal(fresh.progress.now.say, 'Editing the view.');
  assert.equal(fresh.progress.phases[0].ms, 4000);
});

test('normalizeDetail keeps isFromPulse (the transcript tab then lists the pulse\'s calls) and defaults it to false', () => {
  assert.equal(normalizeDetail(raw({ transcript: { isAvailable: false, reason: 'x', isFromPulse: true, entries: [] } })).transcript.isFromPulse, true);
  assert.equal(normalizeDetail(raw({ transcript: { isAvailable: false } })).transcript.isFromPulse, false);
});
