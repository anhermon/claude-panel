// Tests for the deck's simulation (node --test): repeatable, and the numbers printed on the slides are the numbers it produces.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CLIENTS, RETRIES, SPAN_S, STRATEGIES, histogram, meanPeak, mulberry32, retryTimes, simulate } from './herd.js';

const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const strategies = Object.keys(STRATEGIES);

test('the generator is repeatable and uniform-ish', () => {
  const a = mulberry32(7);
  const b = mulberry32(7);
  const xs = Array.from({ length: 1000 }, () => a());
  assert.deepEqual(xs, Array.from({ length: 1000 }, () => b()));
  assert.ok(xs.every((x) => x >= 0 && x < 1));
  assert.ok(Math.abs(xs.reduce((s, x) => s + x, 0) / xs.length - 0.5) < 0.05);
});

test('every client retries RETRIES times, later each time, inside the window', () => {
  for (const name of strategies) {
    const run = simulate(name);
    assert.equal(run.length, CLIENTS);
    for (const { times } of run) {
      assert.equal(times.length, RETRIES);
      assert.ok(times.every((t, i) => t > 0 && (i === 0 || t > times[i - 1])), `${name}: ${times}`);
      assert.ok(times.at(-1) < SPAN_S);
    }
  }
});

test('without jitter all clients retry together; with jitter they do not', () => {
  assert.deepEqual(new Set(simulate('exponential').map((c) => c.times.join())).size, 1);
  assert.deepEqual(retryTimes('exponential', Math.random), [0.5, 1.5, 3.5, 7.5]);
  assert.ok(new Set(simulate('full').map((c) => c.times.join())).size > CLIENTS / 2);
});

test('the histogram counts every request that falls inside the window', () => {
  for (const name of strategies) assert.equal(histogram(simulate(name)).reduce((s, n) => s + n, 0), CLIENTS * RETRIES);
});

test('the numbers on slides 5 and 6 are what the simulation produces', () => {
  const chart = JSON.parse(/<p-chart[^>]*\sdata='([^']+)'/.exec(html)[1]);
  const shown = Object.fromEntries(chart.map((row) => [row.strategy, row.peak]));
  for (const name of strategies) assert.equal(shown[STRATEGIES[name].label], meanPeak(name), name);
  const ratio = (meanPeak('exponential') / meanPeak('full')).toFixed(1);
  assert.match(html, new RegExp(`class="num">${ratio.replace('.', '\\.')}&times;`), `big number should read ${ratio}`);
});
