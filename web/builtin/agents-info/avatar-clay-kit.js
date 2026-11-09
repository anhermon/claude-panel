// Shared bits of the figures (from delegation-kit's board avatar kit, bin/board-avatar-vinyl-kit.js, same author): a geometry cache
// and the soft blob texture (the ground shadow). Only what the figure needs; the lights are the scene's own (avatar3d.js).
import * as THREE from 'three';

export { THREE };
const BLOB_PX = 64;

const cache = new Map();
/** A geometry (or texture) built once per key and shared by every figure. */
export const geo = (key, make) => {
  if (!cache.has(key)) cache.set(key, make());
  return cache.get(key);
};
export const disposeKit = () => {
  for (const g of cache.values()) g.dispose();
  cache.clear();
};
export const mesh = (g, m, x = 0, y = 0, z = 0) => {
  const o = new THREE.Mesh(g, m);
  o.position.set(x, y, z);
  return o;
};

function canvasTexture(size, draw) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  draw(cv.getContext('2d'), size);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
/** One soft radial alpha blob: tinted by the material color (halo, cheeks). */
export const blobTexture = () => geo('blob', () => canvasTexture(BLOB_PX, (c, s) => {
  const g = c.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  for (const [at, a] of [[0, 1], [0.5, 0.45], [1, 0]]) g.addColorStop(at, `rgba(255,255,255,${a})`);
  c.fillStyle = g;
  c.fillRect(0, 0, s, s);
}));

const BEVEL_RATIO = 0.18;
const ROUND_SEGMENTS = 6;
/** A box with rounded corners (w x h front face, depth d, corner radius r), centred on the origin. */
export const roundedBox = (w, h, d, r) => geo(`rbox-${w}-${h}-${d}-${r}`, () => {
  const rr = Math.min(r, w / 2, h / 2);
  const bevel = Math.min(d * BEVEL_RATIO, rr);
  const sh = new THREE.Shape();
  const [x0, y0, x1, y1] = [-w / 2 + bevel, -h / 2 + bevel, w / 2 - bevel, h / 2 - bevel];
  const q = Math.max(rr - bevel, 0);
  sh.moveTo(x0 + q, y0).lineTo(x1 - q, y0).quadraticCurveTo(x1, y0, x1, y0 + q).lineTo(x1, y1 - q).quadraticCurveTo(x1, y1, x1 - q, y1).lineTo(x0 + q, y1).quadraticCurveTo(x0, y1, x0, y1 - q).lineTo(x0, y0 + q).quadraticCurveTo(x0, y0, x0 + q, y0);
  const g = new THREE.ExtrudeGeometry(sh, { depth: d - 2 * bevel, bevelEnabled: true, bevelSize: bevel, bevelThickness: bevel, bevelSegments: ROUND_SEGMENTS, curveSegments: ROUND_SEGMENTS });
  g.translate(0, 0, -(d - 2 * bevel) / 2);
  return g;
});
/** A unit ellipsoid (scale it to w x h x d). */
export const unitBall = () => geo('ball', () => new THREE.SphereGeometry(0.5, 20, 14));
