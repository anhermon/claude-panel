// kind-meta.test.mjs - the page's KIND_META (kind-meta.mjs) is the mod's (hooks/work-kinds.ts): same kinds, labels, letters, glyphs, colors, headlines.
// The mod's table is read as text (a .ts file) so the test needs no TypeScript loader.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { KIND_IDS, KIND_META, WORK_KIND_IDS, kindMeta, kindOfLetter } from './kind-meta.mjs';

const MOD_SOURCE = readFileSync(new URL('../../../hooks/work-kinds.ts', import.meta.url), 'utf8');
const ROW = /^\s{2}(\w+): \{ label: '([^']+)', letter: '(\w)', glyph: '(.)', color: '(#[0-9a-f]{6})', headline: '([^']+)' \},?$/gmu;

const modRows = () => [...MOD_SOURCE.matchAll(ROW)].map((m) => [m[1], { label: m[2], letter: m[3], glyph: m[4], color: m[5], headline: m[6] }]);

test('the page table has the same kinds, in the same order, with the same fields as the mod table', () => {
  const rows = modRows();
  assert.equal(rows.length, KIND_IDS.length, 'every row of hooks/work-kinds.ts KIND_META was read');
  assert.deepEqual(rows.map(([k]) => k), [...KIND_IDS]);
  for (const [kind, meta] of rows) assert.deepEqual({ ...KIND_META[kind] }, meta, kind);
});

test('the work kinds are the kinds a call can have, and letters map back', () => {
  assert.deepEqual([...WORK_KIND_IDS], ['ui', 'logic', 'tests', 'visual', 'docs', 'research', 'reading', 'delegating', 'working']);
  for (const k of KIND_IDS) assert.equal(kindOfLetter(KIND_META[k].letter), k);
  assert.equal(kindOfLetter('.'), 'none');
  assert.equal(kindMeta('nope'), KIND_META.working);
});
