// particles.js - `particles`: a rate or load made visible. One pixel-art emitter lane per series; the density of the particles IS the reading
// (alive particles = rate / max x MAX_PARTICLES_PER_LANE), with the number and unit under each lane. Pixel art: integer pixel scale, nearest-neighbour,
// colours read from the --ui-* variables at draw time. The state is a pure function of (series, elapsed seconds, seed) so counts are exact in tests;
// the loop runs only while the figure is attached and visible, throttled, and not at all under prefers-reduced-motion (one static frame at steady state).
import { defineAsset, h, clamp, fmt } from './core.js';
import { addCss } from '../ui/core.js';
import { validateWork, PARTICLE_STYLES } from './work-schema.js';
import { workBox, rows } from './custom.js';
import { unitHash, SEED_DEFAULT, addClass, compactMode, canAnimate, themeColors, frameLoop } from './motion.js';

const KIND = 'particles';
export const MAX_PARTICLES_PER_LANE = 48;
export const PARTICLE_LIFETIME_S = 1.6;
export const STEADY_STATE_S = PARTICLE_LIFETIME_S * 2; // every emission slot is filled from then on
const STYLE_DEFAULT = PARTICLE_STYLES[0];
const PERCENT = 100;
const FPS = 24;
// Per-style motion, in lane units (0 = emitter edge, 1 = far edge).
const SPARK_REACH_MIN = 0.45;
const SPARK_DRIFT = 0.5;
const FLOW_TRACKS = 4;
const FLOW_FADE_FROM = 0.85;
const SALT = Object.freeze({ across: 1, reach: 2, drift: 3 }); // decorrelates the hashes of one particle
// Layout and pixel art.
const PIXEL_SCALE = 3;
const PIXEL_SCALE_COMPACT = 2;
const LANE_MIN_PX = 76; // narrower lanes switch to one row per lane
const FIELD_ASPECT = 0.36;
const FIELD_MIN_PX = 96;
const FIELD_MAX_PX = 220;
const ROW_FIELD_MIN_PX = 30;
const ROW_LABEL_PCT = 38;
const FADE_STEPS = 4;
const EMITTER_PX = 2;
const TONE_CSS = Object.freeze({ ok: 'var(--ui-ok)', warn: 'var(--ui-warn)', danger: 'var(--ui-danger)', info: 'var(--ui-acc)' });
const TONE_DEFAULT = 'info';
const SAMPLE = { unit: 'events/s', style: 'sparks', series: [{ label: 'Ingest', rate: 1200, max: 2000, tone: 'ok' }, { label: 'Queue', rate: 1650, max: 2000, tone: 'warn' }, { label: 'Errors', rate: 90, max: 2000, tone: 'danger' }] };

// ---- pure: which particles exist at time `dt` ---------------------------------------------------------------------------------------------
const easeOut = (t) => 1 - (1 - t) ** 2;
/** The reference scale of a lane: its own `max`, else the busiest series (so density is relative when no max is given). */
export const laneScale = (series, lane) => lane.max ?? Math.max(...series.map((s) => s.rate), Number.EPSILON);
/** How many particles are alive in a lane at steady state: rate / max, capped, times MAX_PARTICLES_PER_LANE (at least one while the rate is above zero). */
export const laneTarget = (rate, max) => { const frac = clamp(rate / max, 0, 1); return frac > 0 ? Math.ceil(frac * MAX_PARTICLES_PER_LANE) : 0; };
const fadeAt = (style, age) => (style === 'sparks' ? 1 - age : style === 'flow' && age > FLOW_FADE_FROM ? (1 - age) / (1 - FLOW_FADE_FROM) : 1);
/**
 * (series, dt seconds since the lanes started, seed, style) -> per lane { target, particles: [{ u, v, fade }] }. u is the distance from the emitter
 * (0..1), v the position across the lane (0..1), fade the opacity (0..1). Lane i emits target/lifetime particles a second, one per slot, so the alive
 * count is within one of target once dt >= STEADY_STATE_S. The same inputs always give the same state.
 */
export function particleState(series, dt, seed = SEED_DEFAULT, style = STYLE_DEFAULT) {
  return series.map((lane, i) => {
    const target = laneTarget(lane.rate, laneScale(series, lane));
    const particles = [];
    if (target > 0) {
      const slot = PARTICLE_LIFETIME_S / target;
      for (let k = Math.max(0, Math.floor((dt - PARTICLE_LIFETIME_S) / slot)); k <= Math.floor(dt / slot); k++) {
        const born = (k + unitHash(seed, i, k)) * slot;
        const age = (dt - born) / PARTICLE_LIFETIME_S;
        if (age < 0 || age >= 1) continue;
        const across = unitHash(seed + SALT.across, i, k);
        let u = age;
        let v = across;
        if (style === 'sparks') {
          u = (SPARK_REACH_MIN + (1 - SPARK_REACH_MIN) * unitHash(seed + SALT.reach, i, k)) * easeOut(age);
          v = clamp(across + (unitHash(seed + SALT.drift, i, k) - 0.5) * SPARK_DRIFT * age, 0, 1);
        } else if (style === 'flow') v = ((k % FLOW_TRACKS) + 0.5) / FLOW_TRACKS;
        particles.push({ u, v, fade: fadeAt(style, age) });
      }
    }
    return { target, particles };
  });
}

// ---- drawing ------------------------------------------------------------------------------------------------------------------------------------
const tipText = (lane, max, unit) => `${lane.label}: ${fmt(lane.rate, unit)} (${Math.round(clamp(lane.rate / max, 0, 1) * PERCENT)}% of ${fmt(max, unit)}${lane.rate > max ? ', above max' : ''}${lane.tone ? `; ${lane.tone}` : ''})`;

function paintLane(canvas, state, color, style, horizontal) {
  const g = canvas.getContext?.('2d');
  if (!g) return;
  const { width: lw, height: lh } = canvas;
  g.clearRect(0, 0, lw, lh);
  g.fillStyle = color;
  g.globalAlpha = 1;
  const fromTop = style === 'rain' && !horizontal; // rain falls from its emitter at the top; everything else rises from the bottom or leaves the left
  if (horizontal) g.fillRect(0, 0, EMITTER_PX, lh); else g.fillRect(0, fromTop ? 0 : lh - EMITTER_PX, lw, EMITTER_PX);
  const w = style === 'flow' ? 2 : horizontal && style === 'rain' ? 2 : 1;
  const hh = style === 'flow' ? 2 : !horizontal && style === 'rain' ? 2 : 1;
  for (const p of state.particles) {
    const along = Math.round(p.u * ((horizontal ? lw : lh) - 1));
    const across = Math.round(p.v * ((horizontal ? lh : lw) - 1));
    g.globalAlpha = Math.ceil(p.fade * FADE_STEPS) / FADE_STEPS;
    if (horizontal) g.fillRect(along, across, w, hh); else g.fillRect(across, fromTop ? along : lh - 1 - along, w, hh);
  }
  g.globalAlpha = 1;
}

function drawParticles(ctx) {
  const { unit, series } = ctx.data;
  const style = ctx.data.style ?? STYLE_DEFAULT;
  const seed = SEED_DEFAULT;
  const box = workBox(ctx);
  addClass(box, 'pa-part');
  const compact = compactMode(ctx);
  if (compact) box.setAttribute('data-narrow', '');
  const scale = compact ? PIXEL_SCALE_COMPACT : PIXEL_SCALE;
  const shown = Math.min(series.length, ctx.custom.maxRows);
  const horizontal = shown * LANE_MIN_PX > ctx.w;
  const lanes = h('div.pa-part-lanes', { 'data-layout': horizontal ? 'rows' : 'columns', style: horizontal ? {} : { 'grid-template-columns': `repeat(${shown},minmax(0,1fr))` } });
  box.append(lanes);
  const fields = [];
  rows(ctx, lanes, series, (lane, i) => {
    const max = laneScale(series, lane);
    const canvas = h('canvas.pa-part-canvas', { 'aria-hidden': 'true' });
    const field = h('div.pa-part-field', null, canvas);
    if (!horizontal && !ctx.h) field.style.height = `${clamp(ctx.w * FIELD_ASPECT, FIELD_MIN_PX, FIELD_MAX_PX)}px`;
    fields.push({ canvas, field, i, tone: lane.tone ?? TONE_DEFAULT });
    return h('section.pa-part-lane', { title: tipText(lane, max, unit) }, field,
      h('div.pa-part-text', null, h('span.pa-part-name', null, lane.label), h('strong.pa-part-value', null, fmt(lane.rate, unit))));
  }, box);
  if (horizontal) lanes.style.setProperty('--pa-part-label', `${ROW_LABEL_PCT}%`);
  for (const f of fields) { // size each canvas to a whole number of art pixels, measured now that the lanes are laid out
    const w = f.field.clientWidth || ctx.w;
    const hh = f.field.clientHeight || (horizontal ? ROW_FIELD_MIN_PX : FIELD_MIN_PX);
    f.canvas.width = Math.max(1, Math.floor(w / scale));
    f.canvas.height = Math.max(1, Math.floor(hh / scale));
    f.canvas.style.width = `${f.canvas.width * scale}px`;
    f.canvas.style.height = `${f.canvas.height * scale}px`;
  }
  const draw = (dt) => {
    const state = particleState(series, dt, seed, style);
    const colors = themeColors(box, TONE_CSS);
    for (const f of fields) paintLane(f.canvas, state[f.i], colors[f.tone], style, horizontal);
  };
  if (ctx.reduced || !canAnimate()) { draw(STEADY_STATE_S); return undefined; }
  draw(0);
  return frameLoop(box, (ms) => { draw(ms / 1000); return true; }, { intervalMs: 1000 / FPS, onDetach: () => draw(STEADY_STATE_S) });
}

export const particles = defineAsset({
  kind: KIND, html: true, custom: true,
  shape: 'A rate or load per source, where how dense the stream is should be the reading: one emitter lane per series, with the number and unit under it.',
  summary: 'Pixel-art emitter lanes (sparks, rain or flow) whose particle density is rate over max, with the value and unit labelled under each lane.',
  keys: ['unit', 'series', 'style'],
  sample: SAMPLE,
  validate: (data) => validateWork(KIND, data),
  draw: drawParticles,
});

addCss(`
.pa-part-lanes { display:grid; gap:10px; flex:1 1 auto; min-height:0; grid-auto-rows:minmax(0,1fr); }
.pa-part-lanes[data-layout="rows"] { grid-auto-rows:auto; gap:6px; }
.pa-part-lane { display:flex; flex-direction:column; gap:4px; min-width:0; min-height:0; }
.pa-part-field { position:relative; flex:1 1 auto; min-height:${FIELD_MIN_PX}px; overflow:hidden; background:var(--ui-card-hi); border:1px solid var(--ui-line); border-radius:var(--ui-r-s); }
.pa-part-canvas { position:absolute; left:0; top:0; display:block; image-rendering:pixelated; image-rendering:crisp-edges; }
.pa-part-text { display:flex; flex-direction:column; align-items:center; text-align:center; line-height:1.25; min-width:0; }
.pa-part-name { color:var(--ui-mut); overflow-wrap:anywhere; }
.pa-part-value { font-variant-numeric:tabular-nums; overflow-wrap:anywhere; }
.pa-part-lanes[data-layout="rows"] .pa-part-lane { display:grid; grid-template-columns:minmax(0,var(--pa-part-label,${ROW_LABEL_PCT}%)) minmax(0,1fr); align-items:stretch; gap:8px; }
.pa-part-lanes[data-layout="rows"] .pa-part-text { grid-column:1; grid-row:1; align-items:flex-start; text-align:left; justify-content:center; }
.pa-part-lanes[data-layout="rows"] .pa-part-field { grid-column:2; grid-row:1; min-height:${ROW_FIELD_MIN_PX}px; }
.pa-part[data-narrow] .pa-part-text { font-size:max(12px,.88em); }
.pa-part[data-narrow] .pa-part-lanes { gap:6px; }
.pa-part[data-narrow] .pa-part-field { min-height:${FIELD_MIN_PX - 24}px; }
.pa-part[data-narrow] .pa-part-lanes[data-layout="rows"] .pa-part-field { min-height:${ROW_FIELD_MIN_PX}px; }
`);
