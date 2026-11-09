// The characters of the Agents scene on a 1-unit grid. CLAUDE is the Claude Code mascot, measured from the flat reference (a pixel
// sprite): a plain 12 x 8 body, two 2 x 2 arm stubs at rows 4-6 from the body's top, two 1 x 2 eyes at x 2 and 9 (rows 2-4), four 1 x 2 legs
// at x 1, 3, 8, 10 under the body; the whole figure is 16 x 10. The other harnesses have their own silhouettes (codex: a small blue robot,
// a cloud-shaped head with a dark visor over a round body with a ">_" on the chest; agy: a wide low block with ears; generic: a neutral
// cube, tinted per unknown harness by avatar-harness.mjs). Optional parts of a character: `torso` (a body under the head; arms and legs
// hang from it, x from the torso's left edge), `round` (soft shapes), `crown` (head height above the body's top), `bumps` (cloud circles
// { x, y, r } in body coordinates), `visor` (a dark plate on the head), `glyph` (a ">_" on the torso: the ">" centre from the trunk's left edge and the torso's top), `eyeColor` and `eyeArc` (eyes that
// are nearly shut are drawn as little arcs).
// Both renderers (3D boxes: avatar-clay.js; flat SVG: mini-face.js) build from these tables. Coordinates: x from the body's left edge,
// y down from the body's top; `toppers` are boxes on the body's top edge ({ x, w, h }, h grows upward).
const part = (o) => Object.freeze(o);
export const CODEX_COLOR = '#5B7BE8';
export const CODEX_VISOR_COLOR = '#141C45';
export const CODEX_EYE_COLOR = '#A8F3FF';
export const CODEX_GLYPH_COLOR = '#D6E6FF';
export const CHARACTERS = Object.freeze({
  claude: part({ body: part({ w: 12, h: 8 }), arms: part({ w: 2, h: 2, top: 4 }), legs: part({ w: 1, h: 2, xs: Object.freeze([1, 3, 8, 10]) }), eyes: part({ w: 1, h: 2, xs: Object.freeze([2, 9]), top: 2 }), toppers: Object.freeze([]) }),
  codex: part({
    body: part({ w: 12, h: 6.5 }), torso: part({ w: 6, h: 4 }), round: true, crown: 2.7, bodyDepthRatio: 0.5,
    bumps: Object.freeze([part({ x: 3.2, y: 0.6, r: 2.6 }), part({ x: 6, y: 0.2, r: 2.8 }), part({ x: 8.8, y: 0.6, r: 2.6 }), part({ x: 1.4, y: 3.3, r: 2 }), part({ x: 10.6, y: 3.3, r: 2 })]),
    visor: part({ x: 1.6, w: 8.8, top: 1.4, h: 4.1, r: 1.4 }),
    glyph: part({ x: 1.9, y: 2.1 }),
    arms: part({ w: 1.8, h: 1.8, top: 7.3 }), legs: part({ w: 1.8, h: 1.8, xs: Object.freeze([0.9, 3.3]) }),
    eyes: part({ w: 1.5, h: 1.5, xs: Object.freeze([3.25, 7.25]), top: 2.65 }), eyeColor: CODEX_EYE_COLOR, eyeArc: true, toppers: Object.freeze([]),
  }),
  agy: part({ body: part({ w: 14, h: 6 }), arms: part({ w: 2, h: 3, top: 2 }), legs: part({ w: 2, h: 2, xs: Object.freeze([2, 10]) }), eyes: part({ w: 2, h: 2, xs: Object.freeze([3, 9]), top: 2 }), toppers: Object.freeze([part({ x: 1, w: 3, h: 2 }), part({ x: 10, w: 3, h: 2 })]) }),
  generic: part({ body: part({ w: 10, h: 8 }), arms: part({ w: 1, h: 3, top: 3 }), legs: part({ w: 3, h: 2, xs: Object.freeze([1, 6]) }), eyes: part({ w: 1, h: 1, xs: Object.freeze([2, 7]), top: 3 }), toppers: Object.freeze([]) }),
});
/** The eye color of every character; the body color is the harness's (avatar-harness.mjs). */
export const EYE_COLOR = '#08080a';
export const CLAUDE_COLOR = '#D97757';
/** Figures are scaled down to fit this many units in either direction (the studio and the flat view frame 18). */
export const FIT_UNITS = 16;

const topperH = (c) => c.toppers.reduce((m, t) => Math.max(m, t.h), c.crown ?? 0);
const torsoW = (c) => c.torso?.w ?? c.body.w;
const torsoH = (c) => c.torso?.h ?? 0;
/** Width and height of a character in grid units (arms on both sides; legs and toppers included). */
export const figureSize = (c) => ({ w: Math.max(c.body.w, torsoW(c) + 2 * c.arms.w), h: topperH(c) + c.body.h + torsoH(c) + c.legs.h });
/** The scale that fits a character into FIT_UNITS (never up). */
export const fitOf = (c) => { const s = figureSize(c); return Math.min(1, FIT_UNITS / Math.max(s.w, s.h)); };
/** Where the parts sit in figure coordinates: the head's left edge, the trunk's left edge (arms, legs, glyph) and the body's top edge (`up`). */
export const anchorsOf = (c) => {
  const s = figureSize(c);
  return { bodyLeft: (s.w - c.body.w) / 2, trunkLeft: (s.w - torsoW(c)) / 2, up: topperH(c) };
};
export { torsoW, torsoH, topperH };

/** Every filled rectangle of the flat sprite as [x, y, w, h] in figure coordinates (x from the figure's left, y from its top), body first. */
export function spriteRects(c) {
  const { bodyLeft, trunkLeft, up } = anchorsOf(c);
  const th = torsoH(c);
  const tw = torsoW(c);
  const rects = [[bodyLeft, up, c.body.w, c.body.h]];
  if (c.torso) rects.push([trunkLeft, up + c.body.h, tw, th]);
  rects.push([trunkLeft - c.arms.w, up + c.arms.top, c.arms.w, c.arms.h], [trunkLeft + tw, up + c.arms.top, c.arms.w, c.arms.h]);
  for (const x of c.legs.xs) rects.push([trunkLeft + x, up + c.body.h + th, c.legs.w, c.legs.h]);
  for (const t of c.toppers) rects.push([bodyLeft + t.x, up - t.h, t.w, t.h]);
  return rects;
}
