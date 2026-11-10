// Render without a browser: inspect the element tree produced by the Metrics and Struggles tabs.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderMetrics } from './detail-metrics.js';
import { renderStruggles } from './detail-struggles.js';
import { normalizeDetail } from './detail-logic.mjs';

const NOW = 1_800_000_000_000;
const MS_SEC = 1000;
const MS_MIN = 60 * MS_SEC;
const TOKENS = { total: 150, fresh: 100, cached: 900, output: 50, steps: 2, series: [{ t: NOW - MS_MIN, tokens: 100 }, { t: NOW, tokens: 150 }] };
const TURNS = { count: 2, lastMs: 3 * MS_SEC, avgMs: 2 * MS_SEC, maxMs: 3 * MS_SEC };
const CURVE_LABEL = 'Cumulative fresh input and output tokens';

class Element {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this.attrs = {};
    this.dataset = {};
    this.style = {};
    this.className = '';
    this.textContent = '';
    this.classList = { add: (name) => { this.className += ` ${name}`; } };
  }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  setAttribute(key, value) { this.attrs[key] = value; }
}
const walk = (node) => [node, ...node.children.flatMap(walk)];
const text = (node) => walk(node).map((n) => n.textContent).filter(Boolean).join(' ');
const base = (metrics = {}, external) => normalizeDetail({
  id: 'agent', updatedAt: NOW, endedAt: NOW, transcript: { isAvailable: true, entries: [], isWhole: true },
  metrics: { calls: 4, errors: 2, apiErrors: 1, tokens: TOKENS, turns: TURNS, ...metrics }, external,
});
const render = (t, detail, draw = renderMetrics) => {
  const original = globalThis.document;
  globalThis.document = { createElement: (tag) => new Element(tag), createElementNS: (_, tag) => new Element(tag) };
  t.after(() => { globalThis.document = original; });
  const root = new Element('div');
  draw(root, detail);
  return root;
};

test('Claude Metrics renders fresh/cache/output bar, cumulative curve, failed calls and turn statistics', (t) => {
  const d = base();
  assert.deepEqual(d.metrics.turns, TURNS);
  assert.deepEqual([d.metrics.tokens.fresh, d.metrics.tokens.cached, d.metrics.tokens.output], [100, 900, 50]);
  const root = render(t, d);
  const nodes = walk(root);
  const bar = nodes.find((n) => n.className === 'x-bar');
  assert.deepEqual(bar.children.map((n) => n.dataset.part), ['fresh', 'cached', 'out']);
  assert.match(bar.attrs['aria-label'], /100 fresh input, 900 cached input, 50 output/);
  const curve = nodes.find((n) => n.attrs['aria-label'] === CURVE_LABEL);
  assert.equal(curve.children.length, 2);
  assert.match(curve.children[1].attrs.d, /^M.+ L/);
  assert.match(text(root), /Turns 2 average 2 s · longest 3 s/);
  assert.match(text(root), /Failed calls 2 \/ 4 .*1 API errors/);
});

test('missing or short histories render honest empty states without a curve', (t) => {
  const root = render(t, base({ turns: null, tokens: { ...TOKENS, series: TOKENS.series.slice(0, 1) } }));
  assert.equal(walk(root).some((n) => n.attrs['aria-label'] === CURVE_LABEL), false);
  assert.match(text(root), /Not enough model requests/);
  assert.match(text(root), /Turns n\/a no turn durations recorded/);
  assert.equal(normalizeDetail({ id: 'agent', transcript: {}, metrics: {} }).metrics.turns, null);
});

test('Codex Metrics keeps its token bar and shows limit reset minutes using the detail timestamp', (t) => {
  const resetMinutes = 42;
  const external = { harness: 'codex', source: 'rollout', tokens: { input: 1000, ...TOKENS }, rate: { primary: { usedPct: 20, windowMinutes: 300, resetsAt: (NOW + resetMinutes * MS_MIN) / MS_SEC } } };
  const root = render(t, base({}, external));
  assert.equal(walk(root).filter((n) => n.className === 'x-bar').length, 1);
  assert.equal(walk(root).some((n) => n.attrs['aria-label'] === CURVE_LABEL), false);
  assert.match(text(root), /5-hour limit 20% used · resets in 42 min/);
});

test('API errors survive normalization and render as a Struggles item with evidence and count', (t) => {
  const d = base();
  d.struggles = normalizeDetail({ id: 'agent', transcript: {}, metrics: {}, struggles: {
    headline: '2 API errors.', open: 1, badge: 1,
    items: [{ kind: 'wrong-turn', title: 'API requests failed', evidence: 'Overloaded', n: 2, t: NOW, outcome: 'open' }],
  } }).struggles;
  const root = render(t, d, renderStruggles);
  assert.match(text(root), /API requests failed x2 still open Overloaded/);
});
