// insight-logic.test.mjs - what the agent rows say: normalising the mod's insight, the duration / tokens wording, the strip, the bar scale.
import test from 'node:test';
import assert from 'node:assert/strict';
import { barShare, formatDuration, formatTokens, INSIGHT_CAPS, liveKind, MIN_BAR_SHARE, normalizeInsight, stripKinds, THINK_AFTER_MS } from './insight-logic.mjs';
import { isCallsBars, normalizeData } from './board-logic.mjs';

const GOOD = { kind: 'ui', headline: 'Writing UI · board.css', strip: 'xxu.tl', mix: [{ kind: 'ui', pct: 60 }, { kind: 'tests', pct: 40 }], files: ['a.ts', 'b.ts', 'c.ts', 'd.ts'], feed: ['read 4 files', 'edited board.js'], tokens: 42_400, lastCallAt: 5, isBusy: false, isMain: false };

test('normalizeInsight: a good insight is kept, junk is cleaned or dropped, never throws', () => {
  assert.deepEqual(normalizeInsight(GOOD), { ...GOOD, files: ['a.ts', 'b.ts', 'c.ts'], tokens: 42_400 });
  for (const bad of [null, undefined, 5, 'x', [], {}, { kind: 'sleeping' }, { phase: 'editing' }]) assert.equal(normalizeInsight(bad), undefined);
  const odd = normalizeInsight({ ...GOOD, strip: 'x<script>', files: [1, '', 'a'.repeat(99)], feed: 'nope', tokens: -3, lastCallAt: 'now', isBusy: 'yes' });
  assert.equal(odd.strip, '');
  assert.equal(odd.files.length, 1);
  assert.ok(odd.files[0].length <= INSIGHT_CAPS.file);
  assert.deepEqual(odd.feed, []);
  assert.equal(odd.tokens, null);
  assert.equal(odd.lastCallAt, 0);
  assert.equal(odd.isBusy, false);
  assert.equal(normalizeInsight({ ...GOOD, tokens: null }).tokens, null);
  assert.equal(normalizeInsight({ ...GOOD, strip: 'x'.repeat(INSIGHT_CAPS.strip + 1) }).strip, '');
  assert.equal(normalizeInsight({ ...GOOD, headline: '' }).headline, 'Writing UI'); // no headline: the kind's own
  assert.equal(normalizeInsight({ ...GOOD, headline: 'x'.repeat(200) }).headline.length, INSIGHT_CAPS.headline);
  const mix = normalizeInsight({ ...GOOD, mix: [{ kind: 'ui', pct: 70.4 }, { kind: 'nope', pct: 10 }, { kind: 'docs', pct: 0 }, { kind: 'tests', pct: 'x' }, 5, { kind: 'visual', pct: 30 }] }).mix;
  assert.deepEqual(mix, [{ kind: 'ui', pct: 70 }, { kind: 'visual', pct: 30 }]);
  assert.deepEqual(normalizeInsight({ ...GOOD, mix: 'nope' }).mix, []);
});

test('formatDuration: seconds, minutes and seconds, hours; junk -> empty', () => {
  assert.equal(formatDuration(0), '0 s');
  assert.equal(formatDuration(42_900), '42 s');
  assert.equal(formatDuration(200_000), '3 min 20 s');
  assert.equal(formatDuration(180_000), '3 min');
  assert.equal(formatDuration(7_500_000), '2 h 05 min');
  for (const bad of [-1, NaN, undefined, '5']) assert.equal(formatDuration(bad), '');
});

test('formatTokens: 42k tokens, decimals only while small; unknown -> empty', () => {
  assert.equal(formatTokens(42_400), '42k tokens');
  assert.equal(formatTokens(4_250), '4.3k tokens');
  assert.equal(formatTokens(850), '850 tokens');
  assert.equal(formatTokens(999_999), '1M tokens');
  assert.equal(formatTokens(1_240_000), '1.2M tokens');
  for (const bad of [null, undefined, 0, -5, NaN]) assert.equal(formatTokens(bad), '');
});

test('liveKind: a stale kind of work becomes thinking, unless a call is in flight or the agent is done', () => {
  const at = 1_000_000;
  const ins = (over = {}) => ({ ...normalizeInsight({ ...GOOD, lastCallAt: at }), ...over });
  const kind = (...a) => liveKind(...a).kind;
  assert.equal(kind(ins(), 'working', at + THINK_AFTER_MS), 'ui');
  assert.equal(kind(ins(), 'working', at + THINK_AFTER_MS + 1), 'thinking');
  assert.equal(liveKind(ins(), 'working', at + THINK_AFTER_MS + 1).headline, 'Thinking');
  assert.equal(liveKind(ins(), 'working', at).headline, 'Writing UI · board.css');
  assert.equal(kind(ins({ isBusy: true }), 'working', at + 10 * THINK_AFTER_MS), 'ui');
  assert.equal(kind(ins(), 'done', at + 10 * THINK_AFTER_MS), 'ui');
  assert.equal(kind(ins({ kind: 'waiting' }), 'waiting', at + 10 * THINK_AFTER_MS), 'waiting');
  assert.equal(kind(ins({ lastCallAt: 0 }), 'working', at), 'ui');
});

test('stripKinds and barShare', () => {
  assert.deepEqual(stripKinds('xultg.?w'), ['reading', 'ui', 'logic', 'tests', 'delegating', 'none', 'none', 'working']);
  assert.equal(barShare(60_000, 120_000, false), 0.5);
  assert.equal(barShare(1_000, 120_000, false), MIN_BAR_SHARE);
  assert.equal(barShare(500_000, 120_000, false), 1);
  assert.equal(barShare(5, 120_000, true), 1); // the session
  assert.equal(barShare(5, 0, false), 1);
});

test('the data file: lanes keep a clean insight; the per-agent bars (time, tokens, older calls) count as redundant with the rows', () => {
  const { lanes } = normalizeData({ lanes: [{ id: 'a', label: 'A', state: 'working', insight: GOOD }, { id: 'b', label: 'B', state: 'working', insight: { kind: 'x' } }] });
  assert.equal(lanes[0].insight.kind, 'ui');
  assert.equal(lanes[1].insight, undefined);
  for (const unit of ['min', 'k tokens', 'calls']) assert.equal(isCallsBars({ type: 'bars', unit }), true);
  assert.equal(isCallsBars({ type: 'bars', unit: 'ms' }), false);
});
