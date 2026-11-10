// assets.test.mjs - panel/assets contract: every asset has a valid sample, refuses bad data with a message that names the field,
// stays under 800 lines, and the registry lists them. DOM-free (draw is covered by scripts/render-assets-catalog.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ASSETS, kinds, describe, validate, AssetError, unknownKindMessage } from './kit/assets/index.js';
import { openRequest } from './kit/assets/statusboard.js';
import { sankeyLayout } from './kit/assets/flow.js';
import { kindsJson } from '../scripts/gen-viz-kinds.mjs';
import { layerGraph, spread } from './kit/assets/layout.js';
import { stripTypeScriptTypes } from 'node:module';
import { easingAt, velocityPeak } from './kit/assets/easing.js';
import { medianGap } from './kit/assets/waveform.js';
import { groupedShots, shotEnd } from './kit/assets/shotlist.js';
import { CURVE_KINDS, MEDIA_SCHEMAS } from './kit/assets/media-schema.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ASSET_DIR = join(HERE, 'kit', 'assets');
const MAX_LINES = 800;
const MIN_KINDS = 14; // the brief's floor; the registry holds more
const BAD_INPUTS = [null, 42, 'text', [], {}, { unexpectedField: 1 }];

test('at least 14 distinct assets, each with a shape, a summary, field names and a sample', () => {
  assert.ok(kinds().length >= MIN_KINDS, `only ${kinds().length} assets: ${kinds()}`);
  assert.equal(new Set(kinds()).size, kinds().length);
  for (const k of kinds()) {
    const d = describe(k);
    assert.ok(d.shape.length > 10 && d.summary.length > 10, `${k} shape/summary`);
    assert.ok(Array.isArray(d.keys) && d.keys.length > 0, `${k} keys`);
    assert.ok(d.sample && typeof d.sample === 'object', `${k} sample`);
  }
});

test('every sample validates, and validate() is idempotent on its own output', () => {
  for (const k of kinds()) {
    const clean = validate(k, ASSETS[k].def.sample);
    assert.doesNotThrow(() => validate(k, clean), `${k}: clean data must validate again`);
  }
});

test('bad data throws AssetError (never TypeError) and the message starts at a field path or says what is wrong', () => {
  for (const k of kinds()) {
    for (const bad of BAD_INPUTS) {
      try { validate(k, bad); } catch (e) { assert.ok(e instanceof AssetError, `${k} ${JSON.stringify(bad)}: ${e && e.stack}`); assert.match(e.message, /data|must|needs|unknown|is not/, `${k}: ${e.message}`); }
    }
  }
});

test('an unknown field is refused with the allowed fields listed', () => {
  for (const k of kinds()) {
    const sample = ASSETS[k].def.sample;
    assert.throws(() => validate(k, { ...sample, zzBogus: 1 }), /zzBogus.*not a known field.*allowed/, k);
  }
});

test('an unknown kind lists the valid kinds', () => {
  assert.throws(() => validate('piechart', {}), (e) => e instanceof AssetError && e.message.includes('valid kinds') && kinds().every((k) => e.message.includes(k)));
  assert.match(unknownKindMessage('x'), /sankey/);
});

test('the sankey error names the field', () => {
  assert.throws(() => validate('sankey', { links: [{ from: 'a', to: 'b', value: 'x' }] }), /data\.links\[0\]\.value/);
  assert.throws(() => validate('sankey', { links: [{ from: 'a', to: 'b', value: 1 }, { from: 'b', to: 'a', value: 1 }] }), /loop/);
});

test('every asset file is at most 800 lines', () => {
  for (const f of readdirSync(ASSET_DIR).filter((n) => n.endsWith('.js'))) assert.ok(readFileSync(join(ASSET_DIR, f), 'utf8').split('\n').length <= MAX_LINES, f);
});

test('asset files import only relative paths, d3 through ../d3/d3.mjs (so they run under node and in the importmap)', () => {
  for (const f of readdirSync(ASSET_DIR).filter((n) => n.endsWith('.js'))) {
    for (const m of readFileSync(join(ASSET_DIR, f), 'utf8').matchAll(/^import\s[^'"]*['"]([^'"]+)['"]/gm)) assert.ok(m[1].startsWith('.'), `${f} statically imports ${m[1]}: use a relative path or a dynamic import()`);
  }
});

test('layerGraph: longest path layers, cycles tolerated', () => {
  const g = layerGraph(['a', 'b', 'c', 'd'], [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'a', to: 'c' }, { from: 'c', to: 'a' }]);
  assert.deepEqual([g.layerOf.get('a'), g.layerOf.get('b'), g.layerOf.get('c'), g.layerOf.get('d')], [0, 1, 2, 0]);
  assert.equal(g.backEdges.size, 1);
});

test('spread keeps labels apart inside the box', () => {
  const ys = spread([10, 11, 12, 13], 14, 0, 100);
  for (let i = 1; i < ys.length; i++) assert.ok(ys[i] - ys[i - 1] >= 14 - 1e-9);
  assert.ok(Math.min(...ys) >= 0 && Math.max(...ys) <= 100);
});

test('sankeyLayout: node heights are proportional, ribbons fit inside their nodes', () => {
  const nodes = ['a', 'b', 'c'].map((id) => ({ id }));
  const links = [{ from: 'a', to: 'b', value: 3 }, { from: 'a', to: 'c', value: 1 }];
  const g = sankeyLayout(nodes, links, { w: 400, h: 200 });
  const by = Object.fromEntries(g.nodes.map((n) => [n.id, n]));
  assert.ok(Math.abs(by.b.h / by.c.h - 3) < 1e-6);
  assert.ok(Math.abs(by.a.h - (by.b.h + by.c.h)) < 1e-6);
  for (const l of g.links) assert.ok(l.y0 - l.w / 2 >= by[l.from].y - 1e-6 && l.y0 + l.w / 2 <= by[l.from].y + by[l.from].h + 1e-6);
});

test('hooks/viz-kinds.ts is fresh: the TypeScript side lists exactly the registry (run node scripts/gen-viz-kinds.mjs)', () => {
  assert.equal(readFileSync(join(HERE, '..', 'hooks', 'viz-kinds.ts'), 'utf8'), kindsJson());
});

test('references/assets.md names every asset kind in its shape table', () => {
  const doc = readFileSync(join(HERE, '..', 'skills', 'panel-guide', 'references', 'assets.md'), 'utf8');
  const missing = kinds().filter((k) => !doc.includes(`| \`${k}\` |`));
  assert.deepEqual(missing, [], `assets.md lacks a table row for: ${missing}`);
});

// The lightweight DOM exercises actual makers and update(), without launching a browser.
const WORK_KINDS = ['testresults', 'hypotheses', 'decisionmatrix', 'sources', 'limits', 'riskgrid'];
const WORK_BAD = {
  testresults: ['suites', 'passed'], hypotheses: ['items', 'confidence'],
  decisionmatrix: ['criteria', 'weight'], sources: ['items', 'confidence'],
  limits: ['windows', 'usedPct'], riskgrid: ['items', 'impact'],
};
const WORK_LABELS = { testresults: 'passed', hypotheses: 'confidence', decisionmatrix: 'ranking', sources: 'evidence', limits: 'usage', riskgrid: 'risks' };
const TEST_WIDTHS = [360, 1280];
const TEST_FS = 17;
const TEST_HEIGHT = 320;
const ROW_LIMIT = 1;
const FLAT_LIMITS_SAMPLE = { windows: [{ label: 'Short window', usedPct: 34 }, { label: 'Long window', usedPct: 63 }], context: { usedPct: 23 }, cost: { amount: 3.2156023, unit: 'USD' } };
const { createDocument } = await import('./fake-dom.mjs');
const doc = createDocument();
const FakeNode = doc.body.constructor;
FakeNode.prototype.append = function (...nodes) { nodes.forEach((node) => this.appendChild(node instanceof FakeNode ? node : doc.createTextNode(String(node)))); };
FakeNode.prototype.querySelector = function (selector) { return this.find((n) => (n.getAttribute('class') ?? '').split(' ').includes(selector.split('.').at(-1))) ?? null; };
Object.defineProperty(FakeNode.prototype, 'clientWidth', { get: () => TEST_WIDTHS[0], configurable: true });
doc.createTextNode = (text) => { const node = doc.createElement('#text'); node.textContent = text; return node; };
Object.assign(globalThis, { document: doc, Node: FakeNode, cancelAnimationFrame: () => {}, matchMedia: () => ({ matches: true }) });
const byClass = (el, cls) => el.find((n) => (n.getAttribute('class') ?? '').split(' ').includes(cls));

for (const kind of WORK_KINDS) {
  test(`${kind}: sample, field path, payload cap, update, customization, clipping and theme tokens`, async () => {
    const sample = structuredClone(kind === 'limits' ? FLAT_LIMITS_SAMPLE : describe(kind).sample);
    assert.doesNotThrow(() => validate(kind, sample));
    const [list, field] = WORK_BAD[kind];
    const bad = structuredClone(sample);
    bad[list][0][field] = 'wrong';
    assert.throws(() => validate(kind, bad), (e) => e instanceof AssetError && e.message.includes(`data.${list}[0].${field}`));
    assert.ok(JSON.stringify(sample).length <= 12 * 1024);
    for (const width of TEST_WIDTHS) {
      Object.defineProperty(FakeNode.prototype, 'clientWidth', { get: () => width, configurable: true });
      const opts = { title: 'Custom title', caption: 'Custom caption', fs: TEST_FS, height: TEST_HEIGHT, accent: 'c3', density: 'compact', maxRows: ROW_LIMIT, labels: { [WORK_LABELS[kind]]: 'Custom word', more: 'remaining' } };
      const figure = ASSETS[kind](sample, opts);
      await Promise.resolve();
      assert.equal(figure.dataset.state, 'ok');
      assert.ok(figure.textContent.includes('Custom title'));
      assert.ok(figure.textContent.includes('Custom caption'));
      assert.ok(figure.textContent.includes('Custom word'), figure.textContent);
      assert.match(figure.textContent, /\+\d+ remaining/);
      const box = byClass(figure, 'pa-work');
      assert.ok(box, figure.textContent);
      assert.equal(box.style['--work-accent'], 'var(--ui-c3)');
      assert.equal(box.getAttribute('data-density'), 'compact');
      assert.equal(box.style['--ui-fs'], `${TEST_FS}px`);
      assert.equal(box.style.height, `${TEST_HEIGHT}px`);
      const before = figure.textContent;
      const next = structuredClone(sample);
      const entry = next[list][0];
      if ('name' in entry) entry.name = 'Updated row';
      else if ('title' in entry) entry.title = 'Updated row';
      else entry.label = 'Updated row';
      figure.update(next, { maxRows: 40, density: 'comfortable' });
      assert.notEqual(figure.textContent, before);
      assert.ok(figure.textContent.includes('Updated row'));
      assert.ok(!figure.textContent.includes('remaining'));
      figure.update(bad);
      assert.equal(figure.dataset.state, 'error');
      assert.ok(figure.textContent.includes(`data.${list}[0].${field}`));
      figure.destroy();
    }
    const source = readFileSync(join(ASSET_DIR, `${kind}.js`), 'utf8');
    assert.doesNotMatch(source, /#[0-9a-f]{3,8}\b|rgba?\(/i);
    const css = doc.documentElement.textContent;
    assert.match(css, /data-theme="light"/);
    assert.match(css, /data-theme="dark"/);
    assert.match(css, /var\(--ui-card\)/);
  });
}

test('work assets preserve missing scores, source ordering, reset thresholds and risk order', async () => {
  const { rankOptions } = await import('./kit/assets/decisionmatrix.js');
  const { sortSources } = await import('./kit/assets/sources.js');
  const { quotaTone, resetDuration } = await import('./kit/assets/limits.js');
  const { rankRisks } = await import('./kit/assets/riskgrid.js');
  const data = structuredClone(describe('decisionmatrix').sample);
  delete data.scores.simple.speed;
  assert.equal(rankOptions(data).find((r) => r.id === 'simple').complete, false);
  const matrix = ASSETS.decisionmatrix(data);
  await Promise.resolve();
  assert.match(matrix.textContent, /—/);
  assert.match(matrix.textContent, /partial/);
  assert.deepEqual(sortSources([{ title: 'Unknown' }, { title: 'Secondary', kind: 'secondary', confidence: 0.5 }, { title: 'Primary', kind: 'primary', confidence: 0.5 }]).map((r) => r.title), ['Primary', 'Secondary', 'Unknown']);
  assert.deepEqual([59, 60, 84, 85].map(quotaTone), ['ok', 'warn', 'warn', 'danger']);
  const NOW = Date.parse('2026-01-01T00:00:00Z');
  assert.equal(resetDuration('2026-01-01T02:10:00Z', NOW), '2h 10m');
  assert.equal(resetDuration(NOW - 1, NOW), '0h 0m');
  const quota = ASSETS.limits({ windows: [{ label: 'Window', usedPct: 80, resetsAt: '2026-01-01T02:10:00Z' }] }, { now: NOW });
  await Promise.resolve();
  assert.match(quota.textContent, /reset 2h 10m/);
  const cost = ASSETS.limits(FLAT_LIMITS_SAMPLE);
  await Promise.resolve();
  assert.match(cost.textContent, /\$3\.22/);
  assert.equal(rankRisks(describe('riskgrid').sample.items)[0].label, 'Migration delay');
  const evidence = ASSETS.sources(describe('sources').sample);
  await Promise.resolve();
  const link = evidence.find((n) => n.tagName === 'A');
  assert.equal(link.textContent, 'example.com');
  assert.equal(link.getAttribute('href'), 'https://example.com/docs');
});

test('limits draws context-only, cost-only and exceeded spend readings', async () => {
  const CONTEXT_PCT = 85;
  const EXCEEDED_PCT = 125;
  const COST_USD = 0;
  const VALID_STATE = 'ok';
  const samples = [
    { data: { windows: [], context: { usedPct: CONTEXT_PCT } }, text: `${CONTEXT_PCT}%` },
    { data: { windows: [], cost: { amount: COST_USD, unit: 'USD' } }, text: `$${COST_USD.toFixed(2)}` },
    { data: { windows: [{ label: 'Spend limit', usedPct: EXCEEDED_PCT }] }, text: `${EXCEEDED_PCT}%` },
  ];
  for (const { data, text } of samples) {
    assert.doesNotThrow(() => validate('limits', data));
    const figure = ASSETS.limits(data);
    await Promise.resolve();
    assert.equal(figure.dataset.state, VALID_STATE);
    assert.ok(figure.textContent.includes(text), figure.textContent);
    figure.destroy();
  }
});

test('limits groups form a compact 2x2 grid when wide, stack when narrow and preserve customization', async () => {
  const SAMPLE_AT = Date.parse('2026-11-10T13:06:03.511Z');
  const TITLES = ['Claude', 'Codex', 'AGY Gemini shared', 'AGY Claude/GPT pool'];
  const GROUP_COUNT = TITLES.length;
  const WINDOW_COUNT = GROUP_COUNT * 2;
  const CLASS_GROUP = 'pa-limits-group';
  const CLASS_WINDOW = 'pa-limits-window';
  const CLASS_GRID = 'pa-limits-grid';
  const CLASS_GROUPS = 'pa-limits-groups';
  const WIDE_COLUMNS = 2;
  const CLASS_HEADLINE = 'pa-work-head';
  const classNodes = (figure, cls) => {
    const found = [];
    figure.find(n => { if ((n.getAttribute('class') ?? '').split(' ').includes(cls)) found.push(n); return false; });
    return found;
  };
  for (const width of TEST_WIDTHS) {
    Object.defineProperty(FakeNode.prototype, 'clientWidth', { get: () => width, configurable: true });
    const data = { ...structuredClone(describe('limits').sample), context: FLAT_LIMITS_SAMPLE.context, cost: FLAT_LIMITS_SAMPLE.cost };
    const figure = ASSETS.limits(data, { now: SAMPLE_AT, accent: 'c3', density: 'compact', labels: { fresh: 'current', stale: 'old', resetsIn: 'reset' } });
    await Promise.resolve();
    assert.equal(figure.dataset.state, 'ok');
    assert.equal(classNodes(figure, CLASS_GROUP).length, GROUP_COUNT);
    assert.equal(classNodes(figure, CLASS_WINDOW).length, WINDOW_COUNT);
    assert.equal(classNodes(figure, CLASS_HEADLINE).length, 0);
    assert.ok(TITLES.every(title => figure.textContent.includes(title)));
    assert.match(figure.textContent, /Claude · current/);
    assert.match(figure.textContent, /AGY Gemini shared · old/);
    assert.match(figure.textContent, /reset 2h 34m/);
    assert.match(figure.textContent, /Context 23% used/);
    assert.match(figure.textContent, /\$3\.22/);
    assert.equal(byClass(figure, 'pa-work').style.height, undefined);
    const groups = byClass(figure, CLASS_GROUPS);
    assert.equal(groups.getAttribute('data-narrow') !== null, width === TEST_WIDTHS[0]);
    assert.equal(groups.children.length, GROUP_COUNT);
    assert.equal(Math.ceil(groups.children.length / WIDE_COLUMNS), WIDE_COLUMNS, 'four wide cards make two rows');
    for (const grid of classNodes(figure, CLASS_GRID)) assert.equal(grid.getAttribute('data-narrow') !== null, width === TEST_WIDTHS[0]);
    const stale = figure.find(n => n.textContent === ' · old');
    assert.equal(stale.style.color, 'var(--ui-warn)');
    figure.update(data, { maxRows: ROW_LIMIT, labels: { more: 'remaining' } });
    assert.match(figure.textContent, /\+3 remaining/);
    assert.equal(classNodes(figure, CLASS_GROUP).length, ROW_LIMIT);
    figure.destroy();
  }
  const css = doc.documentElement.textContent;
  assert.match(css, /\.pa-limits-groups\s*\{[^}]*display:grid;[^}]*grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(css, /\.pa-limits-groups\[data-narrow\]\s*\{[^}]*grid-template-columns:minmax\(0,1fr\)/);
  assert.match(css, /\.pa-limits-grid\s*\{[^}]*grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  // Narrow tiles keep 5h and 7d side by side, each as label+percent over its bar, so four groups fit a short tile.
  assert.match(css, /\.pa-limits-grid\[data-narrow\] \.pa-limits-reading\s*\{[^}]*grid-template-columns:minmax\(0,1fr\) auto/);
  assert.doesNotMatch(css, /\.pa-limits-grid\[data-narrow\]\s*\{[^}]*grid-template-columns:minmax\(0,1fr\)\s*;/);
});

test('limits unavailable groups hide bars, round percentages, clamp bar widths and allow optional status', async () => {
  const PCT = 63.4;
  const EXCEEDED = 125;
  const NO_METERS = 0;
  const data = { groups: [
    { title: 'Claude', status: 'unavailable', windows: [{ label: '5h', usedPct: PCT }] },
    { title: 'Codex', windows: [{ label: '5h', usedPct: PCT, tone: 'info' }, { label: '7d', usedPct: EXCEEDED }] },
  ] };
  const figure = ASSETS.limits(data);
  await Promise.resolve();
  assert.match(figure.textContent, /Claude · unavailable/);
  assert.match(figure.textContent, /63%/);
  assert.doesNotMatch(figure.textContent, /63\.4%/);
  const unavailable = byClass(figure, 'pa-limits-group');
  assert.equal(unavailable.find(n => (n.getAttribute('class') ?? '').includes('pa-work-meter')) ?? NO_METERS, NO_METERS);
  const bar = figure.find(n => n.style.width === '100%');
  assert.ok(bar);
  assert.ok(figure.find(n => n.style.background === 'var(--ui-acc)'));
  figure.destroy();
  assert.throws(() => validate('limits', { groups: [{ title: 'Claude', status: 'unknown', windows: [] }] }), /data\.groups\[0\]\.status/);
  assert.throws(() => validate('limits', {}), /windows|groups/);
});

test('limits catalog sample is the complete four-group quota fixture without account metadata', () => {
  const QUOTA_PATH = join(HERE, '..', 'tests', 'fixtures', 'quota-sample.json');
  const raw = JSON.parse(readFileSync(QUOTA_PATH, 'utf8'));
  const generated = readFileSync(QUOTA_PATH.replace(/\.json$/, '.ts'), 'utf8').split('export const QUOTA_SAMPLE = ')[1];
  assert.deepEqual(JSON.parse(generated), raw, 'regenerate the TypeScript quota fixture from quota-sample.json');
  const providerRows = [raw.providers.claude, raw.providers.codex, raw.providers.gemini, raw.providers.gemini.models['claude-gpt']];
  const FIRST = 0;
  const NEXT = 1;
  const sample = describe('limits').sample;
  sample.groups.forEach((group, index) => {
    const source = providerRows[index];
    assert.deepEqual(group.windows.map(w => w.usedPct), [...source.windows].sort((a, b) => (a.windowMinutes ?? FIRST) - (b.windowMinutes ?? FIRST)).map(w => w.usedPct));
    assert.equal(group.windows[FIRST].label, '5h');
    assert.equal(group.windows[NEXT].label, '7d');
  });
  assert.doesNotMatch(JSON.stringify(sample), /source|observedAt|models|installed/);
});


test('limits renders the four threshold boundaries with the correct bar colours', async () => {
  const BOUNDARIES = [59, 60, 84, 85];
  const COLOURS = ['var(--ui-ok)', 'var(--ui-warn)', 'var(--ui-warn)', 'var(--ui-danger)'];
  for (const [index, usedPct] of BOUNDARIES.entries()) {
    const figure = ASSETS.limits({ groups: [{ title: 'Claude', windows: [{ label: '5h', usedPct }] }] });
    await Promise.resolve();
    const bar = figure.find(n => n.style.width === `${usedPct}%`);
    assert.equal(bar.style.background, COLOURS[index]);
    figure.destroy();
  }
});

const MEDIA_KINDS = Object.keys(MEDIA_SCHEMAS);
const MEDIA_LIST = { waveform: 'sections', shotlist: 'shots', easing: 'curves' };
const MEDIA_LABELS = { waveform: 'onsets', shotlist: 'shots', easing: 'curves' };
const MEDIA_BAD = { waveform: ['onsets', 0], shotlist: ['shots', 0, 'frames'], easing: ['curves', 1, 'params', 'power'] };
const MEDIA_CLASS = 'pa-media';
const MEDIA_TALL = 460;
const MEDIA_SHORT = 280;
const MIN_TEXT_PX = 12;
const PAYLOAD_BYTES = 12 * 1024;
const STATE_OK = 'ok';
const WRONG_VALUE = 'wrong';
const UPDATED_LABEL = 'Updated timing';
const countClass = (figure, cls) => figure.findAll((node) => (node.getAttribute('class') ?? '').split(' ').includes(cls)).length;
const allSvg = (figure) => figure.findAll((node) => node.tagName === 'SVG');
// Canvas text measurement is the only browser primitive used by SVG truncation.
const TEXT_GLYPH_PX = 8;
const makeElement = doc.createElement;
doc.createElement = (tag) => {
  const node = makeElement(tag);
  if (tag === 'canvas') node.getContext = () => ({ measureText: (text) => ({ width: text.length * TEXT_GLYPH_PX }) });
  return node;
};
Object.defineProperty(FakeNode.prototype, 'isConnected', { get() { return this === doc.body || Boolean(this.parentNode?.isConnected); }, configurable: true });

for (const kind of MEDIA_KINDS) {
  test(`${kind}: sample, wrong nested path, update and shared options at wide, narrow and short sizes`, async () => {
    const sample = structuredClone(describe(kind).sample);
    assert.doesNotThrow(() => validate(kind, sample));
    assert.ok(new TextEncoder().encode(JSON.stringify(sample)).length <= PAYLOAD_BYTES);
    const bad = structuredClone(sample);
    const path = MEDIA_BAD[kind];
    let parent = bad;
    path.slice(0, -1).forEach((key) => { parent = parent[key]; });
    parent[path.at(-1)] = WRONG_VALUE;
    const fieldPath = `data.${path.map((key) => typeof key === 'number' ? `[${key}]` : key).join('.').replace('.[', '[')}`;
    assert.throws(() => validate(kind, bad), (err) => err instanceof AssetError && err.message.includes(fieldPath));
    for (const [width, height] of [[TEST_WIDTHS[0], MEDIA_SHORT], [TEST_WIDTHS[1], MEDIA_TALL], [TEST_WIDTHS[1], MEDIA_SHORT]]) {
      Object.defineProperty(FakeNode.prototype, 'clientWidth', { get: () => width, configurable: true });
      const figure = ASSETS[kind](sample, { title: 'Timing title', caption: 'Timing caption', fs: TEST_FS, height, accent: 'c3', density: 'compact', labels: { [MEDIA_LABELS[kind]]: 'Custom timing', more: 'remaining' }, maxRows: ROW_LIMIT });
      doc.body.append(figure);
      await Promise.resolve();
      assert.equal(figure.dataset.state, STATE_OK);
      assert.match(figure.textContent, /Timing title/);
      assert.match(figure.textContent, /Timing caption/);
      assert.match(figure.textContent, /Custom timing/);
      assert.match(figure.textContent, /\+\d+ remaining/);
      const box = byClass(figure, 'pa-work');
      assert.equal(box, byClass(figure, MEDIA_CLASS));
      assert.equal(box.style['--work-accent'], 'var(--ui-c3)');
      assert.equal(box.style['--ui-fs'], `${TEST_FS}px`);
      assert.equal(box.getAttribute('data-density'), 'compact');
      assert.equal(box.style.height, `${height}px`);
      assert.equal(box.style.overflow, 'auto', 'overflow remains accessible in a short tile');
      assert.equal(box.hasAttribute('data-narrow'), width === TEST_WIDTHS[0] || height === MEDIA_SHORT);
      if (kind === 'shotlist') {
        const stacked = width === TEST_WIDTHS[0] || height === MEDIA_SHORT;
        assert.equal(countClass(figure, 'pa-shot-bar'), stacked ? 0 : ROW_LIMIT);
        assert.equal(countClass(figure, 'pa-work-row'), stacked ? ROW_LIMIT : 0);
      }
      assert.equal(box.getAttribute('data-motion'), 'static');
      for (const text of figure.findAll((node) => node.tagName === 'TEXT')) assert.ok(Number(text.getAttribute('font-size')) >= MIN_TEXT_PX);
      assert.ok(figure.find((node) => node.tagName === 'TITLE' || node.hasAttribute('title')), 'marks have hover titles');
      const next = structuredClone(sample);
      next[MEDIA_LIST[kind]][0].label = UPDATED_LABEL;
      const oldPlot = allSvg(figure)[0];
      figure.update(next, { maxRows: 40, density: 'comfortable' });
      assert.match(figure.textContent, /Updated timing/);
      assert.doesNotMatch(figure.textContent, /remaining/);
      assert.equal(byClass(figure, 'pa-work').getAttribute('data-density'), 'comfortable');
      if (oldPlot) assert.notEqual(allSvg(figure)[0], oldPlot, 'update rebuilds the plot');
      figure.update(bad);
      assert.equal(figure.dataset.state, 'error');
      assert.ok(figure.textContent.includes(fieldPath));
      figure.destroy();
      figure.remove();
    }
    const source = readFileSync(join(ASSET_DIR, `${kind}.js`), 'utf8');
    assert.doesNotMatch(source, /#[0-9a-f]{3,8}\b|rgba?\(/i);
    const css = doc.documentElement.textContent;
    assert.match(css, /data-theme="light"/);
    assert.match(css, /data-theme="dark"/);
    assert.match(css, /\.pa-media\[data-narrow\]/);
    assert.match(css, /font-size:max\(12px,var\(--ui-fs\)\)/);
  });
}

test('media host schemas accept all three samples and refuse bad nested fields with paths', () => {
  const source = readFileSync(join(HERE, '..', 'hooks', 'viz-schema.ts'), 'utf8');
  const compiled = stripTypeScriptTypes(source).replace(/^import .*\n/m, '').replaceAll('export ', '');
  const hostValidate = new Function('Invalid', 'isPlain', `${compiled}\nreturn validateVizData;`)(AssetError, (value) => value !== null && typeof value === 'object' && !Array.isArray(value));
  for (const kind of MEDIA_KINDS) {
    const sample = structuredClone(describe(kind).sample);
    hostValidate(sample, MEDIA_SCHEMAS[kind], 'frame.data');
    const bad = structuredClone(sample);
    const path = MEDIA_BAD[kind];
    let parent = bad;
    path.slice(0, -1).forEach((key) => { parent = parent[key]; });
    parent[path.at(-1)] = WRONG_VALUE;
    assert.throws(() => hostValidate(bad, MEDIA_SCHEMAS[kind], 'frame.data'), (error) => path.filter((key) => typeof key === 'string').every((key) => error.message.includes(key)));
    sample[MEDIA_LIST[kind]][0].unexpected = true;
    assert.throws(() => hostValidate(sample, MEDIA_SCHEMAS[kind], 'frame.data'), new RegExp(`frame\\.data\\.${MEDIA_LIST[kind]}\\[0\\]\\.unexpected`));
  }
  assert.throws(() => hostValidate({ ...describe('shotlist').sample, fps: 0 }, MEDIA_SCHEMAS.shotlist, 'frame.data'), /frame\.data\.fps/);
  const badBoolean = structuredClone(describe('shotlist').sample);
  badBoolean.shots[0].beatAligned = WRONG_VALUE;
  assert.throws(() => hostValidate(badBoolean, MEDIA_SCHEMAS.shotlist, 'frame.data'), /frame\.data\.shots\[0\]\.beatAligned/);
});

test('waveform: onset-only mode, median gap, bounds and supplied playhead', async () => {
  const ONSETS = [2, 0, 1, 0.5];
  const DURATION = 3;
  const PLAYHEAD = 1.25;
  const SAMPLE_LIMIT = 400;
  const figure = ASSETS.waveform({ durationS: DURATION, onsets: ONSETS });
  await Promise.resolve();
  assert.equal(countClass(figure, 'pa-wave-peak'), 0);
  assert.equal(countClass(figure, 'pa-wave-onset'), ONSETS.length);
  assert.equal(countClass(figure, 'pa-wave-playhead'), 0);
  assert.equal(medianGap(ONSETS), 0.5);
  assert.equal(medianGap([0]), null);
  assert.equal(medianGap([0, 1, 3]), 1.5);
  figure.update({ durationS: DURATION, onsets: [], playheadS: PLAYHEAD, peaks: [0, 1] });
  assert.equal(countClass(figure, 'pa-wave-playhead'), 1);
  assert.equal(countClass(figure, 'pa-wave-peak'), 2);
  assert.match(figure.textContent, /1\.25 s/);
  for (const [data, path] of [
    [{ durationS: 0, onsets: [] }, /data\.durationS/],
    [{ durationS: DURATION, onsets: [DURATION + 1] }, /data\.onsets\[0\]/],
    [{ durationS: DURATION, onsets: [], peaks: [1.1] }, /data\.peaks\[0\]/],
    [{ durationS: DURATION, onsets: [], peaks: Array(SAMPLE_LIMIT + 1).fill(0) }, /data\.peaks/],
    [{ durationS: DURATION, onsets: [], playheadS: DURATION + 1 }, /data\.playheadS/],
    [{ durationS: DURATION, onsets: [], sections: [{ label: 'Reverse', fromS: 2, toS: 1 }] }, /data\.sections\[0\]\.toS/],
  ]) assert.throws(() => validate('waveform', data), path);
  figure.destroy();
});

test('shotlist: tool grouping, duration and beat mismatch use frame data', async () => {
  Object.defineProperty(FakeNode.prototype, 'clientWidth', { get: () => TEST_WIDTHS[1], configurable: true });
  const sample = structuredClone(describe('shotlist').sample);
  assert.deepEqual(groupedShots(sample.shots).map((shot) => shot.id), ['opening', 'closing', 'detail']);
  assert.equal(shotEnd(sample.shots), 120);
  sample.shots.at(-1).beatAligned = true;
  const figure = ASSETS.shotlist(sample);
  await Promise.resolve();
  assert.equal(countClass(figure, 'pa-shot-bar'), sample.shots.length);
  assert.equal(countClass(figure, 'pa-shot-offbeat'), 1, 'actual beat list overrides alignment annotation');
  assert.match(figure.textContent, /120 fr/);
  assert.match(figure.textContent, /5 s/);
  delete sample.beatsAtFrames;
  figure.update(sample);
  assert.equal(countClass(figure, 'pa-shot-offbeat'), 0);
  sample.beatsAtFrames = [];
  figure.update(sample);
  assert.equal(countClass(figure, 'pa-shot-offbeat'), sample.shots.length);
  const bad = structuredClone(sample);
  bad.shots[0].frames = 1.5;
  assert.throws(() => validate('shotlist', bad), /data\.shots\[0\]\.frames/);
  bad.shots[0].frames = 1;
  bad.shots[1].id = bad.shots[0].id;
  assert.throws(() => validate('shotlist', bad), /data\.shots\[1\]\.id/);
  figure.destroy();
});

test('easing: pure endpoints, monotonic curves, spring overshoot and velocity units', () => {
  const SAMPLE_STEPS = 1000;
  const SECOND_MS = 1000;
  const EPSILON = 1e-9;
  for (const kind of CURVE_KINDS) {
    assert.equal(easingAt(kind, 0), 0, kind);
    assert.equal(easingAt(kind, 1), 1, kind);
    assert.equal(easingAt(kind, -1), 0, kind);
    assert.equal(easingAt(kind, 2), 1, kind);
    let previous = 0;
    for (let i = 1; i <= SAMPLE_STEPS; i++) {
      const value = easingAt(kind, i / SAMPLE_STEPS);
      assert.ok(Number.isFinite(value), kind);
      if (!['spring', 'bounce'].includes(kind)) assert.ok(value + EPSILON >= previous, kind);
      previous = value;
    }
  }
  const spring = describe('easing').sample.curves.find((curve) => curve.kind === 'spring');
  assert.ok(Math.max(...Array.from({ length: SAMPLE_STEPS }, (_, i) => easingAt(spring.kind, i / SAMPLE_STEPS, spring.params))) > 1);
  assert.ok(Math.abs(velocityPeak({ kind: 'linear' }, SECOND_MS) - 1) < EPSILON);
  assert.ok(Math.abs(velocityPeak({ kind: 'linear' }, SECOND_MS * 2) - 0.5) < EPSILON);
  assert.equal(velocityPeak({ kind: 'steps' }, SECOND_MS), Infinity);
  assert.throws(() => validate('easing', { durationMs: SECOND_MS, curves: [{ label: 'Bad', kind: 'spring', params: { power: 2 } }] }), /data\.curves\[0\]\.params\.power/);
  assert.throws(() => validate('easing', { ...describe('easing').sample, markers: [{ label: 'Late', atMs: 9000 }] }), /data\.markers\[0\]\.atMs/);
});

test('media: reduced motion schedules nothing; detach and destroy leave no pending animation', async () => {
  const callbacks = new Map();
  let nextId = 0;
  const originalRaf = globalThis.requestAnimationFrame;
  const originalCancel = globalThis.cancelAnimationFrame;
  const originalMedia = globalThis.matchMedia;
  const advance = (now) => { const pending = [...callbacks.values()]; callbacks.clear(); pending.forEach((fn) => fn(now)); };
  globalThis.requestAnimationFrame = (fn) => { callbacks.set(++nextId, fn); return nextId; };
  globalThis.cancelAnimationFrame = (id) => callbacks.delete(id);
  const START_MS = 0;
  const MID_MS = 800;
  const END_MS = 1600;
  try {
    globalThis.matchMedia = () => ({ matches: true });
    for (const kind of MEDIA_KINDS) {
      const figure = ASSETS[kind](describe(kind).sample);
      doc.body.append(figure);
      await Promise.resolve();
      assert.equal(callbacks.size, 0, `${kind} reduced-motion path`);
      if (kind === 'easing') {
        const finalXs = figure.findAll((n) => n.getAttribute('class') === 'pa-easing-dot').map((n) => n.getAttribute('cx'));
        assert.equal(new Set(finalXs).size, 1, 'all reduced-motion dots finish together');
        const endLabel = figure.find((node) => node.tagName === 'TEXT' && node.textContent === `${describe(kind).sample.durationMs} ms`);
        assert.equal(finalXs[0], endLabel.getAttribute('x'), 'reduced-motion dots are at the final time');
      }
      figure.remove();
      figure.destroy();
      assert.equal(callbacks.size, 0, `${kind} detach cleanup`);
    }
    globalThis.matchMedia = () => ({ matches: false });
    for (const kind of MEDIA_KINDS.filter((name) => name !== 'easing')) {
      const figure = ASSETS[kind](describe(kind).sample);
      doc.body.append(figure);
      await Promise.resolve();
      assert.equal(callbacks.size, 0, `${kind} never starts an autoplay loop`);
      figure.remove();
      figure.destroy();
      assert.equal(callbacks.size, 0, `${kind} detached without pending work`);
    }
    const makeEasing = async () => {
      const figure = ASSETS.easing(describe('easing').sample);
      doc.body.append(figure);
      await Promise.resolve();
      return figure;
    };
    const figure = await makeEasing();
    assert.equal(callbacks.size, 1);
    advance(START_MS);
    const first = byClass(figure, 'pa-easing-dot').getAttribute('cx');
    advance(MID_MS);
    assert.notEqual(byClass(figure, 'pa-easing-dot').getAttribute('cx'), first);
    advance(END_MS);
    assert.equal(callbacks.size, 0, 'one pass finishes without looping');
    figure.update(describe('easing').sample);
    assert.equal(callbacks.size, 0, 'updates do not replay');
    figure.destroy();
    figure.remove();
    const detached = await makeEasing();
    detached.remove();
    advance(START_MS);
    assert.equal(callbacks.size, 0, 'detachment stops the pass on the next frame');
    detached.destroy();
    const destroyed = await makeEasing();
    destroyed.destroy();
    assert.equal(callbacks.size, 0, 'destroy cancels an in-flight pass');
    destroyed.remove();
    const switched = await makeEasing();
    globalThis.matchMedia = () => ({ matches: true });
    advance(START_MS);
    assert.equal(callbacks.size, 0, 'a reduced-motion change stops the pass');
    switched.destroy();
    switched.remove();
  } finally {
    globalThis.requestAnimationFrame = originalRaf;
    globalThis.cancelAnimationFrame = originalCancel;
    globalThis.matchMedia = originalMedia;
  }
});

const SESSION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const board = (item) => ({ columns: [{ id: 'waiting', title: 'Needs you', items: [item] }] });

test('statusboard: an item may carry `open` (a safe id) and nothing else unsafe passes; items without it are unchanged', () => {
  assert.equal(validate('statusboard', board({ title: 'A', open: SESSION_ID })).columns[0].items[0].open, SESSION_ID);
  assert.equal(validate('statusboard', board({ title: 'A' })).columns[0].items[0].open, undefined);
  for (const bad of ['a b', '../x', 'a/b', '', 'x'.repeat(65), 5, {}]) {
    assert.throws(() => validate('statusboard', board({ title: 'A', open: bad })), /open/, JSON.stringify(bad));
  }
});

test('statusboard: a card with `open` asks the page to open that session: session-open {id, title, state = its column}; no id, no request', () => {
  const it = validate('statusboard', board({ title: 'Fix login', open: SESSION_ID })).columns[0].items[0];
  assert.deepEqual(openRequest({ id: 'waiting' }, it), { name: 'session-open', data: { id: SESSION_ID, title: 'Fix login', state: 'waiting' } });
  assert.equal(openRequest({ id: 'waiting' }, { title: 'x' }), null);
});
