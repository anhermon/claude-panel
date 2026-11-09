// The accessory badge of an avatar (FIGURE_PROP, avatar-model.mjs): a small DOM badge at the head's upper right, so the 3D snapshot and
// its flat twin carry the same accessory. thinking = bouncing dots, testing = a check-list, waiting = zzz, failed = "!", done = a check;
// working (a warm glow) and blocked (the sweat drop and the amber ring) have no badge. Motion is CSS (agents-info.css `.av-prop`).
import { h, svg } from './dom.js';

const VIEW = 24;
const STROKE = { fill: 'none', stroke: 'currentColor', 'stroke-width': 2.4, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' };
const glyph = (...paths) => {
  const s = svg('svg', { viewBox: `0 0 ${VIEW} ${VIEW}`, 'aria-hidden': 'true', focusable: 'false' });
  for (const d of paths) s.append(svg('path', { d, ...STROKE }));
  return s;
};
const BUILD = Object.freeze({
  dots: () => { const n = h('span', 'dots'); n.append(h('i'), h('i'), h('i')); return n; },
  list: () => glyph('M6 4h12v17H6z', 'M9 9.5l1.4 1.4 2.6-2.6', 'M9 16h6'),
  zzz: () => glyph('M5 6h6l-6 7h6', 'M13 11h6l-6 8h6'),
  bang: () => glyph('M12 5v9', 'M12 18.6v.1'),
  check: () => glyph('M6.5 12.5l3.8 3.8L17.5 8.5'),
});

/** The badge for an accessory name (null: none). */
export const buildProp = (kind) => (BUILD[kind] ? BUILD[kind]() : null);
