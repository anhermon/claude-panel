#!/usr/bin/env node
// A synthetic live/pulse.json for the Pulse scene: three loops (main + two agents), lanes, a steady stream of
// tool calls. For development and for web/pulse-scene.test.mjs; the real file is written by the panel mod
// (hooks/pulse-model.ts). Same shape, same privacy: basenames, first words, hostnames, never anything else.
//   node web/pulse-feed.mjs <sceneDir> [--seconds N] [--every MS]
//   copies web/builtin/pulse/* into <sceneDir> and rewrites <sceneDir>/live/pulse.json until stopped.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SOURCE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'builtin', 'pulse');
const SCENE_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.(html|css|js|mjs|json|svg|txt)$/;
const OUT_EVENTS = 60;
const DEFAULT_EVERY_MS = 600;

const TOOLS = [
  ['Read', 'files'], ['Read', 'files'], ['Grep', 'files'], ['Edit', 'files'], ['Write', 'files'],
  ['Bash', 'words'], ['Bash', 'words'], ['WebFetch', 'hosts'], ['WebSearch', 'len'], ['Glob', 'files'],
];
const FILES = ['register.tsx', 'pulse-model.ts', 'state.ts', 'spec.ts', 'pulse-flush.ts', 'scene.ts', 'README.md', 'pane.tsx', 'index.html', 'pulse.css', 'types.d.ts', 'boot.ts', 'layout.ts'];
const WORDS = ['git', 'npm', 'node', 'tsc', 'rg', 'ls'];
const HOSTS = ['docs.example.com', 'github.com'];

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = (r, list) => list[Math.floor(r() * list.length)];

/** A running simulation: `tick(now)` returns the next snapshot (and moves the lanes along). */
export function createSim({ seed = 7, agents = 2, startedAt = Date.now() - 95_000 } = {}) {
  const r = rng(seed);
  const loops = [
    { id: 'main', label: 'main', kind: 'main', status: 'running', lastTool: 'Read', lastTarget: 'state.ts', calls: 0, busy: 0, counts: {}, files: [], startedAt, lastAt: startedAt },
  ];
  const names = [['a31f9c', 'T25 pulse + lanes'], ['b77e02', 'T23 visual pane'], ['c0d4a8', 'review tests'], ['d91b36', 'desk research']];
  for (let i = 0; i < agents; i++)
    loops.push({ id: `agent-${names[i][0]}`, label: names[i][1], kind: 'subagent', status: 'running', parent: 'main', lastTool: 'Read', lastTarget: '', calls: 0, busy: 0, counts: {}, files: [], startedAt: startedAt + 8000 * (i + 1), lastAt: startedAt });
  if (agents >= 3) loops[3].status = 'done';
  const laneOf = (id, label, state, pct, step, loop) => ({ id, label, state, pct, step, note: '', startedAt, updatedAt: startedAt, by: loop ?? 'main', loop });
  const lanes = [
    laneOf('t25', 'T25 pulse + lanes', 'working', 20, 'writing the scene', loops[1]?.id),
    laneOf('t23', 'T23 visual pane', 'testing', 70, 'running the pane tests', loops[2]?.id),
    laneOf('plan', 'Release plan', 'waiting', 35, 'a review', null),
    laneOf('deploy', 'Deploy check', 'blocked', 55, 'CI is red', loops[3]?.id ?? null),
    laneOf('docs', 'Docs', 'done', 100, 'merged', null),
    laneOf('main-job', 'Main task', 'working', null, 'planning', 'main'),
  ].slice(0, agents >= 4 ? 6 : agents + 1);
  const ring = [];
  const files = new Set();
  let calls = 0;
  return {
    loops,
    lanes,
    /** Fill the last minute with calls, so the timeline is full from the first frame. */
    seed(now, n = OUT_EVENTS) {
      for (let k = 0; k < n; k++) this.tick(now - Math.floor(r() * 59_000), 1, true);
    },
    tick(now, burst = 1, isHistory = false) {
      for (let k = 0; k < burst; k++) {
        const loop = r() < 0.35 ? loops[0] : pick(r, loops);
        const [tool, kind] = pick(r, TOOLS);
        const target = kind === 'files' ? pick(r, FILES) : kind === 'words' ? pick(r, WORDS) : kind === 'hosts' ? pick(r, HOSTS) : `${10 + Math.floor(r() * 40)} chars`;
        const ev = { t: isHistory ? now : now - Math.floor(r() * 300), loop: loop.id, tool, target };
        if (r() < 0.04) ev.err = true;
        ring.push(ev);
        loop.lastTool = tool;
        loop.lastTarget = target;
        loop.lastAt = ev.t;
        loop.calls++;
        loop.counts[tool] = (loop.counts[tool] ?? 0) + 1;
        if (kind === 'files') {
          loop.files = [target, ...loop.files.filter((f) => f !== target)].slice(0, 12);
          files.add(target);
        }
        calls++;
      }
      ring.sort((a, b) => a.t - b.t);
      if (ring.length > 200) ring.splice(0, ring.length - 200);
      for (const lane of lanes) if (lane.state === 'working' || lane.state === 'testing') lane.pct = Math.min(96, lane.pct + r() * 2.2);
      return {
        v: 1,
        now,
        session: { turn: 'running', startedAt, turnStartedAt: now - 75_000 },
        totals: { calls: 600 + calls, files: 40 + files.size, agents: loops.length - 1, active: loops.length },
        loops: loops.map((l) => ({ ...l, counts: { ...l.counts }, files: [...l.files] })),
        lanes: lanes.map((l) => ({ ...l })),
        events: ring.slice(-OUT_EVENTS),
      };
    },
  };
}

/** Copy the scene's files the way the mod does (flat, text only) and make the live/ folder. */
export function installScene(dir, source = SOURCE_DIR) {
  fs.mkdirSync(path.join(dir, 'live'), { recursive: true });
  for (const name of fs.readdirSync(source)) if (SCENE_FILE.test(name)) fs.copyFileSync(path.join(source, name), path.join(dir, name));
}

/** temp file + rename, like the mod. */
export function writeSnapshot(dir, snap) {
  const target = path.join(dir, 'live', 'pulse.json');
  const temp = path.join(dir, 'live', '.pulse.json.tmp');
  fs.writeFileSync(temp, JSON.stringify(snap) + '\n');
  fs.renameSync(temp, target);
}

/** Keep rewriting live/pulse.json; returns stop(). */
export function startFeed(dir, { every = DEFAULT_EVERY_MS, sim = createSim(), now = Date.now } = {}) {
  installScene(dir);
  sim.seed(now());
  writeSnapshot(dir, sim.tick(now(), 2));
  const timer = setInterval(() => writeSnapshot(dir, sim.tick(now(), 1 + Math.floor(Math.random() * 3))), every);
  return () => clearInterval(timer);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [dir, ...rest] = process.argv.slice(2);
  if (!dir) {
    process.stderr.write('usage: node web/pulse-feed.mjs <sceneDir> [--seconds N] [--every MS]\n');
    process.exit(2);
  }
  const opt = (name, fallback) => (rest.includes(name) ? Number(rest[rest.indexOf(name) + 1]) : fallback);
  const stop = startFeed(path.resolve(dir), { every: opt('--every', DEFAULT_EVERY_MS), sim: createSim({ agents: opt('--agents', 2) }) });
  const seconds = opt('--seconds', 0);
  if (seconds > 0) setTimeout(() => { stop(); process.exit(0); }, seconds * 1000);
}
