// scene3d.js - `scene3d`: objects placed in 3D space that you orbit (a service layout, a module map, a physical arrangement). three.js is loaded
// on demand through the importmap, so this file also loads under node (validation tests) without WebGL. Renders only when something changes.
import { AssetError, check, defineAsset, each, h, numbers, reducedMotion } from './core.js';
import { addCss } from '../ui/core.js';

const MAX_OBJECTS = 30;
const SHAPES = ['box', 'sphere', 'cylinder', 'cone', 'torus'];
const ASPECT = 0.6; // height / width when the stage is not filled
const MIN_H = 220;
const FOV = 45;
const CAM_DIR = [1, 0.75, 1.2];
const FIT = 1.25; // camera distance margin around the scene
const TIGHT = 0.6; // the bounding sphere is loose around a flat layout, so pull the camera in
const MAX_H = 520;
const LABEL_PX = 14; // label text height on screen
const LABEL_SCALE = 2; // label texture resolution multiplier
const LABEL_LIFT = 0.45; // gap between an object's top and its label, world units
const PIXEL_RATIO_MAX = 2;
const AUTO_ROTATE_SPEED = 1.2;
const TONE_VARS = { ok: '--ui-ok', warn: '--ui-warn', danger: '--ui-danger', info: '--ui-acc', neutral: '--ui-mut' };
const CAT_VARS = ['--ui-c1', '--ui-c2', '--ui-c3', '--ui-c4', '--ui-c5', '--ui-c6'];
const VEC3 = 3;

function validateScene3d(d) {
  check.object(d, 'data', ['objects', 'links', 'ground', 'autoRotate']);
  const seen = new Set();
  const objects = each(d.objects, 'data.objects', { max: MAX_OBJECTS }, (o, p) => {
    check.object(o, p, ['id', 'shape', 'pos', 'size', 'tone', 'label']);
    const pos = numbers(o.pos, `${p}.pos`, { min: VEC3, max: VEC3 });
    const size = Array.isArray(o.size) ? numbers(o.size, `${p}.size`, { min: VEC3, max: VEC3 }) : check.number(o.size, `${p}.size`, { min: 0.01, optional: true });
    return { id: o.id === undefined ? undefined : check.id(o.id, `${p}.id`, seen), shape: check.oneOf(o.shape, `${p}.shape`, SHAPES), pos, size, tone: check.tone(o.tone, `${p}.tone`), label: check.string(o.label, `${p}.label`, { max: 28, optional: true }) };
  });
  const links = d.links === undefined ? undefined : each(d.links, 'data.links', { min: 0, max: MAX_OBJECTS * 2 }, (l, p) => {
    check.object(l, p, ['from', 'to']);
    for (const k of ['from', 'to']) if (!seen.has(l[k])) throw new AssetError(`${p}.${k} "${l[k]}" is not an object id of this scene (ids: ${[...seen].slice(0, 12).join(', ') || 'none: give the objects an id'})`);
    return { from: l.from, to: l.to };
  });
  return { objects, links, ground: check.bool(d.ground, 'data.ground'), autoRotate: check.bool(d.autoRotate, 'data.autoRotate') };
}

addCss(`
.pa-3d { position: relative; width: 100%; min-width: 0; border-radius: var(--ui-r-s); overflow: hidden; touch-action: none; }
.pa-3d canvas { display: block; cursor: grab; }
.pa-3d-hint { font-size: var(--ui-fs-s); color: var(--ui-mut); padding-top: 4px; }
.pa-3d-msg { padding: 14px; border: 1px dashed var(--ui-line-hi); border-radius: var(--ui-r-s); color: var(--ui-mut); font-size: var(--ui-fs-s); }
`);

const GEOMETRY = {
  box: (T) => new T.BoxGeometry(1, 1, 1),
  sphere: (T) => new T.SphereGeometry(0.5, 32, 20),
  cylinder: (T) => new T.CylinderGeometry(0.5, 0.5, 1, 32),
  cone: (T) => new T.ConeGeometry(0.5, 1, 32),
  torus: (T) => new T.TorusGeometry(0.34, 0.14, 16, 40),
};
const scaleOf = (size) => (Array.isArray(size) ? size : [size ?? 1, size ?? 1, size ?? 1]);

/** A label as a camera-facing sprite; its screen height is constant (LABEL_PX) whatever the distance. */
function labelSprite(T, text, css, viewH) {
  const font = `600 ${LABEL_PX * LABEL_SCALE}px ${css.font}`;
  const probe = document.createElement('canvas').getContext('2d');
  probe.font = font;
  const pad = LABEL_SCALE * 4;
  const cw = Math.ceil(probe.measureText(text).width) + pad * 2;
  const ch = LABEL_PX * LABEL_SCALE + pad * 2;
  const canvas = Object.assign(document.createElement('canvas'), { width: cw, height: ch });
  const g = canvas.getContext('2d');
  g.font = font; g.textAlign = 'center'; g.textBaseline = 'middle'; g.lineJoin = 'round';
  g.lineWidth = LABEL_SCALE * 3; g.strokeStyle = css.halo; g.strokeText(text, cw / 2, ch / 2);
  g.fillStyle = css.fg; g.fillText(text, cw / 2, ch / 2);
  const tex = new T.CanvasTexture(canvas);
  tex.colorSpace = T.SRGBColorSpace;
  const mat = new T.SpriteMaterial({ map: tex, depthTest: false, transparent: true, sizeAttenuation: false });
  const sprite = new T.Sprite(mat);
  const hs = (ch / LABEL_SCALE) * 2 * Math.tan((FOV * Math.PI) / 360) / viewH; // screen px -> sprite scale for a non-attenuated sprite
  sprite.scale.set(hs * (cw / ch), hs, 1);
  sprite.renderOrder = 10;
  return sprite;
}

async function drawScene3d(ctx) {
  const { data, root, w, fill } = ctx;
  const height = fill ? ctx.h : Math.min(MAX_H, Math.max(MIN_H, Math.round(w * ASPECT)));
  const wrap = h('div.pa-3d');
  wrap.style.height = `${height}px`;
  root.append(wrap);
  let T;
  let OrbitControls;
  let renderer;
  try {
    T = await import('three');
    ({ OrbitControls } = await import('three/addons/controls/OrbitControls.js'));
    renderer = new T.WebGLRenderer({ antialias: true, alpha: true });
  } catch (e) {
    wrap.replaceChildren(h('div.pa-3d-msg', null, `WebGL unavailable: ${e?.message ?? e}. The 3D scene cannot be shown here.`));
    wrap.style.height = '';
    return undefined;
  }
  const style = getComputedStyle(root);
  const token = (name) => style.getPropertyValue(name).trim();
  const css = { fg: token('--ui-fg'), halo: token('--ui-card'), font: token('--ui-font') || 'system-ui, sans-serif' };
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, PIXEL_RATIO_MAX));
  renderer.setSize(w, height);
  renderer.setClearColor(0x000000, 0);
  wrap.append(renderer.domElement);
  const scene = new T.Scene();
  scene.add(new T.AmbientLight(0xffffff, 1.6));
  const sun = new T.DirectionalLight(0xffffff, 2.2);
  sun.position.set(4, 8, 5);
  scene.add(sun);
  const disposables = [];
  const byId = new Map();
  const box = new T.Box3();
  data.objects.forEach((o, i) => {
    const color = new T.Color(token(o.tone ? TONE_VARS[o.tone] : CAT_VARS[i % CAT_VARS.length]));
    const geo = GEOMETRY[o.shape](T);
    const mat = new T.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.05 });
    const mesh = new T.Mesh(geo, mat);
    mesh.scale.set(...scaleOf(o.size));
    mesh.position.set(...o.pos);
    scene.add(mesh);
    disposables.push(geo, mat);
    box.expandByObject(mesh);
    if (o.id) byId.set(o.id, mesh);
    if (o.label) {
      const sp = labelSprite(T, o.label, css, height);
      sp.position.set(o.pos[0], o.pos[1] + scaleOf(o.size)[1] / 2 + LABEL_LIFT, o.pos[2]);
      scene.add(sp);
      disposables.push(sp.material.map, sp.material);
    }
  });
  const linkMat = new T.LineBasicMaterial({ color: new T.Color(token('--ui-mut')) });
  disposables.push(linkMat);
  for (const l of data.links ?? []) {
    const geo = new T.BufferGeometry().setFromPoints([byId.get(l.from).position, byId.get(l.to).position]);
    scene.add(new T.Line(geo, linkMat));
    disposables.push(geo);
  }
  const centre = box.getCenter(new T.Vector3());
  const radius = Math.max(box.getSize(new T.Vector3()).length() / 2, 1);
  if (data.ground) {
    const grid = new T.GridHelper(Math.ceil(radius * 2.4), Math.ceil(radius * 2.4), new T.Color(token('--ui-line-hi')), new T.Color(token('--ui-line')));
    grid.position.set(centre.x, box.min.y - 0.01, centre.z);
    scene.add(grid);
    disposables.push(grid.geometry, grid.material);
  }
  const camera = new T.PerspectiveCamera(FOV, w / height, 0.1, radius * 40);
  const dist = (radius / Math.sin((FOV * Math.PI) / 360)) * FIT * TIGHT;
  camera.position.copy(centre).add(new T.Vector3(...CAM_DIR).normalize().multiplyScalar(dist));
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.copy(centre);
  controls.update();
  const spin = Boolean(data.autoRotate) && !ctx.reduced && !reducedMotion();
  controls.autoRotate = spin;
  controls.autoRotateSpeed = AUTO_ROTATE_SPEED;
  const render = () => renderer.render(scene, camera);
  let raf = 0;
  let alive = true;
  const loop = () => { if (!alive) return; controls.update(); render(); raf = requestAnimationFrame(loop); };
  controls.addEventListener('change', render);
  render();
  if (spin) raf = requestAnimationFrame(loop);
  const hint = h('div.pa-3d-hint', null, 'drag to orbit, scroll to zoom');
  root.append(hint);
  return () => {
    alive = false;
    cancelAnimationFrame(raf);
    controls.removeEventListener('change', render);
    controls.dispose();
    for (const d of disposables) d.dispose?.();
    renderer.dispose();
    renderer.forceContextLoss?.();
    renderer.domElement.remove();
    hint.remove();
  };
}

export const scene3d = defineAsset({
  kind: 'scene3d',
  shape: 'things with a position in space (service layout, module map, a physical arrangement) where depth and angle matter; you orbit it',
  summary: 'Boxes, spheres, cylinders, cones and tori in 3D with labels and link lines, theme colours, orbit controls (drag to rotate, scroll to zoom). Draws only when you move it.',
  keys: ['objects', 'links', 'ground', 'autoRotate'],
  html: true,
  sample: {
    ground: true,
    objects: [
      { id: 'gw', shape: 'box', pos: [-4, 0.5, 0], size: [1.4, 1, 1.4], label: 'Gateway', tone: 'info' },
      { id: 'api', shape: 'box', pos: [0, 0.75, 0], size: [1.6, 1.5, 1.6], label: 'API' },
      { id: 'auth', shape: 'cone', pos: [-2, 0.6, -3.2], size: 1.2, label: 'Auth', tone: 'warn' },
      { id: 'cache', shape: 'cylinder', pos: [3.4, 0.4, -2.2], size: [1.1, 0.8, 1.1], label: 'Cache', tone: 'ok' },
      { id: 'db', shape: 'cylinder', pos: [4, 0.9, 1.8], size: [1.5, 1.8, 1.5], label: 'Database' },
      { id: 'q', shape: 'torus', pos: [0.5, 0.5, 3.6], size: 1.4, label: 'Queue', tone: 'danger' },
    ],
    links: [{ from: 'gw', to: 'api' }, { from: 'gw', to: 'auth' }, { from: 'api', to: 'cache' }, { from: 'api', to: 'db' }, { from: 'api', to: 'q' }],
  },
  validate: validateScene3d,
  draw: drawScene3d,
});
