// assets-motion.test.mjs - galton and particles: pure simulation, schema, drawing, reduced motion and loop cleanup.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ASSETS, describe, validate, AssetError } from './kit/assets/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ASSET_DIR = join(HERE, 'kit', 'assets');
const TEST_FS = 17;
const TEST_WIDTHS = [360, 1280];
const { createDocument } = await import('./fake-dom.mjs');
const doc = createDocument();
const FakeNode = doc.body.constructor;
FakeNode.prototype.append = function (...nodes) { nodes.forEach((node) => this.appendChild(node instanceof FakeNode ? node : doc.createTextNode(String(node)))); };
FakeNode.prototype.querySelector = function (selector) { return this.find((n) => (n.getAttribute('class') ?? '').split(' ').includes(selector.split('.').at(-1))) ?? null; };
Object.defineProperty(FakeNode.prototype, 'clientWidth', { get: () => TEST_WIDTHS[0], configurable: true });
doc.createTextNode = (text) => { const node = doc.createElement('#text'); node.textContent = text; return node; };
Object.assign(globalThis, { document: doc, Node: FakeNode, cancelAnimationFrame: () => {}, matchMedia: () => ({ matches: true }) });
const byClass = (el, cls) => el.find((n) => (n.getAttribute('class') ?? '').split(' ').includes(cls));

// ---- motion assets: galton and particles -------------------------------------------------------------------------------------------------------
const { galtonSim, galtonAt, galtonTimeline, binomialPmf, binomialStats, histogramStats } = await import('./kit/assets/galton.js');
const { particleState, laneScale, laneTarget, MAX_PARTICLES_PER_LANE, STEADY_STATE_S, PARTICLE_LIFETIME_S } = await import('./kit/assets/particles.js');
const { seededRng, unitHash, frameLoop, compactMode, COMPACT_HEIGHT_PX } = await import('./kit/assets/motion.js');
const MOTION_OPTS = { title: 'Motion title', caption: 'Motion caption', fs: TEST_FS, height: 360, accent: 'c3', density: 'compact', maxRows: 2, labels: { more: 'remaining' } };
const FRAME_MS = 34;
const MAX_FRAMES = 2000;
const classNodes = (figure, cls) => figure.findAll((n) => (n.getAttribute('class') ?? '').split(' ').includes(cls));
const setWidth = (width) => Object.defineProperty(FakeNode.prototype, 'clientWidth', { get: () => width, configurable: true });
const pngSafe = JSON.stringify;

/** Runs `body` with a manual requestAnimationFrame, motion allowed, and an `isConnected` the test controls; restores every global. */
async function withFrames(body) {
  const queue = new Map();
  let nextId = 0;
  const calls = { raf: 0, cancel: 0 };
  const state = { detached: false };
  const saved = { raf: globalThis.requestAnimationFrame, cancel: globalThis.cancelAnimationFrame, media: globalThis.matchMedia, remove: doc.removeEventListener };
  globalThis.requestAnimationFrame = (cb) => { calls.raf++; queue.set(++nextId, cb); return nextId; };
  globalThis.cancelAnimationFrame = (id) => { if (queue.delete(id)) calls.cancel++; };
  globalThis.matchMedia = () => ({ matches: false });
  doc.removeEventListener = (type, fn) => { doc.listeners[type] = (doc.listeners[type] ?? []).filter((f) => f !== fn); };
  Object.defineProperty(FakeNode.prototype, 'isConnected', { get: () => !state.detached, configurable: true });
  const flush = (time) => { const due = [...queue.values()]; queue.clear(); due.forEach((cb) => cb(time)); };
  const run = (until = MAX_FRAMES) => { let time = 0; let frames = 0; while (queue.size && frames < until) { flush(time); time += FRAME_MS; frames++; } return frames; };
  try { await body({ queue, calls, state, flush, run }); } finally {
    Object.assign(globalThis, { requestAnimationFrame: saved.raf, cancelAnimationFrame: saved.cancel, matchMedia: saved.media });
    doc.removeEventListener = saved.remove;
    delete FakeNode.prototype.isConnected;
    doc.hidden = false;
    doc.listeners.visibilitychange = [];
  }
}

test('seededRng and unitHash are deterministic and stay in [0, 1)', () => {
  const a = seededRng(5); const b = seededRng(5); const c = seededRng(6);
  const seqA = Array.from({ length: 50 }, a); const seqB = Array.from({ length: 50 }, b);
  assert.deepEqual(seqA, seqB);
  assert.notDeepEqual(seqA, Array.from({ length: 50 }, c));
  assert.ok(seqA.every((v) => v >= 0 && v < 1));
  assert.equal(unitHash(1, 2, 3), unitHash(1, 2, 3));
  assert.notEqual(unitHash(1, 2, 3), unitHash(1, 2, 4));
});

test('compactMode: a narrow width or a short fixed height (a board tile) is compact, a tall or natural one is not', () => {
  assert.equal(compactMode({ narrow: true, h: 0 }), true);
  assert.equal(compactMode({ narrow: false, h: COMPACT_HEIGHT_PX - 20 }), true);
  assert.equal(compactMode({ narrow: false, h: COMPACT_HEIGHT_PX + 240 }), false);
  assert.equal(compactMode({ narrow: false, h: 0 }), false);
});

test('galton simulation: seeded and exact, bins add up, p = 0 and p = 1 pile into the end bins', () => {
  const sim = galtonSim({ rows: 10, balls: 200, seed: 7, p: 0.5 });
  assert.deepEqual(sim, galtonSim({ rows: 10, balls: 200, seed: 7, p: 0.5 }));
  assert.notDeepEqual(sim.bins, galtonSim({ rows: 10, balls: 200, seed: 8, p: 0.5 }).bins);
  assert.equal(sim.bins.length, 11);
  assert.equal(sim.bins.reduce((a, b) => a + b, 0), 200);
  assert.deepEqual(sim.bins, [1, 4, 9, 26, 41, 46, 37, 25, 9, 2, 0], 'pinned run for seed 7');
  assert.equal(galtonSim({ rows: 6, balls: 30, p: 0 }).bins[0], 30);
  assert.equal(galtonSim({ rows: 6, balls: 30, p: 1 }).bins[6], 30);
});

test('binomial theory: pmf sums to 1, matches the closed forms, and the simulated histogram sits near it', () => {
  const pmf = binomialPmf(10, 0.5);
  assert.ok(Math.abs(pmf.reduce((a, b) => a + b, 0) - 1) < 1e-12);
  assert.ok(Math.abs(pmf[5] - 252 / 1024) < 1e-12);
  assert.deepEqual(binomialPmf(4, 1), [0, 0, 0, 0, 1]);
  assert.deepEqual(binomialPmf(4, 0), [1, 0, 0, 0, 0]);
  const { mean, sd } = binomialStats(10, 0.5);
  assert.ok(Math.abs(mean - 5) < 1e-12 && Math.abs(sd - Math.sqrt(2.5)) < 1e-12);
  const big = histogramStats(galtonSim({ rows: 10, balls: 400, seed: 3, p: 0.5 }).bins);
  assert.ok(Math.abs(big.mean - mean) < 0.5 && Math.abs(big.sd - sd) < 0.4);
  assert.deepEqual(histogramStats([2, 0, 2]), { total: 4, mean: 1, sd: 1 });
  assert.ok(Number.isNaN(histogramStats([0, 0]).mean));
});

test('galton timeline: balls land one by one, the run settles, and the end state is the full histogram', () => {
  const sim = galtonSim({ rows: 8, balls: 60, seed: 2 });
  const tl = galtonTimeline(8, 60);
  assert.ok(tl.total > tl.drop && tl.total <= tl.drop + 59 * tl.gap + 1e-9);
  const start = galtonAt(sim, tl, 0);
  assert.equal(start.flying.length, 1);
  assert.equal(start.counts.reduce((a, b) => a + b, 0), 0);
  let previous = 0;
  for (let t = 0; t <= tl.total; t += 40) {
    const { counts, flying } = galtonAt(sim, tl, t);
    const landed = counts.reduce((a, b) => a + b, 0);
    assert.ok(landed >= previous && landed + flying.length <= 60);
    assert.ok(flying.every((b) => b.level >= 0 && b.level <= 8 && b.k >= 0 && b.k <= b.level));
    previous = landed;
  }
  const end = galtonAt(sim, tl, tl.total);
  assert.deepEqual(end.counts, sim.bins);
  assert.equal(end.flying.length, 0);
  assert.ok(galtonTimeline(14, 400).total < 7000, 'the biggest board still settles in a few seconds');
});

for (const width of TEST_WIDTHS) {
  test(`galton at ${width}px: header states n, p, mean, sd; bins; options; update; errors name the path; theme tokens; compact`, async () => {
    setWidth(width);
    const sample = structuredClone(describe('galton').sample);
    const figure = ASSETS.galton(sample, { ...MOTION_OPTS });
    await Promise.resolve();
    assert.equal(figure.dataset.state, 'ok');
    const text = figure.textContent;
    for (const part of ['Motion title', 'Motion caption', 'n 10 rows', 'p 0.50', 'mean 5.00', 'sd 1.58', '200 balls', 'simulated mean 4.91', 'observed n 200', 'binomial']) assert.ok(text.includes(part), `${part} in ${text}`);
    const box = byClass(figure, 'pa-galton');
    assert.equal(box.style['--work-accent'], 'var(--ui-c3)');
    assert.equal(box.style['--ui-fs'], `${TEST_FS}px`);
    assert.equal(box.style.height, '360px', 'a fixed height is the box height; content scrolls instead of clipping');
    assert.equal(box.getAttribute('data-density'), 'compact');
    assert.notEqual(box.getAttribute('data-narrow'), null, 'a 360 px tall box is a board tile: compact at any width');
    assert.equal(classNodes(figure, 'pa-galton-bar').length, 11);
    assert.equal(classNodes(figure, 'pa-galton-obs').length, 11);
    assert.equal(classNodes(figure, 'pa-galton-dot').length, 11);
    assert.equal(classNodes(figure, 'pa-galton-lbls')[0].children.length, 11);
    const bars = classNodes(figure, 'pa-galton-bar').map((b) => parseFloat(b.style.height));
    assert.ok(bars.every((v) => v >= 0 && v <= 100) && Math.max(...bars) > 40, 'bars scale to the tallest point');
    assert.match(classNodes(figure, 'pa-galton-col')[3].getAttribute('title'), /bin 3: 26 of 200 balls \(13\.0%\); binomial 11\.7%; observed 22 \(11\.0%\)/);
    assert.equal(byClass(figure, 'pa-galton-curve').getAttribute('preserveAspectRatio'), 'none');
    // natural height: no fixed height, so the compact flag follows the width alone
    const natural = ASSETS.galton({ rows: 6, balls: 50 });
    await Promise.resolve();
    assert.equal(byClass(natural, 'pa-galton').getAttribute('data-narrow') !== null, width === TEST_WIDTHS[0]);
    assert.equal(classNodes(natural, 'pa-galton-obs').length, 0, 'no observed series, no observed markers');
    assert.ok(!natural.textContent.includes('observed'));
    assert.match(byClass(natural, 'pa-galton-plot').style.height, /^\d+(\.\d+)?px$/);
    // update re-renders, a bad field is refused with its path, a wrong observed length too
    figure.update({ rows: 4, balls: 20, p: 0.3 }, { labels: { rows: 'levels', mean: 'avg' } });
    assert.equal(classNodes(figure, 'pa-galton-bar').length, 5);
    assert.ok(figure.textContent.includes('n 4 levels') && figure.textContent.includes('p 0.30') && figure.textContent.includes('avg 1.20'), figure.textContent);
    figure.update({ rows: 4, balls: 20, p: 'wrong' });
    assert.equal(figure.dataset.state, 'error');
    assert.ok(figure.textContent.includes('data.p'));
    assert.throws(() => validate('galton', { rows: 4, balls: 20, observed: [1, 2] }), /data\.observed needs at least 3|data\.observed needs 5 counts/);
    assert.throws(() => validate('galton', { rows: 4, balls: 20, observed: [1, 2, 3] }), /data\.observed needs 5 counts, one per bin \(rows \+ 1\); got 3/);
    assert.throws(() => validate('galton', { rows: 15, balls: 20 }), /data\.rows must be a number from 2 to 14/);
    assert.throws(() => validate('galton', { rows: 5, balls: 401 }), /data\.balls must be a number from 1 to 400/);
    assert.throws(() => validate('galton', { rows: 5.5, balls: 10 }), /data\.rows must be an integer/);
    assert.throws(() => validate('galton', { rows: 5, balls: 10, p: 1.2 }), /data\.p must be a number from 0 to 1/);
    figure.destroy();
    natural.destroy();
  });
}

test('galton drawing: no hard-coded colours, theme variables, compact rules, one canvas for the board, sample within the payload cap', () => {
  const source = readFileSync(join(ASSET_DIR, 'galton.js'), 'utf8');
  assert.doesNotMatch(source, /#[0-9a-f]{3,8}\b|rgba?\(/i);
  assert.doesNotMatch(source, /fetch\(|import\('http|https?:\/\//);
  const css = doc.documentElement.textContent;
  for (const token of ['--ui-line-hi', '--ui-c2', '--ui-c3', '--ui-card', '--work-accent']) assert.ok(css.includes(token) || source.includes(token), token);
  assert.match(css, /\.pa-galton\[data-narrow\] \.pa-galton-head\s*\{[^}]*font-size:max\(12px/);
  assert.match(css, /\.pa-galton-lbls\s*\{[^}]*font-size:max\(12px/);
  assert.match(css, /\.pa-galton-curve polyline\s*\{[^}]*vector-effect:non-scaling-stroke/);
  assert.ok(JSON.stringify(describe('galton').sample).length <= 12 * 1024);
});

test('galton animation runs once to settle then stops; reduced motion and a second draw of the same data are static', async () => {
  setWidth(TEST_WIDTHS[1]);
  await withFrames(async ({ queue, calls, run }) => {
    const data = { rows: 6, balls: 40, seed: 11 };
    const figure = ASSETS.galton(data);
    await Promise.resolve();
    assert.equal(queue.size, 1, 'one frame requested while the balls fall');
    assert.equal(classNodes(figure, 'pa-galton-bar')[0].style.height, '0%', 'starts empty');
    const frames = run();
    assert.ok(frames > 5 && frames < MAX_FRAMES, `settles in ${frames} frames`);
    assert.equal(queue.size, 0, 'no endless loop after settling');
    const sim = galtonSim({ ...data, p: 0.5 });
    const titles = classNodes(figure, 'pa-galton-col').map((c) => c.getAttribute('title'));
    sim.bins.forEach((count, j) => assert.ok(titles[j].includes(`: ${count} of 40 balls`), titles[j]));
    const before = calls.raf;
    figure.update({ ...data }, { caption: 'again' });
    assert.equal(calls.raf, before, 'the same data does not replay the drop');
    figure.update({ ...data, balls: 30 });
    assert.equal(queue.size, 1, 'new data drops again');
    figure.destroy();
    assert.equal(queue.size, 0, 'destroy cancels the pending frame');
  });
  await withFrames(async ({ queue, calls, state, flush }) => { // detached mid-run: stops and leaves the settled histogram
    const figure = ASSETS.galton({ rows: 6, balls: 40, seed: 12 });
    await Promise.resolve();
    flush(0); flush(FRAME_MS);
    state.detached = true;
    flush(2 * FRAME_MS);
    assert.equal(queue.size, 0, 'a detached figure stops its loop');
    assert.ok(classNodes(figure, 'pa-galton-col')[0].getAttribute('title').includes(' of 40 balls'));
    assert.equal(doc.listeners.visibilitychange.length, 0, 'the visibility listener is removed');
    assert.ok(calls.raf >= 2);
  });
  const calls = { raf: 0 }; // reduced motion (matches: true, the default in this file): no frame is ever requested
  globalThis.requestAnimationFrame = () => { calls.raf++; return 1; };
  try {
    const figure = ASSETS.galton({ rows: 6, balls: 40, seed: 11 });
    await Promise.resolve();
    assert.equal(calls.raf, 0);
    assert.ok(classNodes(figure, 'pa-galton-col')[0].getAttribute('title').includes(' of 40 balls'), 'the final histogram is drawn at once');
    figure.destroy();
  } finally { delete globalThis.requestAnimationFrame; }
});

test('particleState: exact, seeded, density = rate / max capped, zero rate is empty, fields stay in range', () => {
  const series = [{ rate: 1000, max: 2000 }, { rate: 2000, max: 2000 }, { rate: 4000, max: 2000 }, { rate: 0, max: 2000 }, { rate: 1, max: 2000 }];
  const state = particleState(series, STEADY_STATE_S, 1);
  assert.deepEqual(state.map((l) => l.target), [MAX_PARTICLES_PER_LANE / 2, MAX_PARTICLES_PER_LANE, MAX_PARTICLES_PER_LANE, 0, 1]);
  assert.equal(state[3].particles.length, 0);
  assert.deepEqual(state, particleState(series, STEADY_STATE_S, 1));
  assert.notDeepEqual(state[0].particles, particleState(series, STEADY_STATE_S, 2)[0].particles);
  for (let i = 0; i < 100; i++) {
    const t = STEADY_STATE_S + i * 0.037;
    particleState(series, t, 3).forEach((lane) => assert.ok(Math.abs(lane.particles.length - lane.target) <= 1, `${lane.particles.length} vs ${lane.target} at ${t}`));
  }
  for (const style of ['sparks', 'rain', 'flow']) {
    for (const lane of particleState(series, STEADY_STATE_S, 5, style)) for (const p of lane.particles) assert.ok(p.u >= 0 && p.u <= 1 && p.v >= 0 && p.v <= 1 && p.fade > 0 && p.fade <= 1, `${style} ${pngSafe(p)}`);
  }
  assert.ok(particleState(series, 0, 1).every((l) => l.particles.length <= 1), 'a lane starts empty and fills over its lifetime');
  const filling = particleState(series, PARTICLE_LIFETIME_S / 2, 1)[1].particles.length;
  assert.ok(filling > 0 && filling < MAX_PARTICLES_PER_LANE);
  assert.ok(particleState([{ rate: 5, max: 10 }], STEADY_STATE_S).every((l) => l.particles.every((p) => p.u <= 1)));
});

test('particles scale: max defaults to the busiest series, laneTarget caps and is proportional', () => {
  assert.equal(laneScale([{ rate: 5 }, { rate: 20 }], { rate: 5 }), 20);
  assert.equal(laneScale([{ rate: 5, max: 8 }], { rate: 5, max: 8 }), 8);
  assert.ok(laneScale([{ rate: 0 }], { rate: 0 }) > 0, 'all-zero series never divide by zero');
  assert.equal(laneTarget(0, 10), 0);
  assert.equal(laneTarget(99, 10), MAX_PARTICLES_PER_LANE);
  assert.equal(laneTarget(5, 10), MAX_PARTICLES_PER_LANE / 2);
  const flow = particleState([{ rate: 1, max: 1 }], STEADY_STATE_S, 1, 'flow')[0].particles;
  assert.ok(new Set(flow.map((p) => p.v)).size <= 4, 'flow runs on a few belt tracks');
});

test('particles at 1280px (columns) and 360px with many lanes (rows): labels carry value and unit, hover titles, options, update, errors, compact', async () => {
  const sample = structuredClone(describe('particles').sample);
  setWidth(TEST_WIDTHS[1]);
  const wide = ASSETS.particles(sample, { title: 'Load', caption: 'Per lane', fs: TEST_FS, accent: 'c3', density: 'compact', maxRows: 2, labels: { more: 'remaining' } });
  await Promise.resolve();
  assert.equal(wide.dataset.state, 'ok');
  for (const part of ['Load', 'Per lane', 'Ingest', '1,200 events/s', 'Queue', '1,650 events/s', '+1 remaining']) assert.ok(wide.textContent.includes(part), `${part} in ${wide.textContent}`);
  assert.ok(!wide.textContent.includes('Errors'), 'maxRows clips lanes and says so');
  const box = byClass(wide, 'pa-part');
  assert.equal(box.style['--work-accent'], 'var(--ui-c3)');
  assert.equal(box.style['--ui-fs'], `${TEST_FS}px`);
  assert.equal(box.getAttribute('data-density'), 'compact');
  assert.equal(byClass(wide, 'pa-part-lanes').getAttribute('data-layout'), 'columns');
  assert.equal(byClass(wide, 'pa-part-lanes').style['grid-template-columns'], 'repeat(2,minmax(0,1fr))');
  assert.equal(box.getAttribute('data-narrow'), null);
  assert.match(classNodes(wide, 'pa-part-lane')[1].getAttribute('title'), /Queue: 1,650 events\/s \(83% of 2,000 events\/s; warn\)/);
  const canvas = byClass(wide, 'pa-part-canvas');
  assert.equal(canvas.style.width, `${canvas.width * 3}px`, 'an integer pixel scale of 3 on a wide figure');
  assert.equal(canvas.style.height, `${canvas.height * 3}px`);
  wide.update({ ...sample, series: [{ label: 'Only lane', rate: 5, tone: 'danger' }], style: 'rain' }, { maxRows: 12 });
  assert.equal(classNodes(wide, 'pa-part-lane').length, 1);
  assert.ok(wide.textContent.includes('Only lane') && wide.textContent.includes('5 events/s') && !wide.textContent.includes('remaining'));
  wide.update({ ...sample, series: [{ label: 'Bad', rate: 'x' }] });
  assert.equal(wide.dataset.state, 'error');
  assert.ok(wide.textContent.includes('data.series[0].rate'));
  wide.destroy();

  setWidth(TEST_WIDTHS[0]);
  const many = { unit: 'req/s', series: Array.from({ length: 8 }, (_, i) => ({ label: `Lane ${i + 1}`, rate: (i + 1) * 10 })) };
  const narrow = ASSETS.particles(many, { height: 340 });
  await Promise.resolve();
  const lanes = byClass(narrow, 'pa-part-lanes');
  assert.equal(lanes.getAttribute('data-layout'), 'rows', 'lanes too narrow for columns become rows');
  assert.equal(classNodes(narrow, 'pa-part-lane').length, 8);
  assert.notEqual(byClass(narrow, 'pa-part').getAttribute('data-narrow'), null);
  assert.equal(byClass(narrow, 'pa-part').style.height, '340px');
  assert.ok(narrow.textContent.includes('80 req/s'), 'every lane keeps its number and unit');
  const small = byClass(narrow, 'pa-part-canvas');
  assert.equal(small.style.width, `${small.width * 2}px`, 'compact figures use a smaller integer pixel scale');
  narrow.destroy();
  const three = ASSETS.particles(sample);
  await Promise.resolve();
  assert.equal(byClass(three, 'pa-part-lanes').getAttribute('data-layout'), 'columns', 'three lanes still fit 360 px side by side');
  three.destroy();
  assert.throws(() => validate('particles', { unit: 'x', series: [{ label: 'a', rate: 1, max: 0 }] }), /data\.series\[0\]\.max must be a number from/);
  assert.throws(() => validate('particles', { unit: 'x', series: [{ label: 'a', rate: 1, tone: 'blue' }] }), /data\.series\[0\]\.tone must be one of ok\|warn\|danger\|info/);
  assert.throws(() => validate('particles', { unit: 'x', series: [] }), /data\.series needs at least 1 item/);
  assert.throws(() => validate('particles', { unit: 'x', series: Array.from({ length: 9 }, () => ({ label: 'a', rate: 1 })) }), /data\.series has 9 items; the limit is 8/);
  assert.throws(() => validate('particles', { unit: 'x', series: [{ label: 'a', rate: 1 }], style: 'snow' }), /data\.style must be one of sparks\|rain\|flow/);
  assert.throws(() => validate('particles', { unit: 'x', series: [{ label: 'a', rate: -1 }] }), /data\.series\[0\]\.rate must be a number from 0/);
});

test('particles loop: throttled, only while attached and visible, stops when detached or destroyed, never under reduced motion', async () => {
  setWidth(TEST_WIDTHS[1]);
  const sample = describe('particles').sample;
  await withFrames(async ({ queue, calls, state, flush }) => {
    const figure = ASSETS.particles(sample);
    await Promise.resolve();
    assert.equal(queue.size, 1);
    for (let i = 0; i < 5; i++) flush(i * 50);
    assert.equal(queue.size, 1, 'a live load keeps drawing while attached');
    figure.destroy();
    assert.equal(queue.size, 0, 'destroy cancels the frame');
    assert.equal(doc.listeners.visibilitychange.length, 0);
  });
  await withFrames(async ({ queue, state, flush }) => {
    const figure = ASSETS.particles(sample);
    await Promise.resolve();
    flush(0);
    state.detached = true;
    flush(100);
    assert.equal(queue.size, 0, 'a detached figure stops without destroy()');
    assert.equal(doc.listeners.visibilitychange.length, 0);
    figure.destroy();
  });
  await withFrames(async ({ queue, flush }) => { // hidden tab: no frames until it is shown again
    doc.hidden = true;
    const figure = ASSETS.particles(sample);
    await Promise.resolve();
    assert.equal(queue.size, 0);
    doc.hidden = false;
    doc.dispatch('visibilitychange');
    assert.equal(queue.size, 1);
    flush(0);
    figure.destroy();
  });
  const calls = { raf: 0 };
  globalThis.requestAnimationFrame = () => { calls.raf++; return 1; };
  try {
    const figure = ASSETS.particles(sample); // matches: true in this file = prefers-reduced-motion
    await Promise.resolve();
    assert.equal(calls.raf, 0, 'reduced motion draws one static frame and never loops');
    figure.destroy();
  } finally { delete globalThis.requestAnimationFrame; }
});

test('frameLoop throttles to its interval and disposes itself when the step reports it is done', async () => {
  await withFrames(async ({ queue, flush }) => {
    const seen = [];
    const el = { isConnected: true };
    frameLoop(el, (ms) => { seen.push(ms); return seen.length < 3; }, { intervalMs: 33 });
    for (const t of [100, 105, 110, 140, 145, 175]) flush(t);
    assert.deepEqual(seen, [0, 40, 75], 'steps at most every 33 ms, elapsed counted from the first');
    assert.equal(queue.size, 0, 'done: no further frames');
  });
});

test('particles drawing: no hard-coded colours, pixel-art CSS, compact rules, sample within the payload cap', () => {
  const source = readFileSync(join(ASSET_DIR, 'particles.js'), 'utf8');
  assert.doesNotMatch(source, /#[0-9a-f]{3,8}\b|rgba?\(/i);
  const css = doc.documentElement.textContent;
  assert.match(css, /\.pa-part-canvas\s*\{[^}]*image-rendering:pixelated/);
  assert.match(css, /\.pa-part\[data-narrow\] \.pa-part-text\s*\{[^}]*font-size:max\(12px/);
  assert.match(css, /\.pa-part-lanes\[data-layout="rows"\]/);
  assert.ok(JSON.stringify(describe('particles').sample).length <= 12 * 1024);
  assert.ok(Object.values(source.match(/var\(--ui-[a-z-]+\)/g) ?? []).length >= 4, 'tone colours come from the --ui variables');
});

