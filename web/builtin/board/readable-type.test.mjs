// readable-type.test.mjs - text-heavy frames (html, steps, timeline, text) never scale their type up past a readable size and
// scroll instead of clipping; only the big-number frames (metric, now) keep filling the card. Read as text: the rules live in CSS.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const CSS = readFileSync(new URL('./board.css', import.meta.url), 'utf8');
const STEPS = readFileSync(new URL('./frames/steps.js', import.meta.url), 'utf8');
const MAX_BODY_TIMES = 1.5;

const rule = (selector) => {
  const at = CSS.split('\n').find((l) => l.startsWith(`${selector} {`));
  assert.ok(at, `board.css has a rule for ${selector}`);
  return at;
};

test('--read-max is a token near the body size', () => {
  assert.match(CSS, /--read-max: calc\(var\(--fs\) \* 1\.2\);/u);
});

test('html frame: font capped at --read-max, scrolls instead of clipping', () => {
  const r = rule('.html');
  assert.match(r, /font-size: min\(max\(var\(--fs\), min\(4\.2cqw, 12cqh\)\), var\(--read-max\)\)/u);
  assert.match(r, /overflow-y: auto/u);
  assert.doesNotMatch(r, /overflow: hidden/u);
});

test('timeline and text-sub fonts are capped at --read-max', () => {
  assert.match(rule('.timeline'), /var\(--read-max\)/u);
  assert.match(rule('.text-sub'), /var\(--read-max\)/u);
});

test('steps: the font grows at most a little past the floor, and the card scrolls when the list still overflows', () => {
  assert.ok(Number(/FIT_MAX_TIMES = ([\d.]+)/u.exec(STEPS)[1]) <= MAX_BODY_TIMES);
  assert.match(rule('.steps'), /overflow-y: auto/u);
});

test('metric values keep scaling with the card', () => {
  assert.match(CSS, /font-size: max\(var\(--fs2\), min\(26cqw, 44cqh\)\)/u);
  assert.doesNotMatch(CSS, /\.metric-value[^\n]*--read-max/u);
});
