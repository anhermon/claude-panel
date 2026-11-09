import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { bucketList, newTracker, pendingTool, pollFile } from './transcript.mjs';
import { assistantRow, cfgFor, FAKE_KEY, jl, mkTmp, newCounters, sampleRows, toolUse, userRow } from './fixtures.mjs';

const NOW = Date.parse('2026-11-08T12:00:00Z');

test('folds a sample transcript: title, prompt, tokens once per message id, tools, errors, turns, odd rows', () => {
  const dir = mkTmp();
  const file = path.join(dir, 's.jsonl');
  fs.writeFileSync(file, jl(sampleRows(NOW)));
  const tr = newTracker(file);
  const c = newCounters();
  assert.equal(pollFile(tr, cfgFor(), c), true);
  const a = tr.acc;
  assert.equal(a.title, 'Fix the flaky login test');
  assert.equal(a.model, 'claude-test-1');
  assert.equal(a.usage.out, 20 + 7 + 20); // msg_1 split over two rows counts once; msg_3 uses the default usage
  assert.equal(a.tools.total, 3);
  assert.deepEqual(a.tools.byName, { Read: 1, Bash: 1, Edit: 1 });
  assert.equal(a.tools.byKind.tests, 1);
  assert.equal(a.errors, 1);
  assert.equal(a.lastError, 'FAIL 3 tests');
  assert.equal(a.turns.count, 1);
  assert.equal(a.turns.lastMs, 33_000);
  assert.equal(a.unparsed, 1);
  assert.deepEqual(a.unknownTypes, { 'brand-new-row-type': 1 });
  assert.equal(pendingTool(a).name, 'Edit'); // tu_3 never answered
  assert.ok(bucketList(a).length >= 1);
});

test('secrets never reach the accumulator', () => {
  const dir = mkTmp();
  const file = path.join(dir, 's.jsonl');
  fs.writeFileSync(file, jl(sampleRows(NOW)));
  const tr = newTracker(file);
  pollFile(tr, cfgFor(), newCounters());
  const dump = JSON.stringify([tr.acc, [...tr.acc.pending.values()]]);
  assert.ok(!dump.includes(FAKE_KEY) && !dump.includes('hunter22secret'), dump);
  assert.ok(tr.acc.pending.size === 1 && !tr.acc.lastPrompt.includes('hunter22'));
});

test('a cut-off last line is carried and counted once when completed', () => {
  const dir = mkTmp();
  const file = path.join(dir, 's.jsonl');
  const row = JSON.stringify(assistantRow([toolUse('tu_9', 'Read', { file_path: '/a/b.ts' })], NOW, { id: 'msg_9' }));
  fs.writeFileSync(file, `${JSON.stringify(userRow('hi', NOW))}\n${row.slice(0, 40)}`);
  const tr = newTracker(file);
  const c = newCounters();
  pollFile(tr, cfgFor(), c);
  assert.equal(tr.acc.unparsed, 0);
  assert.equal(tr.acc.tools.total, 0);
  fs.appendFileSync(file, `${row.slice(40)}\n`);
  pollFile(tr, cfgFor(), c);
  assert.equal(tr.acc.unparsed, 0);
  assert.equal(tr.acc.tools.total, 1);
  assert.equal(pollFile(tr, cfgFor(), c), false); // unchanged: gated, nothing read
});

test('a giant file is read from its tail only, and a poll never reads more than tailBytes', () => {
  const dir = mkTmp();
  const file = path.join(dir, 'giant.jsonl');
  const GIANT = 3 * 1024 * 1024 * 1024;
  const fd = fs.openSync(file, 'w');
  fs.ftruncateSync(fd, GIANT); // sparse: no disk used
  fs.writeSync(fd, `\n${jl([{ type: 'ai-title', aiTitle: 'Tail title' }, assistantRow([{ type: 'text', text: 'hi' }], NOW)])}`, GIANT);
  fs.closeSync(fd);
  const tr = newTracker(file);
  const c = newCounters();
  const t0 = Date.now();
  pollFile(tr, cfgFor({ tailBytes: 64 * 1024 }), c);
  assert.ok(Date.now() - t0 < 2000);
  assert.ok(c.bytesRead <= 64 * 1024);
  assert.equal(tr.acc.title, 'Tail title');
});

test('rewritten (shrunk) files start over; missing files report an error and do not throw', () => {
  const dir = mkTmp();
  const file = path.join(dir, 's.jsonl');
  fs.writeFileSync(file, jl(sampleRows(NOW)));
  const tr = newTracker(file);
  pollFile(tr, cfgFor(), newCounters());
  fs.writeFileSync(file, jl([{ type: 'ai-title', aiTitle: 'Fresh' }]));
  pollFile(tr, cfgFor(), newCounters());
  assert.equal(tr.acc.title, 'Fresh');
  assert.equal(tr.acc.tools.total, 0);
  assert.equal(tr.resets, 1);
  const gone = newTracker(path.join(dir, 'nope.jsonl'));
  assert.equal(pollFile(gone, cfgFor(), newCounters()), false);
  assert.equal(gone.error, 'ENOENT');
});

test('huge api-request rows are skipped without parsing', () => {
  const dir = mkTmp();
  const file = path.join(dir, 's.jsonl');
  fs.writeFileSync(file, jl([`{"type":"api-request","params":"${'x'.repeat(100_000)}"}`, { type: 'ai-title', aiTitle: 'T' }]));
  const tr = newTracker(file);
  const c = newCounters();
  pollFile(tr, cfgFor(), c);
  assert.equal(c.rowsSkipped, 1);
  assert.equal(tr.acc.title, 'T');
});
