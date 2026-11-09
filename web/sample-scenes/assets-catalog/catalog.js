// panel/assets catalog: every asset with its own sample data, one card each (also the visual test, see scripts/render-assets-catalog.mjs).
// `?only=sankey,treemap` shows just those kinds. The card says what information shape the asset is for.
import { mount, grid, card, text } from 'panel/ui';
import { ASSETS, kinds } from 'panel/assets';

const only = new URLSearchParams(location.search).get('only');
const shown = only ? only.split(',').filter((k) => Object.hasOwn(ASSETS, k)) : kinds();
const WIDE_MIN = 380;

mount(document.body,
  text({ text: `panel/assets: ${shown.length} visual assets, chosen by the shape of the information`, size: 'l', bold: true }),
  grid({ min: WIDE_MIN, gap: 14 }, ...shown.map((kind) => {
    const { def } = ASSETS[kind];
    return card({ title: kind, sub: def.shape }, ASSETS[kind](def.sample, { caption: def.summary }));
  })));
