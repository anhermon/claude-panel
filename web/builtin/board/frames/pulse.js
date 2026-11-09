// pulse: a compact canvas picture of the agents' activity: a core (the main session) breathing, one orbiting node per
// subagent, a spark flying along every tool call. Reads data.pulse (the Pulse model: loops, events, totals, now), draws
// nothing it was not given, and goes to about 2 frames a second after 30 s without a change. The drawing is a small
// copy of the ideas in web/builtin/pulse (scene folders are served separately, so nothing is imported across).
import { PULSE_IDLE_AFTER_MS } from '../board-logic.mjs';
import { h, watchSize } from './dom.js';

const KIND_COLORS = { read: '#22d3ee', edit: '#fbbf24', shell: '#c084fc', web: '#f472b6', agent: '#7c9cff', other: '#a19d95' };
const TOOL_KIND = { Read: 'read', Grep: 'read', Glob: 'read', LS: 'read', Edit: 'edit', Write: 'edit', MultiEdit: 'edit', Bash: 'shell', WebFetch: 'web', WebSearch: 'web', Task: 'agent', Agent: 'agent' };
const AGENT_COLORS = ['#4ade80', '#fb923c', '#f472b6', '#a3e635', '#2dd4bf', '#e879f9', '#facc15'];
const MAIN_COLOR = '#7c9cff';
const ERROR_COLOR = '#f87171';
const DELAY_MS = 1300;
const SPARK_MS = 850;
const ACTIVITY_MS = 3000;
const IDLE_FRAME_MS = 500;
const ORBIT_S = 90;
const BREATH_S = 4.2;
const DPR_MAX = 2;
const MAX_NODES = 8;
const TAU = Math.PI * 2;

const hash = (s) => [...String(s)].reduce((a, c) => (Math.imul(a ^ c.charCodeAt(0), 16777619) >>> 0), 2166136261);
const kindOf = (tool) => TOOL_KIND[tool] ?? (String(tool).startsWith('Bash') ? 'shell' : 'other');
const lerp = (a, b, u) => a + (b - a) * u;

function rgba(hex, a) {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

export function render(el, f, ctx) {
  const canvas = h('canvas', { class: 'pulse-canvas', 'aria-hidden': 'true' });
  const caption = h('p', { class: 'pulse-caption', text: 'Waiting for activity' });
  el.append(h('div', { class: 'pulse' }, canvas, caption));
  const g = canvas.getContext('2d');
  const box = { w: 1, h: 1, seen: null, recvAt: 0, serverNow: 0, changedAt: performance.now(), raf: 0, last: 0 };
  const stopSize = watchSize(canvas.parentElement, ({ w, h: ph }) => {
    const dpr = Math.min(DPR_MAX, devicePixelRatio || 1);
    box.w = w; box.h = ph; box.last = 0;
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(ph * dpr);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
  });

  const frame = (ts) => {
    box.raf = requestAnimationFrame(frame);
    const pulse = ctx.pulse();
    const perf = performance.now();
    if (pulse !== box.seen) {
      box.seen = pulse;
      if (pulse) { box.serverNow = Number(pulse.now) || Date.now(); box.recvAt = perf; }
      box.changedAt = perf;
      const t = pulse?.totals;
      caption.textContent = t ? `${t.agents ?? 0} agents · ${t.calls ?? 0} calls` : 'Waiting for activity';
    }
    const idle = perf - box.changedAt > PULSE_IDLE_AFTER_MS;
    if ((idle || ctx.reduced) && ts - box.last < IDLE_FRAME_MS) return;
    box.last = ts;
    draw(g, box, pulse, ctx.reduced ? 0 : ts / 1000, box.serverNow + (perf - box.recvAt) - DELAY_MS);
  };
  box.raf = requestAnimationFrame(frame);
  ctx.onDispose(() => { cancelAnimationFrame(box.raf); stopSize(); });
}

function draw(g, box, pulse, t, T) {
  const { w, h: ph } = box;
  g.clearRect(0, 0, w, ph);
  const cx = w / 2;
  const cy = ph / 2;
  const R = Math.min(w, ph) * 0.36;
  const rx = Math.min(w * 0.34, R * 1.9);
  const ry = R * 0.82;
  const loops = Array.isArray(pulse?.loops) ? pulse.loops : [];
  const events = Array.isArray(pulse?.events) ? pulse.events : [];
  const subs = loops.filter((l) => l.kind !== 'main').slice(0, MAX_NODES);
  const busy = (id) => events.reduce((n, e) => n + (e.loop === id && T - e.t >= 0 && T - e.t < ACTIVITY_MS ? 1 - (T - e.t) / ACTIVITY_MS : 0), 0);
  const breath = 1 + 0.05 * Math.sin((t / BREATH_S) * TAU);
  g.strokeStyle = 'rgba(139,145,161,0.16)';
  g.lineWidth = 1;
  g.beginPath(); g.ellipse(cx, cy, rx, ry, 0, 0, TAU); g.stroke();
  const pos = new Map();
  subs.forEach((l, i) => {
    const a = (i / Math.max(1, subs.length)) * TAU - 0.7 + (t / ORBIT_S) * TAU;
    pos.set(l.id, { x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a), color: AGENT_COLORS[hash(l.id) % AGENT_COLORS.length], act: busy(l.id), done: l.status === 'done' });
  });
  const mainAct = busy('main');
  const core = R * (0.26 + 0.05 * Math.min(1, mainAct));
  const glow = g.createRadialGradient(cx, cy, 0, cx, cy, core * 3.2);
  glow.addColorStop(0, rgba(MAIN_COLOR, 0.34 + 0.2 * Math.min(1, mainAct)));
  glow.addColorStop(1, rgba(MAIN_COLOR, 0));
  g.fillStyle = glow; g.beginPath(); g.arc(cx, cy, core * 3.2 * breath, 0, TAU); g.fill();
  g.fillStyle = MAIN_COLOR; g.beginPath(); g.arc(cx, cy, core * breath, 0, TAU); g.fill();
  for (const p of pos.values()) {
    g.strokeStyle = rgba(p.color, 0.14 + 0.3 * Math.min(1, p.act)); g.lineWidth = 1.2;
    g.beginPath(); g.moveTo(cx, cy); g.lineTo(p.x, p.y); g.stroke();
    const r = R * (0.075 + 0.035 * Math.min(1, p.act));
    g.fillStyle = rgba(p.color, p.done ? 0.35 : 0.95); g.beginPath(); g.arc(p.x, p.y, r, 0, TAU); g.fill();
  }
  if (t === 0) return; // reduced motion: a still picture
  for (const e of events) { // a spark flies between the loop's node and the core while its call is fresh
    const age = T - e.t;
    if (age < 0 || age > SPARK_MS) continue;
    const u = age / SPARK_MS;
    const p = pos.get(e.loop);
    const color = e.err ? ERROR_COLOR : KIND_COLORS[kindOf(e.tool)];
    const from = p ?? { x: cx, y: cy };
    const to = p ? { x: cx, y: cy } : { x: cx + Math.cos(hash(e.target) % 628 / 100) * R * 1.1, y: cy + Math.sin(hash(e.target) % 628 / 100) * R * 0.8 };
    g.fillStyle = rgba(color, 1 - u * 0.6); g.beginPath(); g.arc(lerp(from.x, to.x, u), lerp(from.y, to.y, u), R * 0.04, 0, TAU); g.fill();
  }
}
