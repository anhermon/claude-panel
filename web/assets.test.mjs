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
