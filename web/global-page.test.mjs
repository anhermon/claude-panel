import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = join(dirname(fileURLToPath(import.meta.url)), 'global');
const js = readFileSync(join(here, 'global.js'), 'utf8');
const css = readFileSync(join(here, 'global.css'), 'utf8');

test('the page builds its DOM from text nodes only: no html sinks, no eval, no inline styles', () => {
  for (const sink of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(', 'new Function', 'setAttribute(\'style\'', 'srcdoc']) assert.ok(!js.includes(sink), sink);
});

test('a link gets an href only through the absolute http(s) check, with target and rel forced', () => {
  assert.match(js, /\^https\?:\\\/\\\/\[\^\/\\s\]/);
  assert.match(js, /a\.target = '_blank'/);
  assert.match(js, /a\.rel = 'noopener noreferrer'/);
  assert.equal((js.match(/\.href = /g) ?? []).length, 1);
});

test('the page polls state.json every 3 to 5 seconds and keeps the expanded cards across redraws', () => {
  const ms = Number(/POLL_MS = (\d+)/.exec(js)[1]);
  assert.ok(ms >= 3000 && ms <= 5000, String(ms));
  assert.match(js, /fetch\('state\.json'/);
  assert.match(js, /open\.has\(s\.id\)/);
});

test('Needs you puts live items first and folds the ended sessions\' items into a closed group of at most 10', () => {
  assert.match(js, /From ended sessions \(\$\{endedNeeds\.length\}\)/);
  assert.match(js, /ENDED_NEEDS_MAX = 10/);
  assert.match(js, /ended\.open = endedOpen\.value/);
  assert.match(js, /filter\(\(n\) => n !== null\)/); // replaceChildren would print a null as text
});

test('the css stays inside the CSP (no url(), no @import) and reads at 1920 px and on a phone', () => {
  assert.ok(!/url\(|@import/.test(css));
  assert.match(css, /@media \(min-width: 1800px\)/);
  assert.match(css, /@media \(max-width: 700px\)/);
});
