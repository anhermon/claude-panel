// <p-3d shape="torusknot|cube|sphere|torus" | src="model.glb" auto-rotate controls zoom background="#111" color="#7aa2ff"> - three.js viewer; src is a .glb/.gltf in the scene folder.
import { PanelElement, cssVar, reducedMotion, sceneUrl, el } from './base.js';
import { flag } from './pure.js';

const SHAPES = ['torusknot', 'cube', 'sphere', 'torus'];
const FOV = 45;
const CAMERA_DISTANCE = 6;
const MODEL_SIZE = 2.8; // loaded models are scaled to fit this box
const SPIN_RAD_PER_SEC = 0.5;
const MAX_PIXEL_RATIO = 2;

function geometryFor(THREE, shape) {
  switch (shape) {
    case 'cube': return new THREE.BoxGeometry(1.7, 1.7, 1.7);
    case 'sphere': return new THREE.SphereGeometry(1.3, 64, 40);
    case 'torus': return new THREE.TorusGeometry(1.2, 0.45, 36, 100);
    default: return new THREE.TorusKnotGeometry(1.2, 0.38, 220, 36);
  }
}

function disposeTree(root) {
  root.traverse((o) => {
    o.geometry?.dispose();
    for (const m of [o.material].flat().filter(Boolean)) {
      for (const v of Object.values(m)) if (v && v.isTexture) v.dispose();
      m.dispose();
    }
  });
}

export class P3d extends PanelElement {
  static observedAttributes = ['src', 'shape', 'auto-rotate', 'controls', 'zoom', 'background', 'color'];

  async setup() {
    const shape = (this.getAttribute('shape') || 'torusknot').toLowerCase();
    const src = this.getAttribute('src');
    if (!src && !SHAPES.includes(shape)) throw new Error(`shape "${shape}" is not one of ${SHAPES.join(', ')}`);
    const THREE = await this.until(import('three'));
    const bg = this.getAttribute('background');
    if (bg) this.style.background = bg;

    let renderer;
    try { renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true }); } catch { throw new Error('WebGL is not available in this browser'); }
    renderer.setPixelRatio(Math.min(devicePixelRatio || 1, MAX_PIXEL_RATIO));
    const canvas = renderer.domElement;
    canvas.style.cssText = 'display:block;width:100%;height:100%';
    this.append(el('div', { className: 'p-3d-box' }, canvas));

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 100);
    camera.position.set(0, 0.4, CAMERA_DISTANCE);
    scene.add(new THREE.HemisphereLight(0xffffff, 0x445066, 1.1));
    const sun = new THREE.DirectionalLight(0xffffff, 2.2);
    sun.position.set(3, 4, 5);
    scene.add(sun);

    const spin = flag(this.getAttribute('auto-rotate')) && !reducedMotion();
    const pivot = new THREE.Group();
    scene.add(pivot);
    if (src) {
      const { GLTFLoader } = await this.until(import('three/addons/loaders/GLTFLoader.js'));
      const gltf = await this.until(new GLTFLoader().loadAsync(sceneUrl(src)));
      const box = new THREE.Box3().setFromObject(gltf.scene);
      const dims = box.getSize(new THREE.Vector3());
      const centre = box.getCenter(new THREE.Vector3());
      gltf.scene.position.sub(centre);
      pivot.scale.setScalar(MODEL_SIZE / (Math.max(dims.x, dims.y, dims.z) || 1));
      pivot.add(gltf.scene);
    } else {
      const color = this.getAttribute('color') || cssVar('--panel-accent', '#7aa2ff');
      pivot.add(new THREE.Mesh(geometryFor(THREE, shape), new THREE.MeshStandardMaterial({ color, roughness: 0.25, metalness: 0.2 })));
    }

    let controls = null;
    if (flag(this.getAttribute('controls'))) {
      const { OrbitControls } = await this.until(import('three/addons/controls/OrbitControls.js'));
      controls = new OrbitControls(camera, canvas);
      controls.enableDamping = true;
      controls.enablePan = false;
      controls.enableZoom = flag(this.getAttribute('zoom'));
      controls.autoRotate = spin;
      controls.autoRotateSpeed = SPIN_RAD_PER_SEC * 4;
    }

    const resize = () => {
      const w = Math.max(1, this.clientWidth);
      const h = Math.max(1, this.clientHeight);
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      if (!running) renderer.render(scene, camera);
    };
    let running = false;
    let frame = 0;
    let last = 0;
    const tick = (now) => {
      frame = requestAnimationFrame(tick);
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      if (spin && !controls) pivot.rotation.y += SPIN_RAD_PER_SEC * dt;
      controls?.update();
      renderer.render(scene, camera);
    };
    this.watchSize(resize);
    resize();
    this.watchActive((active) => { // render only while visible and current
      running = active;
      cancelAnimationFrame(frame);
      if (active) { last = performance.now(); frame = requestAnimationFrame(tick); }
    });
    this.own(() => {
      cancelAnimationFrame(frame);
      controls?.dispose();
      disposeTree(scene);
      renderer.dispose();
      renderer.forceContextLoss();
      this.style.removeProperty('background');
    });
  }
}
