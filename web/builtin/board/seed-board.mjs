#!/usr/bin/env node
// Installs the Board scene into a scene folder and (re)writes its live/data.json.
//   node seed-board.mjs <sceneDir> [fixture-name | path/to/data.json] [--every MS --seconds N]
// The runtime files are copied recursively (frames/ included), data.json is written atomically (temp file + rename, the way
// the mod writes it) with a fresh `updatedAt`. With --every the same file is rewritten on that period, so the scene can be
// watched polling. Fixtures: fixtures/busy.json sparse.json empty.json gallery.json gallery2.json overflow.json.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const BOARD_DIR = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURES_DIR = path.join(BOARD_DIR, 'fixtures');
const NOT_RUNTIME = /(^|\/)(fixtures|README\.md|seed-board\.mjs|[^/]*\.test\.mjs)(\/|$)/;

/** Copies the runtime files (no fixtures, tests or docs) of the scene into `dir`. */
export function installBoard(dir) {
  fs.mkdirSync(path.join(dir, 'live'), { recursive: true });
  fs.cpSync(BOARD_DIR, dir, { recursive: true, filter: (src) => !NOT_RUNTIME.test(path.relative(BOARD_DIR, src)) });
}

export const readFixture = (nameOrPath) => {
  const file = fs.existsSync(nameOrPath) ? nameOrPath : path.join(FIXTURES_DIR, `${nameOrPath}.json`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
};

/** An insight gives `lastCallAgoMs` instead of the absolute `lastCallAt`. */
const stampInsight = ({ lastCallAgoMs, ...insight }, now) => ({ ...insight, lastCallAt: now - lastCallAgoMs });

/** Fixture lanes give `startedAgoMs` / `updatedAgoMs` (so they stay fresh); the mod writes real `startedAt` / `updatedAt`. */
function stampLanes(data, now) {
  if (!Array.isArray(data.lanes)) return data;
  const lanes = data.lanes.map(({ startedAgoMs, updatedAgoMs, ...lane }) => ({
    ...lane, ...(startedAgoMs !== undefined && { startedAt: now - startedAgoMs }), ...(updatedAgoMs !== undefined && { updatedAt: now - updatedAgoMs }),
    ...(lane.insight && lane.insight.lastCallAgoMs !== undefined && { insight: stampInsight(lane.insight, now) }),
  }));
  return { ...data, lanes };
}

/** temp file + rename: a reader never sees half a file. */
export function writeData(dir, data) {
  const target = path.join(dir, 'live', 'data.json');
  const temp = path.join(dir, 'live', '.data.json.tmp');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(temp, `${JSON.stringify({ ...stampLanes(data, Date.now()), updatedAt: Date.now() })}\n`);
  fs.renameSync(temp, target);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (name) => (args.includes(name) ? Number(args[args.indexOf(name) + 1]) : 0);
  const [dir, fixture = 'busy'] = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
  if (!dir) {
    process.stderr.write('usage: node seed-board.mjs <sceneDir> [fixture | data.json] [--every MS] [--seconds N]\n');
    process.exit(2);
  }
  const scene = path.resolve(dir);
  installBoard(scene);
  const data = readFixture(fixture);
  writeData(scene, data);
  process.stdout.write(`board installed in ${scene} with ${fixture}\n`);
  const every = opt('--every');
  if (every > 0) {
    const timer = setInterval(() => writeData(scene, data), every);
    const seconds = opt('--seconds');
    if (seconds > 0) setTimeout(() => { clearInterval(timer); process.exit(0); }, seconds * 1000);
  }
}
