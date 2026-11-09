// avatar: an expressive SVG face and a speech bubble. Every mood is drawn once; the mood attribute fades one in and the
// others out (0.6 s), so a mood change morphs instead of jumping. Eyes blink, the head breathes, working adds orbit dots.
import { CAPS, capText } from '../board-logic.mjs';
import { h } from './dom.js';

export const MOODS = ['idle', 'thinking', 'working', 'happy', 'alert', 'sleepy'];
const DEFAULT_MOOD = 'idle';
const EYE_L = 44;
const EYE_R = 76;
const EYE_Y = 58;
const state = new WeakMap();

const p = (d, cls) => h('path', { class: cls ?? 'line', d });
const eye = (cx, cy, rx, ry) => h('ellipse', { class: 'eye', cx, cy, rx, ry });
const dots = (n, cx, cy, r) => Array.from({ length: n }, (_, i) => h('circle', { class: 'think-dot', style: `animation-delay:${i * 0.3}s`, cx: cx + i * 9, cy: cy - i * 6, r: r + i * 0.9 }));

const FACES = {
  idle: [eye(EYE_L, EYE_Y, 6.5, 8.5), eye(EYE_R, EYE_Y, 6.5, 8.5), p('M46 80 Q60 91 74 80')],
  thinking: [eye(EYE_L + 3, EYE_Y - 3, 5.5, 7), eye(EYE_R + 3, EYE_Y - 3, 5.5, 7), p('M35 44 L53 38'), p('M68 44 L85 47'), p('M50 83 L68 81'), ...dots(3, 88, 24, 2.4)],
  working: [eye(EYE_L, EYE_Y + 1, 7, 4), eye(EYE_R, EYE_Y + 1, 7, 4), p('M35 46 L53 51'), p('M85 46 L67 51'), p('M49 82 L71 82')],
  happy: [p('M36 61 Q44 49 52 61'), p('M68 61 Q76 49 84 61'), p('M42 76 Q60 99 78 76'), h('circle', { class: 'cheek', cx: 33, cy: 74, r: 5.5 }), h('circle', { class: 'cheek', cx: 87, cy: 74, r: 5.5 })],
  alert: [eye(EYE_L, EYE_Y, 9, 11), eye(EYE_R, EYE_Y, 9, 11), p('M34 36 L52 41'), p('M86 36 L68 41'), h('ellipse', { class: 'mouth-o', cx: 60, cy: 85, rx: 5, ry: 6.5 }), p('M100 14 L100 30'), h('circle', { class: 'dot', cx: 100, cy: 37, r: 2.4 })],
  sleepy: [p('M36 60 Q44 66 52 60'), p('M68 60 Q76 66 84 60'), p('M52 83 Q60 86 68 83'), h('g', { class: 'zz' }, p('M88 28 H96 L88 38 H96'), p('M99 14 H105 L99 22 H105'))],
};

function build(mood) {
  const faces = MOODS.map((m) => h('g', { class: `face face-${m}` }, FACES[m]));
  return h('svg', { class: 'avatar-svg', viewBox: '0 0 120 120', 'data-mood': mood, role: 'img', 'aria-label': `avatar, ${mood}` },
    h('circle', { class: 'halo', cx: 60, cy: 62, r: 54 }),
    h('g', { class: 'orbit' }, [0, 120, 240].map((a) => h('circle', { class: 'orbit-dot', cx: 60 + 56 * Math.cos((a * Math.PI) / 180), cy: 62 + 56 * Math.sin((a * Math.PI) / 180), r: 3.4 }))),
    h('g', { class: 'head' }, h('rect', { class: 'skull', x: 16, y: 20, width: 88, height: 84, rx: 34 }), faces));
}

const moodOf = (f) => (MOODS.includes(f.mood) ? f.mood : DEFAULT_MOOD);

export function render(el, f) {
  const mood = moodOf(f);
  const say = capText(f.say, CAPS.say);
  const svg = build(mood);
  const bubble = h('div', { class: 'bubble', 'data-empty': say ? 'false' : 'true' }, h('p', { text: say }));
  el.append(h('div', { class: 'avatar' }, h('div', { class: 'avatar-face' }, svg), bubble));
  state.set(el, { svg, bubble });
}

/** A mood or sentence change: the face morphs, the bubble text fades. Same layout, so it is always done in place. */
export function update(el, f) {
  const s = state.get(el);
  if (!s) return false;
  s.svg.dataset.mood = moodOf(f);
  s.svg.setAttribute('aria-label', `avatar, ${moodOf(f)}`);
  const say = capText(f.say, CAPS.say);
  if (s.bubble.firstChild.textContent !== say) {
    s.bubble.dataset.fading = 'true';
    setTimeout(() => { s.bubble.firstChild.textContent = say; s.bubble.dataset.empty = say ? 'false' : 'true'; delete s.bubble.dataset.fading; }, 300);
  }
  return true;
}
