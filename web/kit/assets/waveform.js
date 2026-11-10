import { defineAsset, h, s, tip, catColor, soft } from './core.js';
import { validateWork } from './work-schema.js';
import { headline, muted, rows, word } from './custom.js';
import { mediaBox, plot, timeAxis, compact, measure, PAD, AXIS_BOTTOM, PLOT_HEIGHT, COMPACT_PLOT_HEIGHT, STROKE, HALF, ZERO, ONE } from './media.js';
const KIND = 'waveform';
const ENVELOPE_SHARE = 0.38;
const BAR_FILL = 0.7;
const BAND_FILL = 18;
const SECTION_Y = 4;
const GAP_DIGITS = 3;
export function medianGap(onsets) {
  const sorted = [...onsets].sort((a, b) => a - b);
  const gaps = sorted.slice(ONE).map((at, i) => at - sorted[i]).sort((a, b) => a - b);
  if (!gaps.length) return null;
  const middle = Math.floor(gaps.length * HALF);
  return gaps.length % STROKE ? gaps[middle] : (gaps[middle - ONE] + gaps[middle]) * HALF;
}
export const waveform = defineAsset({
  kind: KIND, html: true, custom: true,
  shape: 'An audio envelope has timed onsets, labelled sections and an optional measured playhead.',
  summary: 'Mirrored amplitude bars and onset ticks on a seconds axis, with tempo and onset spacing.',
  keys: ['unit', 'durationS', 'peaks', 'onsets', 'bpm', 'playheadS', 'sections'],
  sample: { unit: 's', durationS: 4, peaks: [0.1, 0.3, 0.8, 0.5, 0.2, 0.6, 1, 0.7, 0.2, 0.4, 0.9, 0.5, 0.1, 0.6, 0.8, 0.2], onsets: [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5], bpm: 120, playheadS: 1.75, sections: [{ label: 'Opening', fromS: 0, toS: 1 }, { label: 'Theme', fromS: 1, toS: 4 }] },
  validate: (data) => validateWork(KIND, data),
  draw(ctx) {
    const { data, w, fs } = ctx;
    const box = mediaBox(ctx);
    const gap = medianGap(data.onsets);
    box.append(headline(`${measure(data.durationS)} s · ${data.onsets.length} ${word(ctx, 'onsets')}`), muted(`${data.bpm === undefined ? word(ctx, 'tempoUnknown', 'Tempo unknown') : `${measure(data.bpm)} bpm`} · ${word(ctx, 'medianGap', 'median gap')} ${gap === null ? '—' : `${Number(gap.toFixed(GAP_DIGITS))} s`}`));
    const height = compact(ctx) ? COMPACT_PLOT_HEIGHT : PLOT_HEIGHT;
    const svg = plot(box, w, height, 'Audio amplitude 0–1 and onsets in seconds');
    const bottom = height - AXIS_BOTTOM;
    const center = (PAD + bottom) * HALF;
    const x = (at) => PAD + (w - PAD * STROKE) * at / data.durationS;
    const bands = (data.sections ?? []).slice(ZERO, ctx.custom.maxRows);
    bands.forEach((section, i) => svg.append(tip(s('rect', { x: x(section.fromS), y: SECTION_Y, width: x(section.toS) - x(section.fromS), height: bottom - SECTION_Y, fill: soft(catColor(i), BAND_FILL) }), `${section.label}: ${measure(section.fromS)}–${measure(section.toS)} s`)));
    svg.append(s('line', { x1: PAD, x2: w - PAD, y1: center, y2: center, class: 'pa-grid' }));
    const peaks = data.peaks ?? [];
    peaks.forEach((peak, i) => {
      const cell = (w - PAD * STROKE) / peaks.length;
      const amplitude = peak * (bottom - PAD) * ENVELOPE_SHARE;
      svg.append(tip(s('rect', { class: 'pa-wave-peak', x: PAD + (i + HALF) * cell - cell * BAR_FILL * HALF, y: center - amplitude, width: cell * BAR_FILL, height: Math.max(ONE, amplitude * STROKE), fill: 'var(--work-accent)' }), `${measure((i + HALF) / peaks.length * data.durationS)} s · amplitude ${measure(peak)} (0–1)`));
    });
    data.onsets.forEach((at) => svg.append(tip(s('line', { class: 'pa-wave-onset', x1: x(at), x2: x(at), y1: bottom - PAD, y2: bottom, stroke: 'var(--ui-fg)', 'stroke-width': STROKE }), `${word(ctx, 'onset')} ${measure(at)} s`)));
    if (data.playheadS !== undefined) svg.append(tip(s('line', { class: 'pa-wave-playhead', x1: x(data.playheadS), x2: x(data.playheadS), y1: PAD, y2: bottom, stroke: 'var(--ui-danger)', 'stroke-width': STROKE }), `${word(ctx, 'playhead')} ${measure(data.playheadS)} s`));
    timeAxis(svg, { left: PAD, right: w - PAD, bottom, end: data.durationS, unit: 's', fs });
    const legend = h('div.pa-media-legend');
    box.append(legend);
    rows(ctx, legend, data.sections ?? [], (section, i) => h('span.pa-media-item', { title: `${section.label}: ${section.fromS}–${section.toS} s`, style: { 'border-color': catColor(i) } }, `${section.label} · ${measure(section.fromS)}–${measure(section.toS)} s`));
  },
});
