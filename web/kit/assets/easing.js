import { defineAsset, h, s, txt, tip, catColor, reducedMotion } from './core.js';
import { validateWork } from './work-schema.js';
import { headline, muted, rows, word } from './custom.js';
import { mediaBox, plot, timeAxis, compact, measure, MIN_FONT, PAD, AXIS_BOTTOM, PLOT_HEIGHT, COMPACT_PLOT_HEIGHT, STROKE, HALF, ZERO, ONE, MS_PER_SECOND } from './media.js';
const KIND = 'easing';
const DEFAULT_POWER = 3;
const DEFAULT_DAMPING = 6;
const DEFAULT_FREQUENCY = 2;
const DEFAULT_STEPS = 5;
const BOUNCE_SCALE = 7.5625;
const BOUNCE_DIVISOR = 2.75;
const BOUNCE_SEGMENTS = [[1, 0, 0], [2, 1.5, 0.75], [2.5, 2.25, 0.9375], [Infinity, 2.625, 0.984375]];
const SAMPLES = 200;
const VELOCITY_DELTA = ONE / SAMPLES;
const DOT_RADIUS = 4;
const Y_MARGIN = 0.12;
const LEFT_PAD = 42;
const PLAYBACK_FPS = 30;
const FRAME_MS = MS_PER_SECOND / PLAYBACK_FPS;
const MARKER_DASH = '3 3';
const mounted = new WeakSet();
/** Pure progress at normalized time (0..1). Spring endpoints are normalized without suppressing overshoot. */
export function easingAt(kind, time, params = {}) {
  const t = Math.max(ZERO, Math.min(ONE, time));
  if (t === ZERO || t === ONE) return t;
  const power = params.power ?? DEFAULT_POWER;
  switch (kind) {
    case 'linear': return t;
    case 'easeIn': return t ** power;
    case 'easeOut': return ONE - (ONE - t) ** power;
    case 'easeInOut': return t < HALF ? (STROKE * t) ** power * HALF : ONE - (STROKE * (ONE - t)) ** power * HALF;
    case 'spring': {
      const damping = params.damping ?? DEFAULT_DAMPING;
      const omega = STROKE * Math.PI * (params.frequency ?? DEFAULT_FREQUENCY);
      return (ONE - Math.exp(-damping * t) * Math.cos(omega * t)) / (ONE - Math.exp(-damping) * Math.cos(omega));
    }
    case 'bounce': {
      const [ , offset, base] = BOUNCE_SEGMENTS.find(([edge]) => t < edge / BOUNCE_DIVISOR);
      return BOUNCE_SCALE * (t - offset / BOUNCE_DIVISOR) ** STROKE + base;
    }
    case 'steps': return Math.floor(t * (params.steps ?? DEFAULT_STEPS)) / (params.steps ?? DEFAULT_STEPS);
    default: throw new Error(`Unknown easing kind: ${kind}`);
  }
}
export function velocityPeak(curve, durationMs) {
  if (curve.kind === 'steps') return Infinity;
  let peak = ZERO;
  for (let i = ONE; i <= SAMPLES; i++) peak = Math.max(peak, Math.abs(easingAt(curve.kind, i / SAMPLES, curve.params) - easingAt(curve.kind, (i - ONE) / SAMPLES, curve.params)) / VELOCITY_DELTA);
  return peak * MS_PER_SECOND / durationMs;
}
// A bounded single pass. An update or resize leaves dots at their final state; it never replays pacing.
function playOnce(ctx, dots, position) {
  const already = mounted.has(ctx.root);
  mounted.add(ctx.root);
  const final = () => dots.forEach((dot, i) => position(dot, i, ONE));
  if (ctx.reduced || already) { final(); return; }
  let raf = ZERO;
  let start;
  let last = -Infinity;
  let stopped = false;
  const step = (now) => {
    raf = ZERO;
    if (stopped || !ctx.root.isConnected) return;
    if (reducedMotion()) { final(); return; }
    start ??= now;
    const progress = Math.min(ONE, (now - start) / ctx.data.durationMs);
    if (now - last >= FRAME_MS || progress === ONE) {
      dots.forEach((dot, i) => position(dot, i, progress));
      last = now;
    }
    if (progress < ONE) raf = requestAnimationFrame(step);
  };
  dots.forEach((dot, i) => position(dot, i, ZERO));
  raf = requestAnimationFrame(step);
  return () => { stopped = true; cancelAnimationFrame(raf); };
}
export const easing = defineAsset({
  kind: KIND, html: true, custom: true,
  shape: 'Motion curves map elapsed time to progress, with timing markers and peak velocities.',
  summary: 'Shared time and progress axes compare easing curves; dots trace one pass of their pacing.',
  keys: ['durationMs', 'curves', 'markers'],
  sample: { durationMs: 1600, curves: [{ label: 'Steady', kind: 'linear' }, { label: 'Soft start', kind: 'easeInOut', params: { power: 3 } }, { label: 'Settle', kind: 'spring', params: { damping: 6, frequency: 2 } }], markers: [{ label: 'Reveal', atMs: 800 }] },
  validate: (data) => validateWork(KIND, data),
  draw(ctx) {
    const { data, w, fs } = ctx;
    const box = mediaBox(ctx);
    box.append(headline(`${measure(data.durationMs)} ms · ${data.curves.length} ${word(ctx, 'curves')}`));
    const curves = data.curves.slice(ZERO, ctx.custom.maxRows);
    const values = curves.map((curve) => Array.from({ length: SAMPLES + ONE }, (_, i) => easingAt(curve.kind, i / SAMPLES, curve.params)));
    const low = Math.min(ZERO, ...values.flat()) - Y_MARGIN;
    const high = Math.max(ONE, ...values.flat()) + Y_MARGIN;
    const height = compact(ctx) ? COMPACT_PLOT_HEIGHT : PLOT_HEIGHT;
    const bottom = height - AXIS_BOTTOM;
    const right = w - PAD;
    const x = (t) => LEFT_PAD + (right - LEFT_PAD) * t;
    const y = (progress) => PAD + (high - progress) / (high - low) * (bottom - PAD);
    const svg = plot(box, w, height, 'Elapsed time in milliseconds versus progress (0–1)');
    for (const level of [ZERO, ONE]) {
      svg.append(s('line', { x1: LEFT_PAD, x2: right, y1: y(level), y2: y(level), class: 'pa-grid' }));
      txt(svg, PAD, y(level), String(level), { size: Math.max(MIN_FONT, fs), cls: 'pa-m' });
    }
    for (const marker of (data.markers ?? []).slice(ZERO, ctx.custom.maxRows)) svg.append(tip(s('line', { x1: x(marker.atMs / data.durationMs), x2: x(marker.atMs / data.durationMs), y1: PAD, y2: bottom, stroke: 'var(--ui-mut)', 'stroke-dasharray': MARKER_DASH }), `${marker.label}: ${measure(marker.atMs)} ms`));
    const dots = [];
    curves.forEach((curve, index) => {
      let d;
      if (curve.kind === 'steps') {
        const steps = curve.params?.steps ?? DEFAULT_STEPS;
        d = `M${x(ZERO)},${y(ZERO)}`;
        for (let i = ONE; i <= steps; i++) d += `H${x(i / steps)}V${y(i / steps)}`;
      } else d = values[index].map((v, i) => `${i === ZERO ? 'M' : 'L'}${x(i / SAMPLES)},${y(v)}`).join('');
      const color = index === ZERO ? 'var(--work-accent)' : catColor(index);
      svg.append(tip(s('path', { class: 'pa-easing-curve', d, fill: 'none', stroke: color, 'stroke-width': STROKE }), `${curve.label} · ${curve.kind} · ${measure(data.durationMs)} ms`));
      const dot = tip(s('circle', { class: 'pa-easing-dot', r: DOT_RADIUS, fill: color, stroke: 'var(--ui-card)', 'stroke-width': STROKE }), `${curve.label}: pacing over ${measure(data.durationMs)} ms`);
      dots.push(dot);
      svg.append(dot);
    });
    timeAxis(svg, { left: LEFT_PAD, right, bottom, end: data.durationMs, unit: 'ms', fs });
    const legend = h('div.pa-media-legend');
    box.append(legend);
    rows(ctx, legend, data.curves, (curve, i) => {
      const peak = velocityPeak(curve, data.durationMs);
      return h('span.pa-media-item', { title: `${curve.label}: ${curve.kind}`, style: { 'border-color': i === ZERO ? 'var(--work-accent)' : catColor(i) } }, `${curve.label} · ${word(ctx, 'velocityPeak', 'peak velocity')} ${Number.isFinite(peak) ? measure(peak) : '∞ (jumps)'} /s`);
    });
    rows(ctx, box, data.markers ?? [], (marker) => muted(`${marker.label} · ${measure(marker.atMs)} ms`));
    return playOnce(ctx, dots, (dot, i, t) => {
      dot.setAttribute('cx', x(t));
      dot.setAttribute('cy', y(easingAt(curves[i].kind, t, curves[i].params)));
    });
  },
});
