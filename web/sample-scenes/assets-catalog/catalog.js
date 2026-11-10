// panel/assets catalog: every asset with its own sample data, one card each (also the visual test, see scripts/render-assets-catalog.mjs).
// `?only=waveform,shotlist,easing&assetHeight=280` exercises short media tiles.
import { mount, grid, card, text } from 'panel/ui';
import { ASSETS, kinds } from 'panel/assets';

const only = new URLSearchParams(location.search).get('only');
const MIN_ASSET_HEIGHT = 200;
const MAX_ASSET_HEIGHT = 640;
const requestedHeight = Number(new URLSearchParams(location.search).get('assetHeight'));
const assetHeight = Number.isFinite(requestedHeight) && requestedHeight >= MIN_ASSET_HEIGHT && requestedHeight <= MAX_ASSET_HEIGHT ? requestedHeight : undefined;
const shown = only ? only.split(',').filter((k) => Object.hasOwn(ASSETS, k)) : kinds();
const WIDE_MIN = 380;
const LIMITS_KIND = 'limits';
const QUOTA_SAMPLE_AT = Date.parse('2026-11-10T13:06:03.511Z');

mount(document.body,
  text({ text: `panel/assets: ${shown.length} visual assets, chosen by the shape of the information`, size: 'l', bold: true }),
  grid({ min: WIDE_MIN, gap: 14 }, ...shown.map((kind) => {
    const { def } = ASSETS[kind];
    return card({ title: kind, sub: def.shape }, ASSETS[kind](def.sample, { caption: def.summary, height: assetHeight, ...(kind === LIMITS_KIND ? { now: QUOTA_SAMPLE_AT } : {}) }));
  })));
