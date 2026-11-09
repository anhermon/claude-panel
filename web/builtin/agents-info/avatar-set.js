// Every avatar on the page is made here, so there is ONE family: the clay figure. With WebGL an avatar is a 2D canvas that the studio
// (avatar3d.js, one shared renderer) paints with a snapshot of the 3D figure; without it, the same character drawn flat (mini-face.js,
// same palette and same faces). Switching the mode (`useStudio(studio | null)`) rebuilds the inside of every existing avatar.
// `createAvatarView({ key, label, ring })` -> { el, set(figureState, pct, harness), hot(on), flash(), dispose() }. Views of one `key` (an
// agent's card and its list row) share one figure. `ring`: a thin progress arc around the avatar (the percentage, or a sweep). `harness`: a harnessInfo() (default claude).
import { buildProp } from './avatar-props.js';
import { FIGURE_PROP, FIGURE_THEME } from './avatar-model.mjs';
import { FX } from './event-fx.mjs';
import { h, svg } from './dom.js';
import { harnessInfo } from './avatar-harness.mjs';
import { createFace } from './mini-face.js';

const RING_VIEW = 48;
const RING_R = 22;
const RING_LEN = 2 * Math.PI * RING_R;
const SWEEP_SHARE = 0.28;
const PCT_FULL = 100;
const DPR_MAX = 2;
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

let studio = null;
const views = new Set();

export function useStudio(next) {
  studio = next;
  for (const v of views) v.rebuild();
}

export function createAvatarView({ key, label = '', ring = false }) {
  const el = h('span', 'av');
  el.setAttribute('role', 'img');
  el.setAttribute('aria-label', label);
  const prop = h('span', 'av-prop');
  prop.hidden = true;
  const burst = h('span', 'av-burst');
  burst.setAttribute('aria-hidden', 'true');
  el.append(prop, burst);
  let fxTimer = 0;
  let propKind = null;
  const art = { node: null, handle: null, face: null, ro: null };
  const now = { state: 'working', pct: null, harness: harnessInfo('claude') };
  let ringEl = null;
  let arc = null;
  if (ring) {
    ringEl = svg('svg', { class: 'av-ring', viewBox: `0 0 ${RING_VIEW} ${RING_VIEW}`, 'aria-hidden': 'true' });
    arc = svg('circle', { class: 'ring-arc', cx: 24, cy: 24, r: RING_R, fill: 'none', transform: 'rotate(-90 24 24)' });
    ringEl.append(svg('circle', { class: 'ring-track', cx: 24, cy: 24, r: RING_R, fill: 'none' }), arc);
    el.append(ringEl);
  }

  function clear() {
    art.handle?.release();
    art.ro?.disconnect();
    art.node?.remove();
    Object.assign(art, { node: null, handle: null, face: null, ro: null });
  }
  function build() {
    clear();
    if (studio !== null) {
      const canvas = h('canvas', 'av-canvas');
      const fit = () => {
        const r = el.getBoundingClientRect();
        const dpr = Math.min(devicePixelRatio || 1, DPR_MAX);
        const w = Math.max(1, Math.round(r.width * dpr));
        const hh = Math.max(1, Math.round(r.height * dpr));
        if (canvas.width !== w || canvas.height !== hh) { canvas.width = w; canvas.height = hh; art.handle?.redraw(); }
      };
      el.prepend(canvas);
      art.node = canvas;
      art.ro = new ResizeObserver(fit);
      art.ro.observe(el);
      fit();
      art.handle = studio.track(key, canvas, now.state, now.harness);
      art.handle.set(now.state, now.harness);
    } else {
      art.face = createFace({ label, harness: now.harness });
      art.node = art.face.el;
      el.prepend(art.node);
      art.face.set(now.state, now.harness);
    }
  }

  const view = {
    el,
    rebuild: build,
    set(state, pct = null, harness = now.harness) {
      now.state = state;
      now.pct = pct;
      now.harness = harness;
      el.dataset.harness = harness.id;
      el.dataset.state = state;
      el.style.setProperty('--c', (FIGURE_THEME[state] ?? FIGURE_THEME.working).accent);
      art.handle?.set(state, harness);
      art.face?.set(state, harness);
      const kind = FIGURE_PROP[state] ?? null;
      if (kind !== propKind) { // the accessory badge follows the state
        propKind = kind;
        prop.replaceChildren();
        const badge = buildProp(kind);
        if (badge) prop.append(badge);
        prop.hidden = badge === null;
        prop.dataset.prop = kind ?? '';
      }
      el.dataset.prop = kind ?? '';
      if (arc !== null) {
        const isSweep = pct === null && state !== 'done';
        const share = isSweep ? SWEEP_SHARE : (state === 'done' ? PCT_FULL : pct ?? 0) / PCT_FULL;
        arc.setAttribute('stroke-dasharray', `${(RING_LEN * share).toFixed(2)} ${RING_LEN.toFixed(2)}`);
        ringEl.classList.toggle('sweep', isSweep);
      }
    },
    label(text) { el.setAttribute('aria-label', text); art.face?.label(text); },
    hot(on) { art.handle?.hot(on); },
    flash() { art.handle?.flash(); },
    /** One-shot animation of an event (FX in event-fx.mjs: spawn, receive, done, error, blocked, change, tool); none under reduced motion (the state shows statically). */
    play(kind) {
      const fx = FX[kind];
      if (!fx || reduced()) return;
      clearTimeout(fxTimer);
      el.removeAttribute('data-fx');
      void el.offsetWidth; // restart the CSS animation when the same kind plays twice
      burst.textContent = fx.glyph ?? '';
      el.dataset.fx = kind;
      art.handle?.flash();
      fxTimer = setTimeout(() => { el.removeAttribute('data-fx'); burst.textContent = ''; }, fx.ms);
    },
    dispose() { clearTimeout(fxTimer); clear(); views.delete(view); el.remove(); },
  };
  views.add(view);
  build();
  return view;
}
