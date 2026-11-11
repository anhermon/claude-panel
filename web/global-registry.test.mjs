import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isAlive, mergeLive, normalizeEntry, parsePs, readRegistry } from './global/registry.mjs';

const SID_A = '11111111-1111-4111-8111-111111111111';
const SID_B = '22222222-2222-4222-8222-222222222222';
const SID_C = '33333333-3333-4333-8333-333333333333';
const PS = [
  ' 100     1 Thu Nov  5 09:34:30 2026 /Users/u/.local/bin/claude --session-id ' + SID_A + ' --settings {"token":"sk-test-abcdefghijklmnop"}',
  ' 200     1 Mon Nov  2 22:39:05 2026 claude --resume ' + SID_B,
  ' 201     1 Mon Nov  2 22:39:05 2026 /Applications/Claude.app/Contents/Helpers/disclaimer --pgroup -- /x/claude --resume ' + SID_C,
  ' 300     1 Mon Nov  2 22:39:05 2026 /Users/u/.local/bin/claude plugin test .',
  ' 400     1 Mon Nov  2 22:39:05 2026 /bin/zsh -c something claude',
  'garbage line',
].join('\n');

test('parsePs finds claude processes, skips wrappers, subcommands and shells; never keeps arguments', () => {
  const p = parsePs(PS);
  assert.equal(p.get(100).sessionId, SID_A);
  assert.equal(p.get(200).sessionId, SID_B);
  assert.equal(p.get(201).isClaude, false); // the disclaimer wrapper
  assert.equal(p.get(300).isClaude, false); // claude plugin ...
  assert.equal(p.get(400).isClaude, false);
  assert.ok(!JSON.stringify([...p.values()]).includes('sk-test'));
});

test('isAlive needs the pid and a matching start time (UTC or local reading)', () => {
  const p = parsePs(PS);
  const base = { pid: 100, sessionId: SID_A };
  const tz = (d) => d.toUTCString().replace(/^(\w+), (\d+) (\w+) (\d+) ([\d:]+) GMT$/, '$1 $3 $2 $5 $4');
  const asUtc = tz(new Date(Date.parse('Thu Nov  5 09:34:30 2026')));
  assert.equal(isAlive({ ...base, procStart: 'Thu Nov  5 09:34:30 2026' }, p, 2000), true); // local reading
  assert.equal(isAlive({ ...base, procStart: asUtc }, p, 2000), true); // UTC reading
  assert.equal(isAlive({ ...base, procStart: 'Thu Nov  5 09:34:40 2026' }, p, 2000), false); // recycled pid
  assert.equal(isAlive({ pid: 999, sessionId: SID_A, procStart: null }, p, 2000), false); // dead pid
  assert.equal(isAlive({ ...base, procStart: null }, p, 2000), true);
});

test('mergeLive: dead registry entries are stale, ps-only processes are live, ps failure is unverified', () => {
  const p = parsePs(PS);
  const entries = [
    normalizeEntry({ pid: 100, sessionId: SID_A, procStart: 'Thu Nov  5 09:34:30 2026', status: 'busy', entrypoint: 'cli', cwd: '/x' }),
    normalizeEntry({ pid: 555, sessionId: SID_C, procStart: 'Thu Nov  5 09:34:30 2026' }),
  ];
  const live = mergeLive(entries, p, 2000);
  assert.deepEqual([...live.keys()].sort(), [SID_A, SID_B].sort());
  assert.equal(live.get(SID_B).source, 'ps');
  assert.ok(!live.has(SID_C)); // dead pid: stale
  assert.equal(mergeLive(entries, null, 2000).size, 2); // ps failed: both registry entries, unverified
  assert.equal(mergeLive(entries, null, 2000).get(SID_A).unverified, true);
});

test('mergeLive: a process whose registry entry names another session (switched in place) is one live session, not two', () => {
  const lstart = 'Thu Nov  5 09:34:30 2026';
  const p = parsePs(` 100     1 ${lstart} /x/bin/claude --session-id ${SID_B}`); // started as B
  const entries = [normalizeEntry({ pid: 100, sessionId: SID_A, procStart: lstart })]; // now runs A
  const live = mergeLive(entries, p, 2000);
  assert.deepEqual([...live.keys()], [SID_A]);
});

test('readRegistry: invalid and missing json skipped, .key files never opened, files re-read only when they change', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'global-reg-'));
  fs.writeFileSync(path.join(dir, '100.json'), JSON.stringify({ pid: 100, sessionId: SID_A, status: 'weird', messagingSocketPath: '/tmp/x.sock', extra: 1 }));
  fs.writeFileSync(path.join(dir, '101.json'), '{ not json');
  fs.writeFileSync(path.join(dir, '102.json'), JSON.stringify({ pid: 'x' }));
  fs.writeFileSync(path.join(dir, '100.abcdef.key'), 'SECRET-PEER-TOKEN');
  const cache = new Map();
  const got = await readRegistry(dir, cache);
  assert.equal(got.length, 1);
  assert.equal(got[0].status, null);
  assert.ok(!('messagingSocketPath' in got[0]));
  assert.ok(![...cache.keys()].some((k) => k.endsWith('.key')));
  assert.ok(!JSON.stringify([...cache.values()]).includes('SECRET-PEER-TOKEN'));
  assert.deepEqual(await readRegistry(path.join(dir, 'nope')), []);
  fs.rmSync(dir, { recursive: true, force: true });
});
