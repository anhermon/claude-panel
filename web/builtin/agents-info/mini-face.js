// The FLAT version of the 3D character (avatar-clay.js): the same character on the same 1-unit grid (mascot-grid.mjs, picked per harness by
// avatar-harness.mjs): body, two arms, legs, toppers and two eyes, flat in the harness colour with no outline, gradient or glow, and the
// same pose per state (figurePose, still pose). It is what the page shows where WebGL is missing; never a different character. The one
// motion is CSS: legs step while it runs.
// `createFace({size, label, harness})` -> { el, set(figureState, harness), label(text) }; `harness` is an info of harnessInfo().
import { figurePose } from './avatar-model.mjs';
import { harnessInfo } from './avatar-harness.mjs';
import { CODEX_GLYPH_COLOR, CODEX_VISOR_COLOR, EYE_COLOR, anchorsOf, figureSize, fitOf, torsoH, torsoW } from './mascot-grid.mjs';

const NS = 'http://www.w3.org/2000/svg';
const FRAME = 18; // grid units across the square view (a character is at most 16 wide and tall, centred)
const STROKE = 0.36;
const CHEV = { w: 0.62, h: 0.8 };
const CROSS_HALF = 0.7;
const LOOK = 0.3;
const RAD_TO_DEG = 180 / Math.PI;
const MIN_LID = 0.1;
const ARC_LID = 0.5; // eyes shut further than this are drawn as little arcs (characters with eyeArc)
const ARC_R = 0.62;
const GLYPH = { chevW: 0.36, chevH: 0.5, barW: 1.3, gap: 1.35, stroke: 0.34, drop: 0.55 };
const TORSO_ROUND = 0.42;
const MIN_EYE_SCALE = 0.7;
const HEX_DIGITS = 2;
const HEX_BASE = 16;

const el = (tag, attrs = {}) => {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  return n;
};
const rect = (x, y, w, h, extra = {}) => el('rect', { x, y, width: w, height: h, ...extra });
/** `hex` with its light scaled by `k` (the dim of waiting and done). */
const shade = (hex, k) => `#${[1, 3, 5].map((i) => Math.round(parseInt(hex.slice(i, i + 2), 16) * k).toString(HEX_BASE).padStart(HEX_DIGITS, '0')).join('')}`;

/** The parts of one character: { group, body (every filled part), legs, arms, eyes, color }. */
function buildFigure({ character: C, color }) {
  const size = figureSize(C);
  const fit = fitOf(C);
  const { bodyLeft, trunkLeft, up } = anchorsOf(C);
  const tw = torsoW(C);
  const th = torsoH(C);
  const group = el('g', { transform: `translate(${(FRAME - size.w * fit) / 2} ${(FRAME - size.h * fit) / 2}) scale(${fit})` });
  const parts = [];
  const add = (r) => { parts.push(r); return r; };
  const soft = (r) => (C.round ? { rx: r } : {});
  const bodyRect = add(rect(bodyLeft, up, C.body.w, C.body.h, soft(C.body.h / 2)));
  for (const b of C.bumps ?? []) add(el('circle', { cx: bodyLeft + b.x, cy: up + b.y, r: b.r }));
  if (C.torso) add(rect(trunkLeft, up + C.body.h, tw, th, soft(Math.min(tw, th) * TORSO_ROUND)));
  for (const t of C.toppers) add(rect(bodyLeft + t.x, up - t.h, t.w, t.h));
  const legs = C.legs.xs.map((x, i) => add(rect(trunkLeft + x, up + C.body.h + th, C.legs.w, C.legs.h, { class: `leg ${i % 2 === 0 ? 'a' : 'b'}`, ...soft(C.legs.w * 0.4) })));
  const arms = [-1, 1].map((side) => {
    const x0 = side < 0 ? trunkLeft - C.arms.w : trunkLeft + tw;
    const pivot = { x: side < 0 ? trunkLeft : trunkLeft + tw, y: up + C.arms.top + C.arms.h / 2 };
    return { r: add(rect(x0, up + C.arms.top, C.arms.w, C.arms.h, soft(C.arms.h / 2))), pivot, side };
  });
  const extras = [];
  if (C.visor) { const v = C.visor; extras.push(rect(bodyLeft + v.x, up + v.top, v.w, v.h, { rx: v.r, fill: CODEX_VISOR_COLOR })); }
  if (C.glyph) {
    const gx = trunkLeft + C.glyph.x;
    const gy = up + C.body.h + C.glyph.y;
    const gl = { fill: 'none', stroke: CODEX_GLYPH_COLOR, 'stroke-width': GLYPH.stroke, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' };
    extras.push(el('path', { d: `M${gx - GLYPH.chevW} ${gy - GLYPH.chevH} L${gx + GLYPH.chevW} ${gy} L${gx - GLYPH.chevW} ${gy + GLYPH.chevH}`, ...gl }));
    extras.push(el('path', { d: `M${gx + GLYPH.gap - GLYPH.barW / 2} ${gy + GLYPH.drop} H${gx + GLYPH.gap + GLYPH.barW / 2}`, ...gl }));
  }
  const eyeColor = C.eyeColor ?? EYE_COLOR;
  const ink = { fill: eyeColor, ...(C.round ? { rx: Math.min(C.eyes.w, C.eyes.h) / 2 } : {}) };
  const line = { fill: 'none', stroke: eyeColor, 'stroke-width': STROKE / fit, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' };
  const k = Math.max(MIN_EYE_SCALE, Math.max(C.eyes.w, C.eyes.h) / 2);
  const eyes = C.eyes.xs.map((x, i) => {
    const cx = bodyLeft + x + C.eyes.w / 2;
    const cy = up + C.eyes.top + C.eyes.h / 2;
    const dir = i === 0 ? 1 : -1;
    const cw = CHEV.w * k;
    const ch = CHEV.h * k;
    const ch2 = CROSS_HALF * k;
    return {
      cx, cy,
      open: rect(cx - C.eyes.w / 2, cy - C.eyes.h / 2, C.eyes.w, C.eyes.h, ink),
      squint: el('path', { d: `M${cx - dir * cw} ${cy - ch} L${cx + dir * cw} ${cy} L${cx - dir * cw} ${cy + ch}`, ...line }),
      arc: el('path', { d: `M${cx - ARC_R} ${cy - ARC_R / 2} A${ARC_R} ${ARC_R} 0 0 0 ${cx + ARC_R} ${cy - ARC_R / 2}`, ...line }),
      cross: el('path', { d: `M${cx - ch2} ${cy - ch2} L${cx + ch2} ${cy + ch2} M${cx + ch2} ${cy - ch2} L${cx - ch2} ${cy + ch2}`, ...line }),
    };
  });
  group.append(...parts, ...extras, ...eyes.flatMap((e) => [e.open, e.squint, e.cross, e.arc]));
  return { eyeArc: C.eyeArc === true, group, fills: [bodyRect, ...parts.filter((p) => p !== bodyRect)], legs, arms, eyes, color };
}

export function createFace({ size = null, label = '', harness = harnessInfo('claude') } = {}) {
  const svg = el('svg', { class: 'mini-face', viewBox: `0 0 ${FRAME} ${FRAME}`, role: 'img', 'aria-label': label, focusable: 'false' });
  if (size !== null) { svg.setAttribute('width', size); svg.setAttribute('height', size); }
  let fig = null;
  let shown = null;
  const show = (n, on) => n.setAttribute('display', on ? 'inline' : 'none');
  function draw(state) {
    const P = figurePose(state, 0);
    svg.dataset.state = state;
    svg.classList.toggle('running', P.running > 0);
    const fill = shade(fig.color, P.dim); // only the light dims the body; its hue never changes
    for (const n of fig.fills) n.setAttribute('fill', fill);
    for (const a of fig.arms) a.r.setAttribute('transform', `rotate(${((a.side < 0 ? P.armL : -P.armR) * RAD_TO_DEG).toFixed(1)} ${a.pivot.x} ${a.pivot.y})`);
    for (const e of fig.eyes) {
      const lid = Math.max(P.lid, MIN_LID);
      const dx = P.look.x * LOOK;
      const dy = -P.look.y * LOOK;
      const h = Number(e.open.getAttribute('data-h'));
      const shut = fig.eyeArc && P.eyes === 'open' && P.lid < ARC_LID;
      show(e.open, P.eyes === 'open' && !shut);
      show(e.arc, shut);
      show(e.squint, P.eyes === 'squint');
      show(e.cross, P.eyes === 'cross');
      e.open.setAttribute('height', (h * lid).toFixed(2));
      e.open.setAttribute('y', (e.cy - (h * lid) / 2 + dy).toFixed(2));
      e.open.setAttribute('x', (e.cx - Number(e.open.getAttribute('width')) / 2 + dx).toFixed(2));
      for (const n of [e.squint, e.cross, e.arc]) n.setAttribute('transform', `translate(${dx.toFixed(2)} ${dy.toFixed(2)})`);
    }
  }
  return {
    el: svg,
    /** `next` replaces the harness (the character) when it differs from the one drawn. */
    set(state, next = harness) {
      if (next.id !== shown) { // a different harness is a different character: rebuild the figure
        fig?.group.remove();
        fig = buildFigure(next);
        for (const e of fig.eyes) e.open.setAttribute('data-h', e.open.getAttribute('height'));
        svg.append(fig.group);
        shown = next.id;
        svg.dataset.harness = next.id;
      }
      draw(state);
    },
    label(text) { svg.setAttribute('aria-label', text); },
  };
}
