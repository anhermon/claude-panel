// panel/assets - a library of visual asset generators chosen by INFORMATION SHAPE (sankey for flows, treemap for part-of-whole, ...).
// `import { sankey, render, kinds, describe } from 'panel/assets'`; every maker is `name(data, opts) -> <figure>` with `.update(data)`.
// `render(kind, data, opts)` is the same by name (what the board `viz` frame uses). Data is validated with errors that name the field.
// Docs: skills/panel-guide/references/assets.md. Each asset's `sample` drives the catalog scene (web/sample-scenes/assets-catalog).
import { h, check, AssetError } from './core.js';
import { ensureStyle } from '../ui/core.js';
import * as flow from './flow.js';
import * as hierarchy from './hierarchy.js';
import * as filetree from './filetree.js';
import * as venn from './venn.js';
import * as network from './network.js';
import * as decision from './decision.js';
import * as sketch from './sketch.js';
import * as layers from './layers.js';
import * as compare from './compare.js';
import * as matrix from './matrix.js';
import * as uncertainty from './uncertainty.js';
import * as dial from './dial.js';
import * as time from './time.js';
import * as steps from './steps.js';
import * as annotate from './annotate.js';
import * as beforeafter from './beforeafter.js';
import * as statusboard from './statusboard.js';
import * as scene3d from './scene3d.js';

export * from './flow.js';
export * from './hierarchy.js';
export * from './filetree.js';
export * from './venn.js';
export * from './network.js';
export * from './decision.js';
export * from './sketch.js';
export * from './layers.js';
export * from './compare.js';
export * from './matrix.js';
export * from './uncertainty.js';
export * from './dial.js';
export * from './time.js';
export * from './steps.js';
export * from './annotate.js';
export * from './beforeafter.js';
export * from './statusboard.js';
export * from './scene3d.js';
export { check, AssetError };

const MODULES = [flow, hierarchy, filetree, venn, network, decision, sketch, layers, compare, matrix, uncertainty, dial, time, steps, annotate, beforeafter, statusboard, scene3d];
const isMaker = (v) => typeof v === 'function' && v.def && typeof v.def.kind === 'string';
/** kind -> maker, in module order. */
export const ASSETS = Object.freeze(Object.fromEntries(MODULES.flatMap((m) => Object.values(m).filter(isMaker)).map((mk) => [mk.def.kind, mk])));
/** The valid kinds, in catalog order. */
export const kinds = () => Object.keys(ASSETS);
/** {kind, shape, summary, keys, sample} for one kind, or for every kind. */
export const describe = (kind) => {
  const one = (k) => { const { shape, summary, keys, sample } = ASSETS[k].def; return { kind: k, shape, summary, keys, sample }; };
  return kind === undefined ? kinds().map(one) : Object.hasOwn(ASSETS, kind) ? one(kind) : null;
};
/** The message for an unknown kind: honest, and it lists the valid ones. */
export const unknownKindMessage = (kind) => `unknown asset kind ${JSON.stringify(kind)}; valid kinds: ${kinds().join(', ')}`;

/** Throws AssetError when `data` is not valid for `kind`; returns the clean data. */
export function validate(kind, data) {
  if (!Object.hasOwn(ASSETS, kind)) throw new AssetError(unknownKindMessage(kind));
  return ASSETS[kind].def.validate(data);
}

/** The asset `kind` for `data`; an unknown kind gives an error panel listing the valid kinds (it never throws). */
export function render(kind, data, opts) {
  if (Object.hasOwn(ASSETS, kind)) return ASSETS[kind](data, opts);
  ensureStyle();
  return h('div.pa-err.ui', { role: 'alert' }, h('b', 'viz: '), unknownKindMessage(kind));
}
