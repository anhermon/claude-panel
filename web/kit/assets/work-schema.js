// Declarative data contracts shared with the generated host kind table.
import { AssetError, check, LIMITS } from './core.js';
import { MEDIA_SCHEMAS, mediaRelations } from './media-schema.js';
const MAX_ROWS = 40;
const MAX_CRITERIA = 8;
const MAX_EVIDENCE = 8;
const MAX_PAYLOAD = 12 * 1024;
const MIN_QUOTA_WINDOWS = 0; // Context or cost can be the only available reading.
export const PERCENT = 100;
export const QUOTA_WARN_PCT = 60;
export const QUOTA_DANGER_PCT = 85;
export const SCORE_MAX = 5;
const text = { type: 'string', max: LIMITS.text };
const long = { ...text, max: LIMITS.longText };
const number = { type: 'number', min: 0 };
const confidence = { ...number, max: 1 };
const pct = { ...number, max: PERCENT };
const optional = (s) => ({ ...s, optional: true });
const object = (fields) => ({ type: 'object', fields });
const array = (item, max = MAX_ROWS, min = 1) => ({ type: 'array', item, min, max });
const enumeration = (values) => ({ type: 'enum', values });
export const STATES = ['confirmed', 'testing', 'open', 'ruled-out'];
export const SOURCE_KINDS = ['primary', 'secondary', 'vendor', 'forum', 'unknown'];
export const PARTICLE_TONES = ['ok', 'warn', 'danger', 'info'];
export const PARTICLE_STYLES = ['sparks', 'rain', 'flow'];
export const GALTON_MIN_ROWS = 2;
export const GALTON_MAX_ROWS = 14;
export const GALTON_MAX_BALLS = 400;
export const PARTICLE_MAX_LANES = 8;
const SEED_MAX = 2 ** 32 - 1;
const POSITIVE_FLOOR = 1e-6; // schemas have no exclusive minimum: a reference scale must be above this
const item = (fields) => array(object(fields));
const quotaWindows = array(object({ label: text, usedPct: number, resetsAt: optional({ type: 'date' }), tone: optional(enumeration(['info', 'ok', 'warn', 'danger', 'neutral'])) }), MAX_ROWS, MIN_QUOTA_WINDOWS);
export const WORK_SCHEMAS = {
  ...MEDIA_SCHEMAS,
  testresults: object({ unit: optional(text), suites: item({ name: text, passed: number, failed: number, skipped: optional(number), ms: optional(number) }), failures: optional(array(object({ name: text, message: optional(long), file: optional(text) }), MAX_ROWS, 0)) }),
  hypotheses: object({ question: long, items: item({ id: text, label: text, state: enumeration(STATES), evidence: optional(array(long, MAX_EVIDENCE, 0)), confidence: optional(confidence) }) }),
  decisionmatrix: object({ options: item({ id: text, label: text }), criteria: array(object({ id: text, label: text, weight: number }), MAX_CRITERIA), scores: { type: 'map', item: { type: 'map', item: { ...number, max: SCORE_MAX } } }, chosen: optional(text) }),
  sources: object({ items: item({ title: text, url: optional({ type: 'url' }), kind: optional(enumeration(SOURCE_KINDS)), claim: optional(long), confidence: optional(confidence), date: optional(text) }) }),
  limits: { ...object({ windows: optional(quotaWindows), groups: optional(array(object({ title: text, status: optional(enumeration(['fresh', 'stale', 'unavailable'])), windows: quotaWindows }), MAX_ROWS, MIN_QUOTA_WINDOWS)), context: optional(object({ usedPct: pct })), cost: optional(object({ amount: number, unit: text })) }), requiredOneOf: ['windows', 'groups'] },
  galton: object({ rows: { ...number, min: GALTON_MIN_ROWS, max: GALTON_MAX_ROWS, integer: true }, balls: { ...number, min: 1, max: GALTON_MAX_BALLS, integer: true }, seed: optional({ ...number, max: SEED_MAX, integer: true }), p: optional(confidence), observed: optional(array({ ...number, integer: true }, GALTON_MAX_ROWS + 1, GALTON_MIN_ROWS + 1)) }),
  particles: object({ unit: text, series: array(object({ label: text, rate: number, tone: optional(enumeration(PARTICLE_TONES)), max: optional({ ...number, min: POSITIVE_FLOOR }) }), PARTICLE_MAX_LANES), style: optional(enumeration(PARTICLE_STYLES)) }),
  riskgrid: object({ items: item({ label: text, likelihood: { ...number, min: 1, max: SCORE_MAX, integer: true }, impact: { ...number, min: 1, max: SCORE_MAX, integer: true }, mitigation: optional(long), owner: optional(text) }) }),
};
export function validateSchema(value, schema, path = 'data') {
  if (value === undefined && schema.optional) return undefined;
  switch (schema.type) {
    case 'string': return check.string(value, path, { max: schema.max });
    case 'number': {
      const n = check.number(value, path, { min: schema.min, max: schema.max });
      if (schema.exclusiveMin && n <= schema.min) throw new AssetError(`${path} must be above ${schema.min}`);
      if (schema.integer && !Number.isInteger(n)) throw new AssetError(`${path} must be an integer`);
      return n;
    }
    case 'enum': return check.oneOf(value, path, schema.values);
    case 'boolean': {
      if (typeof value !== 'boolean') throw new AssetError(`${path} must be true or false`);
      return value;
    }
    case 'array': return check.array(value, path, schema).map((v, i) => validateSchema(v, schema.item, `${path}[${i}]`));
    case 'object': {
      check.object(value, path, Object.keys(schema.fields));
      if (schema.requiredOneOf && !schema.requiredOneOf.some(key => value[key] !== undefined)) throw new AssetError(`${path} needs ${schema.requiredOneOf.join(' or ')}`);
      return Object.fromEntries(Object.entries(schema.fields).map(([k, s]) => [k, validateSchema(value[k], s, `${path}.${k}`)]));
    }
    case 'map': {
      check.object(value, path, Object.keys(value ?? {}));
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, validateSchema(v, schema.item, `${path}.${k}`)]));
    }
    case 'url': {
      const url = check.string(value, path, { max: LIMITS.longText });
      try { if (['https:', 'http:'].includes(new URL(url).protocol)) return url; } catch { /* field error below */ }
      throw new AssetError(`${path} must be an http or https URL`);
    }
    case 'date': {
      if ((typeof value === 'number' && Number.isFinite(value) && Number.isFinite(new Date(value).getTime())) || (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value)))) return value;
      throw new AssetError(`${path} must be epoch milliseconds or an ISO date-time`);
    }
    default: throw new AssetError(`${path} has an unknown schema`);
  }
}
export function validateWork(kind, data) {
  const clean = validateSchema(data, WORK_SCHEMAS[kind]);
  if (JSON.stringify(data).length > MAX_PAYLOAD) throw new AssetError(`data exceeds the ${MAX_PAYLOAD} character limit`);
  if (kind === 'hypotheses' || kind === 'decisionmatrix') {
    const ids = (rows, path) => { const seen = new Set(); rows.forEach((r, i) => check.id(r.id, `${path}[${i}].id`, seen)); return seen; };
    if (kind === 'hypotheses') ids(clean.items, 'data.items');
    else {
      const options = ids(clean.options, 'data.options');
      const criteria = ids(clean.criteria, 'data.criteria');
      if (clean.chosen !== undefined && !options.has(clean.chosen)) throw new AssetError('data.chosen must name an option id');
      for (const [id, scores] of Object.entries(clean.scores)) {
        if (!options.has(id)) throw new AssetError(`data.scores.${id} must name an option id`);
        for (const key of Object.keys(scores)) if (!criteria.has(key)) throw new AssetError(`data.scores.${id}.${key} must name a criterion id`);
      }
    }
  }
  if (kind === 'galton' && clean.observed !== undefined && clean.observed.length !== clean.rows + 1) throw new AssetError(`data.observed needs ${clean.rows + 1} counts, one per bin (rows + 1); got ${clean.observed.length}`);
  return mediaRelations(kind, clean);
}
