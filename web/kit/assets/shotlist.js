import { defineAsset, h, s, txt, tip, toneColor } from './core.js';
import { validateWork } from './work-schema.js';
import { SHOT_STATES } from './media-schema.js';
import { headline, muted, row, word } from './custom.js';
import { mediaBox, plot, timeAxis, compact, measure, MIN_FONT, PAD, AXIS_BOTTOM, STROKE, HALF, ZERO, ONE } from './media.js';
const KIND = 'shotlist';
const ROW_HEIGHT = 38;
const BAR_HEIGHT = 16;
const LABEL_SHARE = 0.32;
const BEAT_ALPHA = 0.5;
const MARK_RADIUS = 4;
const STATE_TONES = Object.fromEntries(SHOT_STATES.map((state, i) => [state, ['neutral', 'info', 'ok', 'danger'][i]]));
const DEFAULT_STATE = SHOT_STATES[ZERO];
const DEFAULT_TOOL = 'Unassigned';
export const shotEnd = (shots) => Math.max(...shots.map((shot) => shot.startFrame + shot.frames));
export function groupedShots(shots) {
  const tools = [...new Set(shots.map((shot) => shot.tool ?? DEFAULT_TOOL))];
  return tools.flatMap((tool) => shots.filter((shot) => (shot.tool ?? DEFAULT_TOOL) === tool).sort((a, b) => a.startFrame - b.startFrame));
}
export const shotlist = defineAsset({
  kind: KIND, html: true, custom: true,
  shape: 'A video plan has shots with frame ranges, production tools, render states and beat alignment.',
  summary: 'Shots grouped by tool on a frame and seconds timeline, stacking into a list in small tiles.',
  keys: ['fps', 'shots', 'beatsAtFrames'],
  sample: { fps: 24, shots: [{ id: 'opening', label: 'Opening title', startFrame: 0, frames: 48, tool: 'Compositor', style: 'Type reveal', state: 'done', beatAligned: true }, { id: 'detail', label: 'Detail view', startFrame: 48, frames: 36, tool: 'Scene renderer', style: 'Close-up', state: 'rendering', beatAligned: true }, { id: 'closing', label: 'Closing card', startFrame: 90, frames: 30, tool: 'Compositor', state: 'planned', beatAligned: false }], beatsAtFrames: [0, 24, 48, 72, 96, 120] },
  validate: (data) => validateWork(KIND, data),
  draw(ctx) {
    const { data, w, fs } = ctx;
    const box = mediaBox(ctx);
    const end = shotEnd(data.shots);
    const beats = data.beatsAtFrames === undefined ? null : new Set(data.beatsAtFrames);
    const offBeat = (shot) => beats !== null ? !beats.has(shot.startFrame) : shot.beatAligned === false;
    const state = (shot) => shot.state ?? DEFAULT_STATE;
    const details = (shot) => `${shot.id} · ${shot.label} · ${shot.tool ?? DEFAULT_TOOL}${shot.style ? ` · ${shot.style}` : ''} · ${shot.startFrame}–${shot.startFrame + shot.frames} fr (${measure(shot.startFrame / data.fps)}–${measure((shot.startFrame + shot.frames) / data.fps)} s) · ${word(ctx, state(shot))}${offBeat(shot) ? ` · ${word(ctx, 'offBeat', 'off beat')}` : ''}`;
    box.append(headline(`${measure(end / data.fps)} s · ${end} fr · ${data.shots.length} ${word(ctx, 'shots')}`), muted(`${measure(data.fps)} fps · ${word(ctx, 'groupedByTool', 'grouped by tool')}`));
    const shown = groupedShots(data.shots).slice(ZERO, ctx.custom.maxRows);
    if (compact(ctx)) {
      for (const shot of shown) {
        const card = row(h('strong', null, `${shot.tool ?? DEFAULT_TOOL} · ${shot.label}`), muted(`${shot.startFrame}–${shot.startFrame + shot.frames} fr · ${measure(shot.startFrame / data.fps)}–${measure((shot.startFrame + shot.frames) / data.fps)} s`), h('span', { style: { color: toneColor(STATE_TONES[state(shot)]) } }, `${word(ctx, state(shot))}${offBeat(shot) ? ` · ◆ ${word(ctx, 'offBeat', 'off beat')}` : ''}${shot.style ? ` · ${shot.style}` : ''}`));
        card.setAttribute('title', details(shot));
        box.append(card);
      }
    } else {
      const left = w * LABEL_SHARE;
      const right = w - PAD;
      const bottom = PAD + shown.length * ROW_HEIGHT;
      const svg = plot(box, w, bottom + AXIS_BOTTOM + PAD, 'Shot ranges in frames and seconds, grouped by tool');
      const x = (frame) => left + (right - left) * frame / end;
      for (const beat of beats ?? []) if (beat <= end) svg.append(tip(s('line', { x1: x(beat), x2: x(beat), y1: PAD, y2: bottom, class: 'pa-grid', opacity: BEAT_ALPHA }), `${beat} fr · ${measure(beat / data.fps)} s`));
      shown.forEach((shot, i) => {
        const y = PAD + (i + HALF) * ROW_HEIGHT;
        tip(txt(svg, PAD, y, `${shot.tool ?? DEFAULT_TOOL} · ${shot.label}`, { size: Math.max(MIN_FONT, fs), maxW: left - PAD * STROKE }), details(shot));
        svg.append(tip(s('rect', { class: 'pa-shot-bar', x: x(shot.startFrame), y: y - BAR_HEIGHT * HALF, width: Math.max(ONE, x(shot.startFrame + shot.frames) - x(shot.startFrame)), height: BAR_HEIGHT, rx: STROKE, fill: toneColor(STATE_TONES[state(shot)]) }), details(shot)));
        if (offBeat(shot)) svg.append(tip(s('path', { class: 'pa-shot-offbeat', d: `M${x(shot.startFrame)},${y - BAR_HEIGHT}l${MARK_RADIUS},${MARK_RADIUS}l${-MARK_RADIUS},${MARK_RADIUS}l${-MARK_RADIUS},${-MARK_RADIUS}Z`, fill: 'var(--ui-warn)' }), `${shot.label}: ${word(ctx, 'offBeat', 'off beat')}`));
      });
      timeAxis(svg, { left, right, bottom, end, unit: 'fr', fs, secondary: (frame) => `${measure(frame / data.fps)} s` });
      const legend = h('div.pa-media-legend');
      for (const status of SHOT_STATES) legend.append(h('span', { style: { color: toneColor(STATE_TONES[status]) } }, word(ctx, status)));
      if (beats !== null) legend.append(h('span', null, `◆ ${word(ctx, 'offBeat', 'off beat')}`));
      box.append(legend);
    }
    const remaining = data.shots.length - shown.length;
    if (remaining > ZERO) box.append(muted(`+${remaining} ${word(ctx, 'more')}`));
  },
});
