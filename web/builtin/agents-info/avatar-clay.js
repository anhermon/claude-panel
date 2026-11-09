// A 3D character, built from boxes on the 1-unit grid of mascot-grid.mjs (the character comes from the harness registry, avatar-harness.mjs;
// the Claude Code mascot is the claude one): a body (depth 0.6 of its width), two thin arm slabs that swing from the shoulder, square leg
// posts that step, optional toppers (antenna, ears) and two small black eye blocks proud of the front face (a ">" "<" squint or an "x" built
// from thin bars when the pose says so). Matte material in the harness colour in every state: the state shows in the face, the limbs and
// the badge, never in the body colour. A soft blob under the feet is the ground shadow.
// `buildClay({ color, character })` returns { root, pose(P, t, yaw), dispose }; the root stands on y = 0 and every character is centred on
// x = 0 and on CENTER_Y (scaled down to fit when it is bigger than the frame).
import { THREE, blobTexture, geo, mesh, roundedBox, unitBall } from './avatar-clay-kit.js';
import { CODEX_GLYPH_COLOR, CODEX_VISOR_COLOR, EYE_COLOR, figureSize, fitOf, torsoH, torsoW } from './mascot-grid.mjs';

export const CENTER_Y = 5.2; // the world height the middle of every figure sits at (the camera looks here)
const MAX_BODY_DEPTH_W = 12; // a wider body is not deeper than a 12-wide one
const DEPTH_RATIO = 0.6;
const ARM_DEPTH_RATIO = 0.35;
const TOPPER_DEPTH = 1.5;
const LIFT = 1.04; // the 3D prints are slightly more saturated than the flat sprite: a small lift, still the harness colour
const EYE3D = { depth: 0.3, proud: 0.12, bar: 0.32, chevH: 0.8, chevW: 0.62, crossLen: 1.5, look: 0.35, minLid: 0.1, minScale: 0.7 };
const VISOR3D = { depth: 0.5, sink: 0.2 }; // the visor plate stands this far in front of the head's middle (minus sink)
const ARC3D = { lid: 0.5, radius: 0.62, tube: 0.16, segments: 12 }; // eyes shut further than `lid` become arcs
const GLYPH3D = { scale: 0.6, barW: 1.3, barH: 0.34, gap: 1.35, proud: 0.12, dropBar: 1.6 };
const TORSO_DEPTH_RATIO = 0.75;
const TORSO_ROUND = 0.42;
const LEG_ROUND = 0.4;
const BUMP_DEPTH = 0.9;
const SHADOW_SHRINK = 0.03;
const SHADOW = { w: 1.5, d: 0.62, opacity: 0.4, lift: 0.1 };
const box = (w, h, d) => geo(`box-${w}-${h}-${d}`, () => new THREE.BoxGeometry(w, h, d));

/** A chevron ">" (dir 1) or "<" (dir -1): two thin bars meeting at a tip. */
function chevron(mat, dir) {
  const g = new THREE.Group();
  const len = Math.hypot(EYE3D.chevW * 2, EYE3D.chevH);
  const ang = Math.atan2(EYE3D.chevH, EYE3D.chevW * 2);
  for (const s of [1, -1]) {
    const bar = mesh(box(len, EYE3D.bar, EYE3D.depth), mat, 0, (s * EYE3D.chevH) / 2, 0);
    bar.rotation.z = -s * ang * dir;
    g.add(bar);
  }
  return g;
}
const arcGeo = () => geo('eye-arc', () => new THREE.TorusGeometry(ARC3D.radius, ARC3D.tube, 6, ARC3D.segments, Math.PI).rotateZ(Math.PI)); // a "U": a closed, smiling eye
const cross = (mat) => {
  const g = new THREE.Group();
  for (const s of [1, -1]) { const bar = mesh(box(EYE3D.crossLen, EYE3D.bar, EYE3D.depth), mat); bar.rotation.z = (s * Math.PI) / 4; g.add(bar); }
  return g;
};

export function buildClay({ color, character: C }) {
  const root = new THREE.Group();
  const fitGroup = new THREE.Group(); // scales the character into the frame and centres it on CENTER_Y
  const squash = new THREE.Group();
  root.add(fitGroup);
  fitGroup.add(squash);
  const size = figureSize(C);
  const fit = fitOf(C);
  fitGroup.scale.setScalar(fit);
  fitGroup.position.y = CENTER_Y - (size.h * fit) / 2;
  const bodyMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(color).multiplyScalar(LIFT), roughness: 0.88, metalness: 0 });
  const eyeMat = new THREE.MeshStandardMaterial({ color: C.eyeColor ?? EYE_COLOR, roughness: 0.55, metalness: 0 });
  const bodyBase = bodyMat.color.clone();
  const tw = torsoW(C);
  const th = torsoH(C);
  const depth = { body: Math.min(C.body.w, MAX_BODY_DEPTH_W) * (C.bodyDepthRatio ?? DEPTH_RATIO), leg: C.legs.w };
  depth.arm = C.round ? C.arms.w : depth.body * ARM_DEPTH_RATIO;
  depth.torso = Math.min(tw, MAX_BODY_DEPTH_W) * (C.round ? TORSO_DEPTH_RATIO : DEPTH_RATIO);
  const top = C.legs.h + th + C.body.h; // world y of the head's top
  const part3 = (w, h, d, r) => (C.round ? roundedBox(w, h, d, r) : box(w, h, d));
  if (C.round) { // a soft head: an ellipsoid with the cloud bumps around it
    const head = mesh(unitBall(), bodyMat, 0, C.legs.h + th + C.body.h / 2, 0);
    head.scale.set(C.body.w, C.body.h, depth.body);
    squash.add(head);
    for (const b of C.bumps) {
      const ball = mesh(unitBall(), bodyMat, -C.body.w / 2 + b.x, top - b.y, 0);
      ball.scale.set(2 * b.r, 2 * b.r, Math.min(2 * b.r, depth.body * BUMP_DEPTH));
      squash.add(ball);
    }
  } else squash.add(mesh(box(C.body.w, C.body.h, depth.body), bodyMat, 0, C.legs.h + C.body.h / 2, 0));
  if (C.torso) squash.add(mesh(roundedBox(tw, th, depth.torso, Math.min(tw, th) * TORSO_ROUND), bodyMat, 0, C.legs.h + th / 2, 0));
  for (const t of C.toppers) squash.add(mesh(box(t.w, t.h, Math.min(t.w, TOPPER_DEPTH)), bodyMat, -C.body.w / 2 + t.x + t.w / 2, top + t.h / 2, 0));
  const legs = C.legs.xs.map((x) => {
    const leg = mesh(part3(C.legs.w, C.legs.h, depth.leg, C.legs.w * LEG_ROUND), bodyMat, -tw / 2 + x + C.legs.w / 2, C.legs.h / 2, 0);
    squash.add(leg);
    return leg;
  });
  const arms = [-1, 1].map((side) => { // the pivot is the shoulder, on the trunk's side at the arm's middle row
    const pivot = new THREE.Group();
    pivot.position.set(side * (tw / 2), top - C.arms.top - C.arms.h / 2, 0);
    const limb = C.round ? mesh(unitBall(), bodyMat, side * (C.arms.w / 2), 0, 0) : mesh(box(C.arms.w, C.arms.h, depth.arm), bodyMat, side * (C.arms.w / 2), 0, 0);
    if (C.round) limb.scale.set(C.arms.w, C.arms.h, depth.arm);
    pivot.add(limb);
    squash.add(pivot);
    return { pivot, side };
  });
  let frontZ = depth.body / 2 + EYE3D.proud;
  if (C.visor) { // a dark plate on the head's front; the eyes sit on it
    const v = C.visor;
    const darkMat = new THREE.MeshStandardMaterial({ color: CODEX_VISOR_COLOR, roughness: 0.4, metalness: 0 });
    const front = depth.body / 2 + VISOR3D.depth - VISOR3D.sink;
    squash.add(mesh(roundedBox(v.w, v.h, VISOR3D.depth * 2, v.r), darkMat, -C.body.w / 2 + v.x + v.w / 2, top - v.top - v.h / 2, front - VISOR3D.depth));
    frontZ = front + EYE3D.proud;
  }
  if (C.glyph) { // ">_" on the chest
    const glyphMat = new THREE.MeshStandardMaterial({ color: CODEX_GLYPH_COLOR, roughness: 0.55, metalness: 0 });
    const gx = -tw / 2 + C.glyph.x;
    const gy = C.legs.h + th - C.glyph.y;
    const gz = depth.torso / 2 + GLYPH3D.proud;
    const chev = chevron(glyphMat, 1);
    chev.scale.setScalar(GLYPH3D.scale);
    chev.position.set(gx, gy, gz);
    squash.add(chev, mesh(box(GLYPH3D.barW, GLYPH3D.barH, EYE3D.depth), glyphMat, gx + GLYPH3D.gap, gy - GLYPH3D.barH * GLYPH3D.dropBar, gz));
  }
  const eyeY = top - C.eyes.top - C.eyes.h / 2;
  const ek = Math.max(EYE3D.minScale, Math.max(C.eyes.w, C.eyes.h) / 2); // chevrons and crosses grow with the eye
  const eyes = C.eyes.xs.map((x, i) => {
    const n = new THREE.Group();
    const home = { x: -C.body.w / 2 + x + C.eyes.w / 2, y: eyeY };
    const block = mesh(part3(C.eyes.w, C.eyes.h, EYE3D.depth, Math.min(C.eyes.w, C.eyes.h) / 2), eyeMat);
    const chev = chevron(eyeMat, i === 0 ? 1 : -1);
    const x3 = cross(eyeMat);
    const arc = mesh(arcGeo(), eyeMat, 0, ARC3D.radius / 2, 0);
    chev.scale.setScalar(ek);
    x3.scale.setScalar(ek);
    n.add(block, chev, x3, arc);
    n.position.set(home.x, home.y, frontZ);
    squash.add(n);
    return { n, block, chev, x3, arc, home };
  });
  const shadow = mesh(geo('plane', () => new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2)), new THREE.MeshBasicMaterial({ map: blobTexture(), color: 0x000000, transparent: true, depthWrite: false, opacity: SHADOW.opacity }), 0, 0.02, 0);
  shadow.scale.set(size.w * SHADOW.w, 1, depth.body * SHADOW.d * 2);
  fitGroup.add(shadow);

  return {
    root,
    /** Apply a pose (figurePose); `yaw` turns the figure (the head, dragged). */
    pose(P, _t, yaw = 0) {
      bodyMat.color.copy(bodyBase).multiplyScalar(P.dim); // only the light dims the body (waiting, done): its hue never changes
      squash.scale.set(P.sx, P.sy, P.sx);
      squash.position.y = P.lift + P.bob;
      root.position.x = P.shakeX;
      root.rotation.set(0, yaw, P.tilt);
      legs.forEach((leg, i) => { leg.position.y = C.legs.h / 2 + P.legs[i]; });
      for (const a of arms) a.pivot.rotation.z = a.side < 0 ? -P.armL : P.armR; // + raises the arm: the left one turns clockwise, the right one counter-clockwise
      for (const e of eyes) {
        e.n.position.set(e.home.x + P.look.x * EYE3D.look, e.home.y + P.look.y * EYE3D.look, frontZ);
        const shut = C.eyeArc === true && P.eyes === 'open' && P.lid < ARC3D.lid; // nearly shut: a little arc, as in the reference
        e.block.visible = P.eyes === 'open' && !shut;
        e.arc.visible = shut;
        e.chev.visible = P.eyes === 'squint';
        e.x3.visible = P.eyes === 'cross';
        e.block.scale.y = Math.max(P.lid, EYE3D.minLid);
        e.chev.scale.y = Math.max(P.lid, EYE3D.minLid) * ek;
      }
      shadow.material.opacity = SHADOW.opacity - SHADOW.lift * P.lift;
      shadow.scale.x = size.w * SHADOW.w * (1 - SHADOW_SHRINK * P.lift);
    },
    dispose() { bodyMat.dispose(); eyeMat.dispose(); shadow.material.dispose(); },
  };
}
