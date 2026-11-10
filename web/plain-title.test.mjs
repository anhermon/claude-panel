import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';
import vm from 'node:vm';
import { plainTitle } from './kit/panel/plain-title.mjs';

const CANONICAL_URL = new URL('../hooks/agent-names.ts', import.meta.url);
const source = readFileSync(CANONICAL_URL, 'utf8').replace(/^import .*\n/gm, '');
const compiled = stripTypeScriptTypes(source);
const canonical = await import(`data:text/javascript,${encodeURIComponent(compiled)}`);
const classicContext = { globalThis: {} }
vm.createContext(classicContext)
vm.runInContext(readFileSync(new URL('./plain-title.js', import.meta.url), 'utf8'), classicContext)
const classic = classicContext.globalThis.PanelTitles ?? vm.runInContext('globalThis.PanelTitles', classicContext)
const LONG_REPEATS = 30;
const INPUTS = [
  'T63', 'T50: workflow-insight frame', '01-slug-name', 'Ticket: T7',
  'Plain task title', '', '  \n\t ', 'A long task title '.repeat(LONG_REPEATS),
  'Tests for T65 fixes', 'Review T63, then T65', 'Test', 'T-shirt', 'T5000-hour',
  't7 - fix lanes (sonnet/low)', 'Worker 01-slug-name and T50: checks',
];
for (const input of INPUTS) test(`plainTitle parity: ${JSON.stringify(input)}`, () => {
  for (const capitalise of [true, false]) {
    assert.equal(plainTitle(input, capitalise), canonical.plainTitle(input, capitalise));
    assert.equal(classic.plainTitle(input, capitalise), canonical.plainTitle(input, capitalise));
  }
});

test('the scene module imports nothing from outside the kit (sandboxed scenes cannot load top-level pages)', () => {
  assert.doesNotMatch(readFileSync(new URL('./kit/panel/plain-title.mjs', import.meta.url), 'utf8'), /^import\s/m);
});
