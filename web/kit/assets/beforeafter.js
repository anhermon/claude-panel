// beforeafter.js - `beforeafter`: one slider between two states. Two pictures: a clip-reveal you drag. Numbers per item: bars that MORPH
// from the before value to the after value as the slider moves (or on Play), so the change is felt, not only read.
import { addCss } from '../ui/core.js';
import { AssetError, check, defineAsset, each, h, fmt, clamp, reducedMotion } from './core.js';

const MAX_ITEMS = 14;
const SLIDER_STEPS = 1000;
const PLAY_MS = 1400;
const START_DEFAULT = 0.5;
const MIN_BAR_PCT = 0.5;
const FLAT_EPS = 1e-9;

const unitOf = (u, p) => (u === '' ? '' : check.string(u, p, { max: 12, optional: true }) ?? '');

function validateSide(x, path) {
  check.object(x, path, ['label', 'src']);
  return { label: check.string(x.label, `${path}.label`, { max: 40 }), src: x.src === undefined ? undefined : check.src(x.src, `${path}.src`) };
}

function validateBeforeAfter(d) {
  check.object(d, 'data', ['unit', 'goodWhen', 'before', 'after', 'items', 'start']);
  const before = validateSide(d.before, 'data.before');
  const after = validateSide(d.after, 'data.after');
  if (Boolean(before.src) !== Boolean(after.src)) throw new AssetError('data.before.src and data.after.src must both be given (a picture pair) or both left out');
  const items = d.items === undefined ? undefined : each(d.items, 'data.items', { max: MAX_ITEMS }, (it, p) => {
    check.object(it, p, ['label', 'before', 'after']);
    return { label: check.string(it.label, `${p}.label`, { max: 40 }), before: check.number(it.before, `${p}.before`, { min: 0 }), after: check.number(it.after, `${p}.after`, { min: 0 }) };
  });
  if (!before.src && !items) throw new AssetError('data needs a picture pair (data.before.src + data.after.src) or data.items to morph: give at least one');
  return { unit: unitOf(d.unit, 'data.unit'), goodWhen: check.oneOf(d.goodWhen, 'data.goodWhen', ['up', 'down'], { optional: true }), before, after, items, start: check.number(d.start, 'data.start', { min: 0, max: 1, optional: true }) ?? START_DEFAULT };
}

addCss(`
.pa-ba { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.pa-ba-fill { height: 100%; overflow: auto; }
.pa-ba-stage { position: relative; aspect-ratio: 16 / 10; border-radius: var(--ui-r-s); overflow: hidden; background: var(--ui-card-hi); border: 1px solid var(--ui-line-hi); touch-action: pan-y; cursor: ew-resize; user-select: none; }
.pa-ba-img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; pointer-events: none; }
.pa-ba-chip { position: absolute; top: 8px; padding: 2px 9px; border-radius: 99px; font-size: var(--ui-fs-s); font-weight: 650; background: var(--ui-card); color: var(--ui-fg); border: 1px solid var(--ui-line-hi); max-width: 45%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pa-ba-handle { position: absolute; top: 0; bottom: 0; width: 3px; margin-left: -1.5px; background: var(--ui-acc); pointer-events: none; }
.pa-ba-knob { position: absolute; top: 50%; left: 50%; width: 30px; height: 30px; margin: -15px 0 0 -15px; border-radius: 50%; background: var(--ui-acc); color: var(--ui-on-acc); display: grid; place-items: center; font-size: 14px; font-weight: 700; box-shadow: 0 1px 6px rgba(0, 0, 0, .35); }
.pa-ba-range { width: 100%; accent-color: var(--ui-acc); margin: 0; }
.pa-ba-bar { display: flex; align-items: center; gap: 10px; }
.pa-ba-ends { display: flex; justify-content: space-between; gap: 10px; color: var(--ui-mut); font-size: var(--ui-fs-s); }
.pa-ba-ends b { color: var(--ui-fg); font-weight: 650; }
.pa-ba-play { flex: none; font: inherit; font-size: var(--ui-fs-s); font-weight: 650; padding: 5px 14px; border-radius: 99px; border: 1px solid var(--ui-line-hi); background: var(--ui-card-hi); color: var(--ui-fg); cursor: pointer; }
.pa-ba-play:hover { border-color: var(--ui-acc); } .pa-ba-play:focus-visible, .pa-ba-range:focus-visible { outline: 2px solid var(--ui-acc); outline-offset: 2px; }
.pa-ba-rows { display: grid; gap: 10px; }
.pa-ba-row { display: grid; grid-template-columns: minmax(70px, 28%) 1fr auto; gap: 8px 10px; align-items: center; }
.pa-ba-label { font-weight: 600; overflow-wrap: anywhere; min-width: 0; }
.pa-ba-track { position: relative; height: 18px; border-radius: 6px; background: var(--ui-card-hi); border: 1px solid var(--ui-line); }
.pa-ba-fillbar { position: absolute; left: 0; top: 0; bottom: 0; border-radius: 5px; background: var(--ui-acc); opacity: .85; }
.pa-ba-ghost { position: absolute; top: -4px; bottom: -4px; width: 2px; background: var(--ui-mut); }
.pa-ba-ghost[data-end] { background: transparent; border-left: 2px dashed var(--ui-fg); }
.pa-ba-val { font-variant-numeric: tabular-nums; font-weight: 650; text-align: right; min-width: 6.5em; }
.pa-ba-delta { display: block; font-size: var(--ui-fs-s); color: var(--ui-mut); font-weight: 600; }
.pa-ba-delta[data-good="1"] { color: var(--ui-ok); } .pa-ba-delta[data-good="0"] { color: var(--ui-danger); }
@media (max-width: 520px) { .pa-ba-row { grid-template-columns: 1fr auto; } .pa-ba-track { grid-column: 1 / -1; grid-row: 2; } .pa-ba-val { grid-row: 1; grid-column: 2; } }
`);

const sliderInput = (start, label) => h('input.pa-ba-range', { type: 'range', min: 0, max: SLIDER_STEPS, value: Math.round(start * SLIDER_STEPS), 'aria-label': label });

function pictureMode(data, root) {
  let pos = data.start;
  const range = sliderInput(pos, `Reveal: drag between ${data.before.label} and ${data.after.label}`);
  const afterImg = h('img.pa-ba-img', { src: data.after.src, alt: data.after.label });
  const handle = h('div.pa-ba-handle', null, h('div.pa-ba-knob', null, '<>'));
  const stage = h('div.pa-ba-stage', null,
    h('img.pa-ba-img', { src: data.before.src, alt: data.before.label }), afterImg, handle,
    h('span.pa-ba-chip', { style: 'left: 8px' }, data.before.label), h('span.pa-ba-chip', { style: 'right: 8px' }, data.after.label));
  const apply = (v) => { pos = clamp(v, 0, 1); afterImg.style.clipPath = `inset(0 0 0 ${pos * 100}%)`; handle.style.left = `${pos * 100}%`; range.value = Math.round(pos * SLIDER_STEPS); };
  const fromEvent = (e) => { const r = stage.getBoundingClientRect(); apply((e.clientX - r.left) / Math.max(1, r.width)); };
  const onMove = (e) => fromEvent(e);
  const stop = () => { removeEventListener('pointermove', onMove); removeEventListener('pointerup', stop); };
  stage.addEventListener('pointerdown', (e) => { fromEvent(e); addEventListener('pointermove', onMove); addEventListener('pointerup', stop); });
  range.addEventListener('input', () => apply(Number(range.value) / SLIDER_STEPS));
  apply(pos);
  root.append(stage, range, h('div.pa-ba-ends', null, h('span', null, 'Left: ', h('b', null, data.before.label)), h('span', null, 'Right: ', h('b', null, data.after.label))));
  return stop;
}

function morphMode(data, root) {
  const items = data.items;
  const top = Math.max(FLAT_EPS, ...items.flatMap((it) => [it.before, it.after]));
  const pct = (v) => `${Math.max(MIN_BAR_PCT, (v / top) * 100)}%`;
  const rows = items.map((it) => {
    const fillBar = h('div.pa-ba-fillbar');
    const val = h('span');
    const delta = h('span.pa-ba-delta');
    const track = h('div.pa-ba-track', null, fillBar,
      h('span.pa-ba-ghost', { style: `left: ${pct(it.before)}`, title: `${data.before.label}: ${fmt(it.before, data.unit)}` }),
      h('span.pa-ba-ghost', { style: `left: ${pct(it.after)}`, 'data-end': '', title: `${data.after.label}: ${fmt(it.after, data.unit)}` }));
    return { it, fillBar, val, delta, el: h('div.pa-ba-row', null, h('div.pa-ba-label', null, it.label), track, h('div.pa-ba-val', null, val, delta)) };
  });
  let t = data.start;
  const range = sliderInput(t, `Morph from ${data.before.label} (left) to ${data.after.label} (right)`);
  const play = h('button.pa-ba-play', { type: 'button' }, 'Play');
  const apply = (v) => {
    t = clamp(v, 0, 1);
    range.value = Math.round(t * SLIDER_STEPS);
    for (const r of rows) {
      const cur = r.it.before + (r.it.after - r.it.before) * t;
      r.fillBar.style.width = pct(cur);
      r.val.textContent = fmt(Math.round(cur * 10) / 10, data.unit);
      const d = r.it.after - r.it.before;
      const shown = d * t;
      r.delta.textContent = `${shown > 0 ? '+' : shown < 0 ? '-' : ''}${fmt(Math.abs(Math.round(shown * 10) / 10), data.unit)}`;
      if (data.goodWhen && Math.abs(d) > FLAT_EPS && t > 0) r.delta.dataset.good = (data.goodWhen === 'up' ? d > 0 : d < 0) ? '1' : '0'; else delete r.delta.dataset.good;
    }
  };
  let raf = 0;
  const cancel = () => { cancelAnimationFrame(raf); raf = 0; };
  play.addEventListener('click', () => {
    cancel();
    if (reducedMotion()) { apply(t < 1 ? 1 : 0); return; }
    const from = t >= 1 ? 0 : t;
    const t0 = performance.now();
    const step = (now) => { const k = clamp((now - t0) / PLAY_MS, 0, 1); apply(from + (1 - from) * (1 - (1 - k) ** 3)); if (k < 1) raf = requestAnimationFrame(step); else raf = 0; };
    raf = requestAnimationFrame(step);
  });
  range.addEventListener('input', () => { cancel(); apply(Number(range.value) / SLIDER_STEPS); });
  apply(t);
  root.append(h('div.pa-ba-ends', null, h('span', null, h('b', null, data.before.label)), h('span', null, h('b', null, data.after.label))),
    h('div.pa-ba-bar', null, play, range), h('div.pa-ba-rows', null, rows.map((r) => r.el)),
    h('div.pa-ba-ends', null, h('span', null, `Ticks on the bars: solid = ${data.before.label}, dashed = ${data.after.label}`)));
  return cancel;
}

export const beforeafter = defineAsset({
  kind: 'beforeafter',
  shape: 'the same thing in two states (a UI before/after a fix, numbers before/after a change); the change itself is the point',
  summary: 'A slider between two states: with pictures a clip-reveal you drag, with numbers bars that morph from before to after (Play button) with +/- deltas.',
  keys: ['unit', 'goodWhen', 'before', 'after', 'items', 'start'],
  html: true,
  sample: {
    unit: 'ms',
    goodWhen: 'down',
    before: { label: 'Before refactor' },
    after: { label: 'After refactor' },
    start: 1,
    items: [
      { label: 'Cold start', before: 840, after: 310 },
      { label: 'Parse config', before: 220, after: 90 },
      { label: 'Render first frame', before: 410, after: 405 },
      { label: 'Warm cache setup', before: 60, after: 75 },
    ],
  },
  validate: validateBeforeAfter,
  draw(ctx) {
    const box = h('div.pa-ba');
    box.classList.toggle('pa-ba-fill', ctx.fill);
    ctx.root.append(box);
    return ctx.data.before.src ? pictureMode(ctx.data, box) : morphMode(ctx.data, box);
  },
});
