// The beam of a handoff: a glowing line from the team's head to the worker's avatar with a spark that runs along it (Web Animations,
// on top of the stage; the elements remove themselves). Nothing is drawn under reduced motion or when an end is not visible.
// `beam(stage, fromEl, toEl, done)`; `done` runs when the spark lands (the worker's avatar then plays its "receive" animation).
import { BEAM_MS } from './event-fx.mjs';
import { h } from './dom.js';

const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const centre = (r, host) => ({ x: r.left + r.width / 2 - host.left, y: r.top + r.height / 2 - host.top });
const LINE_FADE_MS = 350;

export function beam(stage, fromEl, toEl, done) {
  if (reduced() || !fromEl || !toEl || !fromEl.isConnected || !toEl.isConnected) { done?.(); return; }
  const host = stage.getBoundingClientRect();
  const a = centre(fromEl.getBoundingClientRect(), host);
  const b = centre(toEl.getBoundingClientRect(), host);
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  if (len < 1) { done?.(); return; }
  const angle = Math.atan2(b.y - a.y, b.x - a.x);
  const line = h('i', 'beam');
  const dot = h('i', 'beam-dot');
  line.style.width = `${len}px`;
  line.style.transform = `translate(${a.x}px, ${a.y}px) rotate(${angle}rad) scaleX(0)`;
  stage.append(line, dot);
  const at = (x, y) => `translate(${x}px, ${y}px)`;
  const grow = line.animate([{ transform: `translate(${a.x}px, ${a.y}px) rotate(${angle}rad) scaleX(0)` }, { transform: `translate(${a.x}px, ${a.y}px) rotate(${angle}rad) scaleX(1)` }], { duration: BEAM_MS, easing: 'ease-out', fill: 'forwards' });
  dot.animate([{ transform: at(a.x, a.y) }, { transform: at(b.x, b.y) }], { duration: BEAM_MS, easing: 'ease-in-out', fill: 'forwards' });
  grow.onfinish = () => {
    done?.();
    const fade = line.animate([{ opacity: 1 }, { opacity: 0 }], { duration: LINE_FADE_MS, fill: 'forwards' });
    dot.remove();
    fade.onfinish = () => line.remove();
  };
}
