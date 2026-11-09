import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fleetConfig } from './config.mjs';
import { createFeed } from './feed.mjs';
import { parsePs } from './registry.mjs';
import { assistantRow, FAKE_KEY, jl, mkTmp, sampleRows, SID, toolUse, userRow } from './fixtures.mjs';

const NOW = Date.now();
const ago = (ms) => new Date(NOW - ms);
const MIN = 60_000;
const HOUR = 60 * MIN;
const LSTART = 'Thu Nov  5 09:34:30 2026';

function world() {
  const root = mkTmp('fleet-feed-');
  const cfg = fleetConfig({ HOME: root, CLAUDE_CONFIG_DIR: path.join(root, '.claude'), CLAUDE_FLEET_DIR: path.join(root, 'state'), CLAUDE_FLEET_DISCOVER_EVERY_MS: '1', CLAUDE_FLEET_PS_EVERY_MS: '1' });
  fs.mkdirSync(cfg.sessionsDir, { recursive: true });
  const transcript = (slug, sid, rows, mtimeAgo) => {
    const dir = path.join(cfg.projectsDir, slug);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${sid}.jsonl`);
    fs.writeFileSync(file, typeof rows === 'string' ? rows : jl(rows));
    fs.utimesSync(file, ago(mtimeAgo), ago(mtimeAgo));
    return file;
  };
  const registry = (pid, sid, extra = {}) => fs.writeFileSync(path.join(cfg.sessionsDir, `${pid}.json`), JSON.stringify({ pid, sessionId: sid, cwd: '/Users/alice/proj', procStart: LSTART, entrypoint: 'cli', status: 'idle', ...extra }));
  return { root, cfg, transcript, registry };
}

const psTable = (lines) => async () => parsePs(lines.join('\n'));

test('groups, liveness, window, subagents and masking over a synthetic machine', async () => {
  const w = world();
  w.transcript('-Users-alice-proj', SID.A, sampleRows(NOW), 5_000); // live, busy, fresh
  w.registry(100, SID.A, { status: 'busy' });
  w.transcript('-Users-alice-proj', SID.B, [{ type: 'ai-title', aiTitle: 'Old and gone' }], 2 * HOUR); // registry pid dead
  w.registry(101, SID.B);
  w.transcript('-Users-alice-other', SID.C, [{ type: 'ai-title', aiTitle: 'Resumed one' }], 10 * MIN); // ps only (no json)
  w.transcript('-Users-alice-other', SID.D, [{ type: 'ai-title', aiTitle: 'Earlier today' }], 5 * HOUR); // no process
  w.transcript('-Users-alice-old', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', [{ type: 'ai-title', aiTitle: 'Beyond the window' }], 30 * HOUR);
  fs.mkdirSync(path.join(w.cfg.projectsDir, '-Users-alice-proj', SID.A, 'subagents'), { recursive: true });
  fs.writeFileSync(path.join(w.cfg.projectsDir, '-Users-alice-proj', SID.A, 'subagents', 'agent-abc.jsonl'), jl([{ type: 'user' }]));
  const scan = psTable([
    ` 100     1 ${LSTART} /Users/alice/.local/bin/claude --session-id ${SID.A}`,
    ` 300     1 ${LSTART} claude --resume ${SID.C}`,
  ]);
  const feed = createFeed({ cfg: w.cfg, scan, now: () => NOW });
  await feed.tick();
  const byId = Object.fromEntries(feed.state.sessions.map((s) => [s.id, s]));
  assert.equal(byId[SID.A].group, 'running');
  assert.equal(byId[SID.A].live, true);
  assert.equal(byId[SID.A].pid, 100);
  assert.equal(byId[SID.A].registryStatus, 'busy');
  assert.equal(byId[SID.A].subagents.total, 1);
  assert.equal(byId[SID.A].title, 'Fix the flaky login test');
  assert.equal(byId[SID.A].currentTool.name, 'Edit');
  assert.equal(byId[SID.A].mayBeWaiting, false); // written 5 s ago
  assert.equal(byId[SID.B].live, false); // registry json exists but the pid is dead
  assert.equal(byId[SID.B].group, 'earlier');
  assert.equal(byId[SID.C].live, true);
  assert.equal(byId[SID.C].source, 'ps');
  assert.equal(byId[SID.C].group, 'idle');
  assert.equal(byId[SID.D].group, 'earlier');
  assert.equal(feed.state.sessions.length, 4); // the 30 h one is outside the window
  assert.equal(feed.state.counters.registryStale, 1);
  assert.ok(feed.state.counters.rowsUnparsed >= 1);
  assert.ok(feed.state.counters.unknownRowTypes >= 1);
  const written = fs.readFileSync(w.cfg.stateFile, 'utf8');
  assert.ok(!written.includes(FAKE_KEY) && !written.includes('hunter22secret'), 'secret leaked into state.json');
  assert.equal(fs.statSync(w.cfg.stateFile).mode & 0o777, 0o600);
  assert.equal(JSON.parse(written).schema, 1);
});

test('a live session whose transcript is outside the window is still listed; a quiet unanswered tool reads "may be waiting"', async () => {
  const w = world();
  w.transcript('-Users-alice-proj', SID.A, [userRow('go', NOW - 40 * HOUR), assistantRow([toolUse('tu_9', 'Bash', { command: 'sleep 999' })], NOW - 3 * MIN, { id: 'm9' })], 3 * MIN);
  w.registry(100, SID.A, { status: 'busy' });
  const feed = createFeed({ cfg: w.cfg, scan: psTable([` 100     1 ${LSTART} claude --session-id ${SID.A}`]), now: () => NOW, write: false });
  await feed.tick();
  const s = feed.state.sessions[0];
  assert.equal(s.group, 'running'); // registry says busy
  assert.equal(s.currentTool.label, 'sleep 999');
  assert.equal(s.mayBeWaiting, true);
});

test('survives missing folders, a failing ps, and broken files; keeps writing', async () => {
  const w = world();
  fs.rmSync(w.cfg.sessionsDir, { recursive: true });
  w.transcript('-Users-alice-proj', SID.A, 'not json at all\n{"type":"ai-title"', 1000);
  let clock = NOW;
  const feed = createFeed({ cfg: w.cfg, scan: async () => null, now: () => clock });
  await feed.tick();
  assert.equal(feed.state.counters.psOk, false);
  assert.equal(feed.state.counters.registryMissing, 1);
  assert.equal(feed.state.sessions.length, 1);
  assert.equal(feed.state.sessions[0].title, null);
  assert.equal(feed.state.sessions[0].transcript.unparsedRows, 1);
  fs.rmSync(w.cfg.projectsDir, { recursive: true });
  clock += 5000;
  await feed.tick();
  assert.equal(feed.state.sessions.length, 0);
});

test('state.json is rewritten on change and at the heartbeat, not on every poll', async () => {
  const w = world();
  w.transcript('-Users-alice-proj', SID.A, [{ type: 'ai-title', aiTitle: 'One' }], 5000);
  let clock = NOW;
  const written = [];
  const feed = createFeed({ cfg: w.cfg, scan: psTable([]), now: () => clock, onState: (_s, changed) => written.push(changed) });
  await feed.tick();
  clock += 2000; await feed.tick(); // nothing changed, heartbeat not due
  clock += w.cfg.heartbeatMs; await feed.tick(); // heartbeat due
  assert.deepEqual(written, [true, false]);
});
