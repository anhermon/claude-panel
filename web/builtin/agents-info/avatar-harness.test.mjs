import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_HARNESS, HARNESS, harnessInfo, harnessLine, harnessOf, unknownHue } from './avatar-harness.mjs';
import { CHARACTERS, CODEX_COLOR } from './mascot-grid.mjs';

test('the three known harnesses map from models, worker roles and the harness field', () => {
  for (const m of ['claude-sonnet-5-5', 'haiku', 'opus', 'sonnet']) assert.equal(harnessOf({ model: m }), 'claude', m);
  for (const m of ['gpt-6.1-sol', 'gpt-5-codex', 'o3', 'o4-mini', 'codex']) assert.equal(harnessOf({ model: m }), 'codex', m);
  for (const m of ['gemini-2.5-pro', 'agy']) assert.equal(harnessOf({ model: m }), 'agy', m);
  assert.equal(harnessOf({ role: 'codex-worker' }), 'codex');
  assert.equal(harnessOf({ role: 'agy-worker' }), 'agy');
  assert.equal(harnessOf({ harness: 'Codex' }), 'codex');
  assert.equal(harnessOf({ ticket: { harness: 'agy' } }), 'agy');
  assert.equal(harnessOf({ harness: 'claude', model: 'gpt-6' }), 'claude', 'an explicit harness wins over the model');
});

test('nothing known: claude, the session itself', () => {
  assert.equal(harnessOf({}), DEFAULT_HARNESS);
  assert.equal(harnessOf({ model: 'mystery-1', role: 'worker' }), 'claude');
  assert.equal(harnessOf(null), 'claude');
});

test('known harnesses have their own character and colour', () => {
  const infos = ['claude', 'codex', 'agy'].map(harnessInfo);
  assert.equal(infos[0].character, CHARACTERS.claude);
  assert.equal(infos[1].character, CHARACTERS.codex);
  assert.equal(infos[2].character, CHARACTERS.agy);
  assert.equal(new Set(infos.map((i) => i.color)).size, 3);
  assert.equal(HARNESS.claude.color, '#D97757');
  assert.equal(HARNESS.codex.color, CODEX_COLOR);
  assert.equal(CODEX_COLOR, '#5B7BE8');
  assert.notEqual(HARNESS.codex.color.toLowerCase(), HARNESS.claude.color.toLowerCase());
});

test('an unknown harness falls back deterministically to the generic character; different names give different hues', () => {
  assert.equal(harnessOf({ harness: 'OpenCode' }), 'opencode');
  const a = harnessInfo('opencode');
  assert.equal(a.character, CHARACTERS.generic);
  assert.deepEqual(harnessInfo('opencode'), a);
  assert.match(a.color, /^#[0-9a-f]{6}$/);
  assert.equal(a.label, 'Opencode');
  const hues = ['opencode', 'mistral', 'aider', 'qwen', 'cursor', 'zed'].map(unknownHue);
  assert.equal(new Set(hues.map((h) => Math.round(h))).size, hues.length);
  for (const h of hues) for (const k of [16, 225, 247]) {
    const d = Math.abs(((h - k + 540) % 360) - 180);
    assert.ok(d >= 30, `${h} is too near ${k}`);
  }
  assert.notEqual(harnessInfo('opencode').color, harnessInfo('mistral').color);
});

test('harnessLine reads "Harness · model · effort" without ids', () => {
  assert.equal(harnessLine({ model: 'gpt-6.1-sol', effort: 'high' }), 'Codex · gpt-6.1-sol · high');
  assert.equal(harnessLine({}), 'Claude');
  assert.equal(harnessLine({ harness: 'aider', model: 'x1' }), 'Aider · x1');
});
