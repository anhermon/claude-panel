import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { eventsFromRows, pageOf, readEvents } from './detail.mjs';
import { assistantRow, cfgFor, FAKE_KEY, jl, mkTmp, sampleRows, toolResult } from './fixtures.mjs';
import { fleetConfig } from './config.mjs';

const NOW = Date.parse('2026-11-08T12:00:00Z');
const cfg = { ...fleetConfig({}), ...cfgFor() };

test('events are readable, masked, and tool results attach to their call', () => {
  const events = eventsFromRows(sampleRows(NOW), cfg);
  const kinds = events.map((e) => e.t);
  assert.deepEqual(kinds.slice(0, 3), ['user', 'say', 'tool']);
  const bash = events.find((e) => e.name === 'Bash');
  assert.equal(bash.done, true);
  assert.match(bash.error, /FAIL 3 tests/);
  assert.equal(bash.kind, 'tests');
  assert.ok(events.some((e) => e.t === 'turn' && e.ms === 33_000));
  const dump = JSON.stringify(events);
  assert.ok(!dump.includes(FAKE_KEY) && !dump.includes('hunter22secret'), 'secret in events');
  assert.ok(dump.includes('onerror'), 'markup text is kept as text (the page escapes it)');
  assert.deepEqual(events.map((e) => e.i), events.map((_, i) => i));
});

test('thinking blocks and successful output are not kept', () => {
  const rows = [assistantRow([{ type: 'thinking', thinking: 'secret reasoning' }, { type: 'text', text: 'ok' }], NOW), toolResult('x', 'SUCCESS OUTPUT BODY', false, NOW)];
  const dump = JSON.stringify(eventsFromRows(rows, cfg));
  assert.ok(!dump.includes('secret reasoning') && !dump.includes('SUCCESS OUTPUT BODY'));
});

test('pageOf pages newest first and reports the next cursor', () => {
  const events = Array.from({ length: 70 }, (_, i) => ({ i }));
  const p1 = pageOf(events, undefined, 30);
  assert.equal(p1.events[0].i, 69);
  assert.equal(p1.events.length, 30);
  assert.equal(p1.next, 40);
  const p3 = pageOf(events, 10, 30);
  assert.equal(p3.events.length, 10);
  assert.equal(p3.next, null);
});

test('readEvents reads the tail of a big file and caches by size+mtime', () => {
  const dir = mkTmp();
  const file = path.join(dir, 's.jsonl');
  fs.writeFileSync(file, `${'x'.repeat(200_000)}\n${jl(sampleRows(NOW))}`);
  const small = { ...cfg, detailBytes: 50_000 };
  const a = readEvents(file, small);
  assert.equal(a.isPartial, true);
  assert.ok(a.events.length > 3);
  assert.equal(readEvents(file, small), a);
});
