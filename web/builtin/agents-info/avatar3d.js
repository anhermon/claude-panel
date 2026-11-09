// The studio: ONE WebGL renderer for every avatar on the page (the delegation-kit board's rule, f729c2a2: one context, never one per
// avatar). The renderer's canvas is never shown. Each avatar on the page (the team's head, the crew cards, the list rows, the ticker)
// is a plain 2D <canvas> that this module paints with a SNAPSHOT of its clay figure: render into a square corner of the shared buffer,
// then drawImage. The head repaints every frame; a small avatar repaints at a low rate (faster for a moment after its state changes,
// it is flashed or hovered), so 20 avatars cost a few renders per second. A soft key light and a sky fill light the matte boxes
// (no environment map). Rendering pauses while the document is hidden; reduced motion paints one still pose per change.
// `createStudio(hooks)` throws when WebGL is not available (the page then draws the flat SVG twins, mini-face.js).
import { approach, blinkAmount, figurePose, hash01 } from './avatar-model.mjs';
import { THREE, disposeKit } from './avatar-clay-kit.js';
import { CENTER_Y, buildClay } from './avatar-clay.js';
import { harnessInfo } from './avatar-harness.mjs';

const BUFFER_PX = 768;
const FOV = 26;
const FRAME_UNITS = 18; // grid units across the square a figure is painted into (a figure is at most 16 wide and tall)
const LOOK_Y = CENTER_Y;
const HALF_HEIGHT = FRAME_UNITS / 2;
const CAM_ELEVATION = 3.2; // the camera looks slightly down on the figure, so its top face shows (like the 3D prints)
const REST_YAW = 0.32; // and the figure rests a little turned, so its depth shows
const MAX_DT = 0.05;
const HERO_FRAME_MS = 33;
const HERO_CALM_FRAME_MS = 50;
const FAST_MS = 33;
const FAST_WINDOW_MS = 1500;
const IDLE_MS = Object.freeze({ working: 90, testing: 90, thinking: 140, waiting: 140, blocked: 110, done: 1000, failed: 1000 });
const MAX_SMALL_PER_FRAME = 4;
const FLASH_SCALE = 0.14;
const HOVER_SCALE = 0.06;
const YAW_LIMIT = 0.8;
const YAW_DRAG = 0.012;
const YAW_REST_RATE = 1.2;
const YAW_HOLD_MS = 1800;
const HERO_KEY = 'hero';
const FLASH_S = 0.8;
const MAX_PAINT_DT = 0.25;
const KEY_LIGHT = 2.6;
const FILL_LIGHT = 2.1;
const GLANCE_TURNS = 1;
const GLANCE_LOOK = 0.9;

export async function createStudio(hooks) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, premultipliedAlpha: true });
  if (!renderer.getContext()) throw new Error('no WebGL context');
  renderer.setPixelRatio(1);
  renderer.setSize(BUFFER_PX, BUFFER_PX, false);
  renderer.autoClear = false;
  renderer.setClearColor(0x000000, 0);
  const gl = renderer.domElement;
  const scene = new THREE.Scene();
  const key = new THREE.DirectionalLight(0xfff4ea, KEY_LIGHT); // a soft key from the upper left, a gentle fill from the sky
  key.position.set(-8, 16, 20);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8a7a70, FILL_LIGHT), key);
  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 50);
  camera.position.set(0, LOOK_Y + CAM_ELEVATION, HALF_HEIGHT / Math.tan((FOV * Math.PI) / 360));
  camera.lookAt(0, LOOK_Y, 0);
  scene.add(camera);

  const entries = new Map();
  const handles = new Set();
  const run = { raf: 0, t: 0, last: 0, dead: false, dirty: true };
  const still = () => hooks.reduced();

  function entryFor(k, state, harness) {
    let e = entries.get(k);
    if (e === undefined) {
      const clay = buildClay(harness);
      scene.add(clay.root);
      clay.root.visible = false;
      e = { key: k, clay, harness: harness.id, state, since: run.t, flash: 0, hl: 0, wantHl: 0, yaw: REST_YAW, dragging: false, releasedAt: 0, nextAt: 0, lastAt: 0, fastUntil: 0, dirty: true, phase: hash01(k) * Math.PI * 2, handles: new Set() };
      entries.set(k, e);
    }
    return e;
  }
  /** A different harness is a different character: swap the entry's figure. */
  function recast(e, harness) {
    if (harness.id === e.harness) return;
    scene.remove(e.clay.root);
    e.clay.dispose();
    e.clay = buildClay(harness);
    e.clay.root.visible = false;
    scene.add(e.clay.root);
    e.harness = harness.id;
  }
  const wake = (e, now = performance.now()) => { e.dirty = true; e.fastUntil = now + FAST_WINDOW_MS; schedule(); };

  function paint(e, now, isStill) {
    const dt = e.lastAt === 0 ? 0 : Math.min(MAX_PAINT_DT, (now - e.lastAt) / 1000);
    e.lastAt = now;
    e.flash = Math.max(0, e.flash - dt / FLASH_S);
    e.hl = approach(e.hl, e.wantHl, dt, isStill ? Infinity : 12);
    if (!e.dragging && !isStill) e.yaw = approach(e.yaw, REST_YAW, dt, performance.now() - e.releasedAt > YAW_HOLD_MS ? YAW_REST_RATE : 0);
    const t = isStill ? 0 : run.t;
    const P = figurePose(e.state, t, t - e.since, isStill ? 0 : blinkAmount(t + e.phase), e.phase);
    if (e.flash > 0 && !isStill) P.look.x += Math.sin((1 - e.flash) * Math.PI * 2 * GLANCE_TURNS) * GLANCE_LOOK; // an event: the figure glances toward it
    e.clay.pose(P, t, e.yaw);
    e.clay.root.scale.setScalar(1 + FLASH_SCALE * e.flash + HOVER_SCALE * e.hl);
    e.clay.root.visible = true;
    const targets = [...e.handles].filter((h) => h.canvas.isConnected && h.canvas.width > 1 && h.canvas.offsetParent !== null);
    if (targets.length > 0) {
      const px = Math.min(BUFFER_PX, Math.max(...targets.map((h) => Math.min(h.canvas.width, h.canvas.height))));
      renderer.setViewport(0, 0, px, px);
      renderer.setScissor(0, 0, px, px);
      renderer.setScissorTest(true);
      renderer.clear();
      renderer.render(scene, camera);
      for (const h of targets) {
        const c = h.canvas;
        const side = Math.min(c.width, c.height);
        const ctx = h.ctx ?? (h.ctx = c.getContext('2d'));
        ctx.clearRect(0, 0, c.width, c.height);
        ctx.drawImage(gl, 0, BUFFER_PX - px, px, px, (c.width - side) / 2, (c.height - side) / 2, side, side);
      }
    }
    e.clay.root.visible = false;
  }

  function frame(now) {
    run.raf = 0;
    if (run.dead || document.hidden) return;
    const isStill = still();
    const dt = run.last === 0 ? 0 : Math.min(MAX_DT, (now - run.last) / 1000);
    run.last = now;
    if (!isStill) run.t += dt;
    let small = 0;
    let more = false;
    for (const e of entries.values()) {
      if (e.handles.size === 0) continue;
      const isHero = e.key === HERO_KEY;
      const calm = isHero && (e.state === 'done' || e.state === 'waiting');
      const period = isHero ? (calm ? HERO_CALM_FRAME_MS : HERO_FRAME_MS) : now < e.fastUntil ? FAST_MS : IDLE_MS[e.state] ?? IDLE_MS.working;
      if (isStill) { if (!e.dirty) continue; } else if (!e.dirty && now < e.nextAt) { more = true; continue; }
      if (!isHero && !e.dirty && small >= MAX_SMALL_PER_FRAME) { more = true; continue; }
      if (!isHero) small += 1;
      paint(e, now, isStill);
      e.dirty = false;
      e.nextAt = now + period;
      more = true;
    }
    renderer.setScissorTest(false);
    if (!isStill && more) schedule();
    else if (isStill && [...entries.values()].some((e) => e.dirty)) schedule();
  }
  function schedule() { if (run.raf === 0 && !run.dead) run.raf = requestAnimationFrame(frame); }
  const onVisible = () => { if (!document.hidden) { run.last = 0; schedule(); } };
  document.addEventListener('visibilitychange', onVisible);
  gl.addEventListener('webglcontextlost', (ev) => { ev.preventDefault(); run.dead = true; hooks.onLost(); });

  /** Turn the head by dragging its canvas (limited angles; it settles back after a moment). */
  function enableDrag(canvas, e) {
    let x = 0;
    canvas.addEventListener('pointerdown', (ev) => { e.dragging = true; x = ev.clientX; canvas.setPointerCapture?.(ev.pointerId); });
    canvas.addEventListener('pointermove', (ev) => {
      if (!e.dragging) return;
      e.yaw = Math.max(-YAW_LIMIT, Math.min(YAW_LIMIT, e.yaw + (ev.clientX - x) * YAW_DRAG));
      x = ev.clientX;
      wake(e);
    });
    const end = () => { e.dragging = false; e.releasedAt = performance.now(); wake(e); };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
  }

  return {
    /** Paint `canvas` (a 2D canvas the caller sizes in device pixels) with the figure of `key`. Returns { set(state, harness), hot(on), flash(), release() }. Handles of one key share one figure. */
    track(k, canvas, state = 'working', harness = harnessInfo('claude')) {
      const e = entryFor(k, state, harness);
      const h = { canvas, ctx: null, entry: e };
      e.handles.add(h);
      handles.add(h);
      if (k === HERO_KEY && e.handles.size === 1) enableDrag(canvas, e);
      wake(e);
      return {
        set(next, nextHarness = harness) {
          recast(e, nextHarness);
          if (next !== e.state) { e.state = next; e.since = run.t; e.flash = 1; }
          wake(e);
        },
        hot(on) { e.wantHl = on ? 1 : 0; wake(e); },
        flash() { e.flash = 1; wake(e); },
        redraw() { wake(e); },
        release() {
          e.handles.delete(h);
          handles.delete(h);
          if (e.handles.size === 0) { scene.remove(e.clay.root); e.clay.dispose(); entries.delete(e.key); }
        },
      };
    },
    requestRender() { for (const e of entries.values()) e.dirty = true; schedule(); },
    stats: () => ({ figures: entries.size, avatars: handles.size, calls: renderer.info.render.calls }),
    dispose() {
      run.dead = true;
      cancelAnimationFrame(run.raf);
      document.removeEventListener('visibilitychange', onVisible);
      for (const e of entries.values()) e.clay.dispose();
      entries.clear();
      handles.clear();
      disposeKit();
      renderer.dispose();
      renderer.forceContextLoss();
    },
  };
}
