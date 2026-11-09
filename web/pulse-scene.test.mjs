// The Pulse scene in a real browser: serve it with web/server.mjs, feed it a synthetic live/pulse.json, take
// screenshots with web/shot.mjs. Checks: it draws (zero console errors), it moves (two shots a second apart differ),
// it throttles when nothing happens (about 2 frames a second after 30 s of quiet), the stage is the same at 960x540 and 1280x720.
// Skipped when no Chrome is installed. Set PULSE_SHOT_DIR to keep the screenshots somewhere you can look at them.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { createSim, installScene, startFeed, writeSnapshot } from './pulse-feed.mjs';
import { main as shot } from './shot.mjs';
import { startServer } from './testkit.mjs';

const SIZES = [[960, 540], [1280, 720]];
const SETTLE_MS = 3500;
const DEBUG_WAIT_MS = 5500;
const STALE_MS = 45_000;
const LIVE_FPS_MIN = 20;
const QUIET_FPS_MAX = 4;
const MIN_PNG_BYTES = 20_000;

const procs = [];
const box = { tmp: '', out: '', stop: () => {}, server: null, chrome: true };
const sha = (file) => createHash('sha1').update(readFileSync(file)).digest('hex');
const scene = (id, dir) => ({ id, title: id, layout: 'stage', span: 3, height: 540, alt: 'Live activity of the agents', rev: 1, dir, entry: 'index.html', builtin: true });

before(async () => {
  box.tmp = realpathSync(mkdtempSync(join(tmpdir(), 'pulse-scene-test-')));
  box.out = process.env.PULSE_SHOT_DIR ?? join(box.tmp, 'shots');
  mkdirSync(box.out, { recursive: true });
  const live = join(box.tmp, 'live-scene');
  const stale = join(box.tmp, 'stale-scene');
  box.stop = startFeed(live, { sim: createSim({ agents: 3 }) });
  // the same scene with a file that has not changed for a long while: nothing is happening
  installScene(stale);
  const sim = createSim({ agents: 2 });
  sim.seed(Date.now() - STALE_MS);
  writeSnapshot(stale, sim.tick(Date.now() - STALE_MS, 1));
  const state = {
    v: 4, rev: 1, updatedAt: 1, url: null, status: 'working', task: { title: 'Pulse', why: 'test' }, context: [], done: [], next: [], cards: [], choices: [],
    scenes: [scene('pulse', live), scene('stale', stale)],
  };
  writeFileSync(join(box.tmp, 'state.json'), JSON.stringify(state));
  box.server = await startServer(join(box.tmp, 'state.json'), { procs, extraArgs: ['--root', box.tmp] });
});

after(() => {
  box.stop();
  for (const p of procs) p.kill();
  if (process.env.PULSE_SHOT_DIR === undefined) rmSync(box.tmp, { recursive: true, force: true });
});

async function capture(id, [w, h], name, { wait = SETTLE_MS, query = '' } = {}) {
  const png = join(box.out, `${name}.png`);
  const url = `${box.server.base}/s/${id}/${query}`;
  const res = await shot([url, '--width', String(w), '--height', String(h), '--wait', String(wait), '--out', png]);
  if (!res.ok && /chrome not found/.test(res.error ?? '')) box.chrome = false;
  return { ...res, png };
}

test('the scene is served with its files and draws without a console error at 960x540 and 1280x720', async (t) => {
  for (const size of SIZES) {
    const res = await capture('pulse', size, `pulse-${size[0]}x${size[1]}`);
    if (!box.chrome) return t.skip('no Chrome');
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.deepEqual(res.errors, [], 'no page errors');
    assert.deepEqual(res.console.filter((c) => c.level === 'error'), [], 'no console errors');
    assert.deepEqual([res.width, res.height], size);
    assert.ok(res.bytes > MIN_PNG_BYTES, `the picture has content (${res.bytes} bytes)`);
  }
});

test('it moves: two screenshots a second apart are not the same picture', async (t) => {
  const a = await capture('pulse', SIZES[0], 'pulse-move-a', { wait: 2500 });
  if (!box.chrome) return t.skip('no Chrome');
  const b = await capture('pulse', SIZES[0], 'pulse-move-b', { wait: 2500 });
  assert.equal(a.ok && b.ok, true);
  assert.notEqual(sha(a.png), sha(b.png));
});

test('live it draws at full rate; after 30 s of nothing it drops to about two frames a second', async (t) => {
  const frames = (res) => res.console.map((c) => /^pulse frames=(\d+) quiet=(true|false)$/.exec(c.text)).filter(Boolean).map((m) => ({ n: Number(m[1]), quiet: m[2] === 'true' }));
  const live = await capture('pulse', SIZES[0], 'pulse-debug-live', { wait: DEBUG_WAIT_MS, query: '?debug' });
  if (!box.chrome) return t.skip('no Chrome');
  const liveFrames = frames(live);
  assert.ok(liveFrames.length >= 2, JSON.stringify(live.console));
  assert.ok(liveFrames.slice(1).every((f) => !f.quiet && f.n >= LIVE_FPS_MIN), JSON.stringify(liveFrames));
  const idle = await capture('stale', SIZES[0], 'pulse-debug-quiet', { wait: DEBUG_WAIT_MS, query: '?debug' });
  const idleFrames = frames(idle);
  assert.ok(idleFrames.length >= 2, JSON.stringify(idle.console));
  assert.ok(idleFrames.slice(1).every((f) => f.quiet && f.n <= QUIET_FPS_MAX), JSON.stringify(idleFrames));
  assert.deepEqual(idle.errors, []);
});
