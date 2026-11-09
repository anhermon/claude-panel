// The mod (hooks/agent-controls.ts) and the page (agents-info.js) name the host messages separately; this pins the two together.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const NAME = /export const (HOST_OPEN|HOST_TAB|HOST_CLOSE) = '([a-z-]+)'/g;

test('the page listens for the three host messages the mod sends', () => {
  const sent = [...read('../../../hooks/agent-controls.ts').matchAll(NAME)].map((m) => m[2]);
  assert.equal(sent.length, 3);
  const page = read('./agents-info.js');
  for (const name of sent) assert.match(page, new RegExp(`= '${name}';`), name);
});

test('the workspace page hands a host command to the scene iframe', () => {
  const src = read('../workspace/workspace.js');
  assert.match(src, /window\.PanelWorkspace = Object\.freeze\(\{ hostCommand: hostCommand \}\)/);
  assert.match(src, /postMessage\(\{ type: HOST_TYPE, name: name, data: data \}/);
});
