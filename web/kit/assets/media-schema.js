// Media contracts also feed the generated host validators. All timing values carry explicit units.
import { AssetError, check, LIMITS } from './core.js';
export const CURVE_KINDS = ['linear', 'easeIn', 'easeOut', 'easeInOut', 'spring', 'bounce', 'steps'];
export const SHOT_STATES = ['planned', 'rendering', 'done', 'failed'];
const MAX_ROWS = 40;
const MAX_CURVES = 8;
const MAX_STEPS = 100;
const MAX_POWER = 8;
const MAX_DAMPING = 30;
const MAX_FREQUENCY = 10;
const FRAME_SUM_TERMS = 2;
const text = { type: 'string', max: LIMITS.text };
const nonnegative = { type: 'number', min: 0 };
const positive = { ...nonnegative, exclusiveMin: true };
const frame = { ...nonnegative, integer: true, max: Number.MAX_SAFE_INTEGER / FRAME_SUM_TERMS };
const optional = (schema) => ({ ...schema, optional: true });
const object = (fields) => ({ type: 'object', fields });
const array = (item, max = MAX_ROWS, min = 0) => ({ type: 'array', item, min, max });
const enumeration = (values) => ({ type: 'enum', values });
export const MEDIA_SCHEMAS = {
  waveform: object({ unit: optional(enumeration(['s'])), durationS: positive, peaks: optional(array({ ...nonnegative, max: 1 }, LIMITS.points)), onsets: array(nonnegative, LIMITS.points), bpm: optional(positive), playheadS: optional(nonnegative), sections: optional(array(object({ label: text, fromS: nonnegative, toS: positive }))) }),
  shotlist: object({ fps: positive, shots: array(object({ id: text, label: text, startFrame: frame, frames: { ...frame, min: 1 }, tool: optional(text), style: optional(text), state: optional(enumeration(SHOT_STATES)), beatAligned: optional({ type: 'boolean' }) }), MAX_ROWS, 1), beatsAtFrames: optional(array(frame, LIMITS.points)) }),
  easing: object({ durationMs: positive, curves: array(object({ label: text, kind: enumeration(CURVE_KINDS), params: optional(object({ power: optional({ ...positive, max: MAX_POWER }), damping: optional({ ...positive, max: MAX_DAMPING }), frequency: optional({ ...positive, max: MAX_FREQUENCY }), steps: optional({ ...positive, integer: true, max: MAX_STEPS }) })) }), MAX_CURVES, 1), markers: optional(array(object({ label: text, atMs: nonnegative }))) }),
};
export function mediaRelations(kind, data) {
  const within = (value, end, path) => { if (value > end) throw new AssetError(`${path} must be within the duration (${end})`); };
  if (kind === 'waveform') {
    data.onsets.forEach((at, i) => within(at, data.durationS, `data.onsets[${i}]`));
    if (data.playheadS !== undefined) within(data.playheadS, data.durationS, 'data.playheadS');
    data.sections?.forEach((section, i) => {
      if (section.toS <= section.fromS) throw new AssetError(`data.sections[${i}].toS must be after fromS`);
      within(section.toS, data.durationS, `data.sections[${i}].toS`);
    });
  } else if (kind === 'shotlist') {
    const seen = new Set();
    data.shots.forEach((shot, i) => check.id(shot.id, `data.shots[${i}].id`, seen));
  } else if (kind === 'easing') {
    data.markers?.forEach((marker, i) => within(marker.atMs, data.durationMs, `data.markers[${i}].atMs`));
    const allowed = { linear: [], easeIn: ['power'], easeOut: ['power'], easeInOut: ['power'], spring: ['damping', 'frequency'], bounce: [], steps: ['steps'] };
    data.curves.forEach((curve, i) => {
      for (const key of Object.keys(curve.params ?? {})) if (curve.params[key] !== undefined && !allowed[curve.kind].includes(key)) throw new AssetError(`data.curves[${i}].params.${key} is not a parameter of ${curve.kind}`);
    });
  }
  return data;
}
