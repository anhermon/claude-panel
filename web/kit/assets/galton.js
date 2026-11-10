// galton.js - `galton`: how a distribution emerges. Balls fall through a triangle of pegs (canvas), land in bins, and a live histogram
// (DOM bars, so each bin has a hover title) builds under it with the theoretical binomial curve overlaid and an optional observed series.
// The simulation is a pure function of the data and a seed (no physics engine: exact, offline, testable); the animation is a pure function
// of elapsed time, runs once to settle and then stops. Reduced motion draws the settled histogram at once.
import { defineAsset, h, clamp } from './core.js';
import { addCss } from '../ui/core.js';
import { validateWork } from './work-schema.js';
import { workBox, word } from './custom.js';
import { seededRng, SEED_DEFAULT, addClass, compactMode, canAnimate, themeColors, frameLoop } from './motion.js';

const KIND = 'galton';
export const P_DEFAULT = 0.5;
const PERCENT = 100;
const STAT_DECIMALS = 2;
const NO_VALUE = '-';
// Timing: every ball falls for DROP_MS_PER_ROW per row; balls are released RELEASE_GAP apart so the whole run settles in about SETTLE_TARGET_MS.
const DROP_MS_PER_ROW = 110;
const SETTLE_TARGET_MS = 5000;
const RELEASE_GAP_MIN_MS = 12;
const RELEASE_GAP_MAX_MS = 260;
// Geometry.
const PLOT_ASPECT = 0.62;
const PLOT_MIN_PX = 200;
const PLOT_MAX_PX = 420;
const BOARD_FLEX = 11;
const HIST_FLEX = 9;
const Y_PAD = 1.12; // headroom above the tallest bar or curve point
const PEG_FRAC = 0.14; // peg radius as a share of the smaller peg spacing
const BALL_TO_PEG = 1.4; // ball radius as a multiple of the peg radius
const PEG_R_MIN_PX = 1.5;
const PEG_R_MAX_PX = 4;
const BOARD_PAD_PX = 6;
const TAU = Math.PI * 2;
const SAMPLE = { rows: 10, balls: 200, seed: 7, p: 0.5, observed: [1, 4, 9, 22, 41, 50, 38, 20, 10, 3, 2] };

// ---- pure: simulation, theory, statistics ----------------------------------------------------------------------------------------------------
/** Every ball's left/right choices (1 = right) and the bin it lands in (its count of rights), from `seed`: the same data always gives the same run. */
export function galtonSim({ rows, balls, seed = SEED_DEFAULT, p = P_DEFAULT }) {
  const rng = seededRng(seed);
  const paths = Array.from({ length: balls }, () => Array.from({ length: rows }, () => (rng() < p ? 1 : 0)));
  const binOf = paths.map((path) => path.reduce((a, b) => a + b, 0));
  const bins = new Array(rows + 1).fill(0);
  binOf.forEach((b) => { bins[b]++; });
  return { rows, balls, paths, binOf, bins };
}
/** The binomial probability of each bin 0..n. */
export function binomialPmf(n, p) {
  let coef = 1;
  return Array.from({ length: n + 1 }, (_, k) => {
    const pk = coef * p ** k * (1 - p) ** (n - k);
    coef = (coef * (n - k)) / (k + 1);
    return pk;
  });
}
/** Mean and standard deviation of Binomial(n, p). */
export const binomialStats = (n, p) => ({ mean: n * p, sd: Math.sqrt(n * p * (1 - p)) });
/** Count, mean and standard deviation of bin indices weighted by `counts`. */
export function histogramStats(counts) {
  const total = counts.reduce((a, b) => a + b, 0);
  if (total === 0) return { total, mean: NaN, sd: NaN };
  const mean = counts.reduce((a, c, k) => a + c * k, 0) / total;
  return { total, mean, sd: Math.sqrt(counts.reduce((a, c, k) => a + c * (k - mean) ** 2, 0) / total) };
}
/** Fall time per ball, gap between releases and total run time (ms). */
export function galtonTimeline(rows, balls) {
  const drop = rows * DROP_MS_PER_ROW;
  const gap = balls > 1 ? clamp((SETTLE_TARGET_MS - drop) / (balls - 1), RELEASE_GAP_MIN_MS, RELEASE_GAP_MAX_MS) : 0;
  return { drop, gap, total: drop + (balls - 1) * gap };
}
/** The state at `t` ms: bin counts of the balls that have landed, and the in-flight balls as lattice coordinates (level 0..rows, k rights, both may be fractional). */
export function galtonAt(sim, timeline, t) {
  const counts = new Array(sim.rows + 1).fill(0);
  const flying = [];
  for (let i = 0; i < sim.balls; i++) {
    const age = t - i * timeline.gap;
    if (age < 0) break;
    if (age >= timeline.drop) { counts[sim.binOf[i]]++; continue; }
    const progress = (age / timeline.drop) * sim.rows;
    const level = Math.floor(progress);
    const part = progress - level;
    let k = 0;
    for (let r = 0; r < level; r++) k += sim.paths[i][r];
    flying.push({ level: progress, k: k + sim.paths[i][level] * part });
  }
  return { counts, flying };
}

// ---- drawing ------------------------------------------------------------------------------------------------------------------------------------
const SETTLED = new WeakMap(); // stage element -> JSON of the data it already ran: a resize or an options change does not replay the drop
const fixed = (v) => (Number.isFinite(v) ? v.toFixed(STAT_DECIMALS) : NO_VALUE);
const pct = (frac) => `${(frac * PERCENT).toFixed(1)}%`;

function paintBoard(canvas, rows, flying) {
  const g = canvas.getContext?.('2d');
  if (!g) return;
  const dpr = globalThis.devicePixelRatio || 1;
  const w = canvas.clientWidth || canvas.width / dpr;
  const hh = canvas.clientHeight || canvas.height / dpr;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(hh * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(hh * dpr); }
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, hh);
  const dx = w / (rows + 1);
  const dy = (hh - 2 * BOARD_PAD_PX) / rows;
  const pegR = clamp(Math.min(dx, dy) * PEG_FRAC, PEG_R_MIN_PX, PEG_R_MAX_PX);
  const ballR = pegR * BALL_TO_PEG;
  const at = (level, k) => [w / 2 + (k - level / 2) * dx, BOARD_PAD_PX + level * dy];
  const pal = themeColors(canvas, { peg: 'var(--ui-line-hi)', ball: 'var(--work-accent, var(--ui-acc))' });
  g.fillStyle = pal.peg;
  for (let level = 0; level < rows; level++) for (let k = 0; k <= level; k++) { const [x, y] = at(level, k); g.beginPath(); g.arc(x, y, pegR, 0, TAU); g.fill(); }
  g.fillStyle = pal.ball;
  for (const b of flying) { const [x, y] = at(b.level, b.k); g.beginPath(); g.arc(x, y - pegR - ballR, ballR, 0, TAU); g.fill(); }
}

function buildHistogram(ctx, model) {
  const { rows, balls, pmf, obsFrac, obs, yMax } = model;
  const n = rows + 1;
  const cols = h('div.pa-galton-cols', { style: { 'grid-template-columns': `repeat(${n},minmax(0,1fr))` } });
  const bars = [];
  const line = (frac) => Array.from({ length: n }, (_, j) => `${j + 0.5},${1 - frac(j) / yMax}`).join(' ');
  for (let j = 0; j < n; j++) {
    const bar = h('div.pa-galton-bar');
    bars.push(bar);
    cols.append(h('div.pa-galton-col', null, bar,
      h('span.pa-galton-dot', { style: { bottom: `${(pmf[j] / yMax) * PERCENT}%` } }),
      obsFrac ? h('span.pa-galton-obs', { style: { bottom: `${(obsFrac[j] / yMax) * PERCENT}%` } }) : null));
  }
  const curve = h('svg.pa-galton-curve', { viewBox: `0 0 ${n} 1`, preserveAspectRatio: 'none', 'aria-hidden': 'true' },
    h('polyline.pa-galton-theory', { points: line((j) => pmf[j]), fill: 'none' }),
    obsFrac ? h('polyline.pa-galton-observed', { points: line((j) => obsFrac[j]), fill: 'none' }) : null);
  const title = (j, count) => [`${word(ctx, 'bin', 'bin')} ${j}: ${count} of ${balls} ${word(ctx, 'balls', 'balls')} (${pct(count / balls)})`, `${word(ctx, 'binomial', 'binomial')} ${pct(pmf[j])}`,
    obs ? `${word(ctx, 'observed', 'observed')} ${obs[j]} (${pct(obsFrac[j])})` : null].filter(Boolean).join('; ');
  let shown = -1;
  return {
    bars: h('div.pa-galton-bars', null, cols, curve),
    labels: h('div.pa-galton-lbls', { style: { 'grid-template-columns': `repeat(${n},minmax(0,1fr))` } }, Array.from({ length: n }, (_, j) => h('span', null, String(j)))),
    apply(counts) {
      const total = counts.reduce((a, b) => a + b, 0);
      if (total === shown) return;
      shown = total;
      bars.forEach((bar, j) => { bar.style.height = `${(counts[j] / balls / yMax) * PERCENT}%`; cols.children[j].setAttribute('title', title(j, counts[j])); });
    },
  };
}

function drawGalton(ctx) {
  const { rows, balls, seed, p: pIn, observed } = ctx.data;
  const p = pIn ?? P_DEFAULT;
  const sim = galtonSim({ rows, balls, seed, p });
  const pmf = binomialPmf(rows, p);
  const theory = binomialStats(rows, p);
  const made = histogramStats(sim.bins);
  const obsTotal = observed ? observed.reduce((a, b) => a + b, 0) : 0;
  const obsFrac = obsTotal > 0 ? observed.map((c) => c / obsTotal) : null;
  const yMax = Math.max(...pmf, ...sim.bins.map((c) => c / balls), ...(obsFrac ?? [])) * Y_PAD;
  const box = workBox(ctx);
  addClass(box, 'pa-galton');
  if (compactMode(ctx)) box.setAttribute('data-narrow', '');
  const hist = buildHistogram(ctx, { rows, balls, pmf, obs: observed, obsFrac, yMax });
  const canvas = h('canvas.pa-galton-board', { 'aria-hidden': 'true' });
  const plot = h('div.pa-galton-plot', { role: 'img', 'aria-label': `${rows} ${word(ctx, 'rows', 'rows')}, ${balls} ${word(ctx, 'balls', 'balls')}, p ${fixed(p)}` },
    h('div.pa-galton-field', null, canvas), h('div.pa-galton-hist', null, hist.bars, hist.labels));
  if (!ctx.h) plot.style.height = `${clamp(ctx.w * PLOT_ASPECT, PLOT_MIN_PX, PLOT_MAX_PX)}px`;
  const swatch = (cls, text) => h('span.pa-galton-keyitem', null, h(`i.${cls}`), text);
  const observedStats = histogramStats(observed ?? []);
  box.append(
    h('div.pa-galton-head', null,
      h('strong', null, `n ${rows} ${word(ctx, 'rows', 'rows')} · p ${fixed(p)} · ${word(ctx, 'mean', 'mean')} ${fixed(theory.mean)} · ${word(ctx, 'sd', 'sd')} ${fixed(theory.sd)}`),
      h('span.pa-work-muted', null, `${balls} ${word(ctx, 'balls', 'balls')} · ${word(ctx, 'simulated', 'simulated')} ${word(ctx, 'mean', 'mean')} ${fixed(made.mean)} · ${word(ctx, 'sd', 'sd')} ${fixed(made.sd)}`),
      obsFrac ? h('span.pa-work-muted', null, `${word(ctx, 'observed', 'observed')} n ${obsTotal} · ${word(ctx, 'mean', 'mean')} ${fixed(observedStats.mean)} · ${word(ctx, 'sd', 'sd')} ${fixed(observedStats.sd)}`) : null),
    plot,
    h('div.pa-galton-legend.pa-work-muted', null, swatch('pa-galton-sw-sim', word(ctx, 'simulated', 'simulated')), swatch('pa-galton-sw-theory', `${word(ctx, 'binomial', 'binomial')} (n ${rows}, p ${fixed(p)})`),
      obsFrac ? swatch('pa-galton-sw-obs', word(ctx, 'observed', 'observed')) : null, word(ctx, 'bin', 'bin: right bounces')));
  const timeline = galtonTimeline(rows, balls);
  const render = (t) => { const state = galtonAt(sim, timeline, t); hist.apply(state.counts); paintBoard(canvas, rows, state.flying); };
  const dataKey = JSON.stringify(ctx.data);
  const settle = () => { render(timeline.total); SETTLED.set(ctx.root, dataKey); };
  if (ctx.reduced || !canAnimate() || SETTLED.get(ctx.root) === dataKey) { settle(); return undefined; }
  render(0);
  return frameLoop(canvas, (ms) => { if (ms >= timeline.total) { settle(); return false; } render(ms); return true; }, { onDetach: settle });
}

export const galton = defineAsset({
  kind: KIND, html: true, custom: true,
  shape: 'A distribution emerges from many random choices: balls drop through pegs, a histogram builds up against the theoretical binomial curve, and an observed series can be compared.',
  summary: 'A Galton board: pegs, falling balls, a live histogram with the binomial curve, n/p/mean/sd in the header, and an optional observed series.',
  keys: ['rows', 'balls', 'seed', 'p', 'observed'],
  sample: SAMPLE,
  validate: (data) => validateWork(KIND, data),
  draw: drawGalton,
});

addCss(`
.pa-galton-head { display:flex; flex-direction:column; gap:2px; }
.pa-galton-head strong { color:var(--work-accent); }
.pa-galton-plot { display:flex; flex-direction:column; gap:4px; min-height:${PLOT_MIN_PX}px; flex:1 1 auto; min-width:0; }
.pa-galton-field { position:relative; flex:${BOARD_FLEX} 1 0; min-height:0; }
.pa-galton-board { position:absolute; inset:0; width:100%; height:100%; display:block; }
.pa-galton-hist { flex:${HIST_FLEX} 1 0; min-height:0; display:flex; flex-direction:column; border-top:1px solid var(--ui-line); }
.pa-galton-bars { position:relative; flex:1 1 0; min-height:0; }
.pa-galton-cols { position:absolute; inset:0; display:grid; }
.pa-galton-col { position:relative; display:flex; align-items:flex-end; justify-content:center; min-width:0; }
.pa-galton-bar { width:70%; height:0; background:var(--work-accent); border-radius:2px 2px 0 0; opacity:.85; }
.pa-galton-dot { position:absolute; left:50%; width:8px; height:8px; margin:0 0 -4px -4px; border-radius:50%; background:var(--ui-c3); border:1px solid var(--ui-card); }
.pa-galton-obs { position:absolute; left:50%; width:8px; height:8px; margin:0 0 -4px -4px; border:2px solid var(--ui-c2); background:var(--ui-card); }
.pa-galton-curve { position:absolute; inset:0; width:100%; height:100%; overflow:visible; pointer-events:none; }
.pa-galton-curve polyline { vector-effect:non-scaling-stroke; stroke-width:2; stroke-linejoin:round; }
.pa-galton-theory { stroke:var(--ui-c3); }
.pa-galton-observed { stroke:var(--ui-c2); stroke-dasharray:4 3; }
.pa-galton-lbls { display:grid; color:var(--ui-mut); font-size:max(12px,.85em); font-variant-numeric:tabular-nums; text-align:center; line-height:1.3; }
.pa-galton-legend { display:flex; flex-wrap:wrap; gap:2px 12px; align-items:center; font-size:max(12px,.85em); }
.pa-galton-keyitem { display:inline-flex; align-items:center; gap:5px; }
.pa-galton-keyitem i { display:inline-block; width:12px; height:10px; }
.pa-galton-sw-sim { background:var(--work-accent); border-radius:2px; }
.pa-galton-sw-theory { height:3px; background:var(--ui-c3); }
.pa-galton-sw-obs { border:2px solid var(--ui-c2); width:10px; height:10px; }
.pa-galton[data-narrow] { gap:4px; }
.pa-galton[data-narrow] .pa-galton-head { font-size:max(12px,.88em); gap:0; line-height:1.3; }
.pa-galton[data-narrow] .pa-galton-plot { min-height:${PLOT_MIN_PX - 40}px; }
.pa-galton[data-narrow] .pa-galton-legend { gap:0 10px; line-height:1.3; }
`);
