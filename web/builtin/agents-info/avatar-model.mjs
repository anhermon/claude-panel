// Pure maths of the avatars (no DOM, no three): the state of every agent's figure, its theme (chip word, accent), its pose at a time,
// the accessory per state, how many cards fit under the head, the small helpers the animation loop uses.
// Tested by avatar-model.test.mjs.

export const MOOD_COLORS = Object.freeze({
  working: '#67e8f9', thinking: '#a5b4fc', waiting: '#fbbf24', blocked: '#f87171', done: '#86efac', idle: '#94a3b8',
});
export const MOODS = Object.freeze(Object.keys(MOOD_COLORS));
const TAU = Math.PI * 2;

/** How closed the eyes are (0 open .. 1 shut) at `t`: a short blink every BLINK_EVERY_S seconds. */
export const BLINK_EVERY_S = 4.2;
const BLINK_S = 0.16;
export function blinkAmount(t) {
  const p = t % BLINK_EVERY_S;
  return p < BLINK_S ? Math.sin((p / BLINK_S) * Math.PI) : 0;
}

/** A stable number in [0,1) for a string. */
export function hash01(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return ((h >>> 0) % 100000) / 100000;
}

/** Move `cur` toward `target` by an exponential approach (`rate` per second); `Infinity` jumps. */
export const approach = (cur, target, dt, rate) => (rate === Infinity ? target : cur + (target - cur) * (1 - Math.exp(-rate * dt)));

// ---- the figures: one small avatar head per agent (ported from the delegation-kit ticket board, "Vinyl" clay style)

/** What a figure shows per state: the chip word and the accent of chip, ring and halo. The body keeps its harness colour for every state (avatar-harness.mjs). */
export const FIGURE_THEME = Object.freeze({
  working: { word: 'Working', accent: '#ff9a62' },
  thinking: { word: 'Thinking', accent: '#a5b4fc' },
  testing: { word: 'Testing', accent: '#67e8f9' },
  waiting: { word: 'Waiting', accent: '#94a3b8' },
  blocked: { word: 'Blocked', accent: '#fbbf24' },
  done: { word: 'Done', accent: '#4ade80' },
  failed: { word: 'Failed', accent: '#f87171' },
});
/** The accessory badge beside the head per state (the same on the 3D snapshot and the flat twin; null: none, the legs and eyes say it): thinking dots, check-list, zzz, an alarm, a check. */
export const FIGURE_PROP = Object.freeze({ working: null, thinking: 'dots', testing: 'list', waiting: 'zzz', blocked: null, failed: 'bang', done: 'check' });
export const FIGURE_STATES = Object.freeze(Object.keys(FIGURE_THEME));
const GENERIC_KINDS = Object.freeze(['working', 'thinking', 'waiting', 'done']);
const FAILED_STAGES = Object.freeze(['failed', 'fail', 'rejected', 'error']);

/** The state a figure shows: the panel's state, plus "failed" (a ticket that failed) and "thinking" (running, but in no kind of work). */
export function figureState(a) {
  if (FAILED_STAGES.includes((a.ticket?.stage ?? '').toLowerCase())) return 'failed';
  if (a.state === 'working' && (a.kind === null || GENERIC_KINDS.includes(a.kind))) return 'thinking';
  return a.state in FIGURE_THEME ? a.state : 'working';
}

/** The figure the team's head shows for a mood (idle: a waiting one). */
export const MOOD_FIGURE = Object.freeze({ working: 'working', thinking: 'thinking', waiting: 'waiting', blocked: 'blocked', done: 'done', idle: 'waiting' });

export const NOT_STARTED_WORD = 'Not started';
/** The share of the progress ring: an attempt that never started has none (an empty grey ring, never the sweep of a running agent). */
export const ringPctOf = (a) => (a.notStarted ? 0 : a.pct);
/** The wording of the chip: the state word, with the percentage when one was posted ("Working · 40%"); "Not started" for an attempt that never ran. */
export const chipText = (a) => {
  if (a.notStarted) return NOT_STARTED_WORD;
  const w = FIGURE_THEME[figureState(a)].word;
  return a.pct !== null && a.state !== 'done' && figureState(a) !== 'failed' ? `${w} · ${a.pct}%` : w;
};

/** How many figures get a label; the rest collapse into one "+N" chip. `cells`: the places the pane has for cards. */
export const CREW_MAX_LABELLED = 6;
export function crewSplit(count, cells) {
  const fit = Math.max(1, Math.min(CREW_MAX_LABELLED, cells));
  if (count <= fit) return { shown: count, hidden: 0 };
  const shown = cells > fit ? fit : Math.max(1, fit - 1); // the +N chip takes a cell of its own unless every cell is a figure's
  return { shown, hidden: count - shown };
}
/** The card grid of a stage `w` x `h` px: columns by width (at most three: a card needs room for its title), rows by height; `cells` = columns x rows. */
export const CARD_MIN_W = 150;
export const ROWS_TALL = 3;
export const ROWS_SHORT = 2;
export const MAX_COLS = 3;
export const TALL_STAGE_PX = 460;
export function crewCells(w, h) {
  const cols = Math.max(1, Math.min(MAX_COLS, Math.floor(w / CARD_MIN_W)));
  return { cols, cells: cols * (h >= TALL_STAGE_PX ? ROWS_TALL : ROWS_SHORT) };
}

/**
 * The pose of one figure (the Claude Code mascot: a 12x8 block with two arm stubs, four legs and two eyes, on a 1-unit grid): a pure
 * function of its state and time `t` (seconds; 0 = the still pose of reduced motion and of the flat twin), `since` seconds since it
 * entered the state (a finished one hops once, a failed one shakes), `blink` 0..1. Fields: eyes ('open' | 'squint' > < | 'cross' x),
 * lid (eye height factor: blink, sleepy, wide), look {x, y} (-1..1), armL / armR (radians, + = raised from the side), legs [4] (lift in
 * grid units), bob / lift (grid units), sx / sy (squash), shakeX (grid units), tilt (radians), dim (light on the body), running.
 */
export const FIG = Object.freeze({
  stepHz: 1.8, testHz: 1.1, legLift: 0.7, bob: 0.16, bobHz: 0.6, armSwing: 0.3, armUp: 1.35, armRest: 0.5, armDroop: -0.55, armFail: -0.9, armThink: 1.0,
  hop: 1.3, hopSec: 0.9, failShake: 0.5, failSec: 1.0, waitDim: 0.8, doneDim: 0.88, wide: 1.3, sleepy: 0.35, tiltThink: 0.04,
});
export function figurePose(state, t, since = 99, blink = 0, phase = 0) {
  const live = t > 0;
  const P = { eyes: 'open', lid: 1 - blink, look: { x: 0, y: 0 }, armL: 0, armR: 0, legs: [0, 0, 0, 0], bob: 0, lift: 0, sx: 1, sy: 1, shakeX: 0, tilt: 0, dim: 1, running: 0 };
  const breath = live ? FIG.bob * Math.sin(t * FIG.bobHz * TAU + phase) : 0;
  const walk = (hz) => {
    const w = live ? Math.sin(t * hz * TAU + phase) : 0;
    P.legs = [0, 1, 2, 3].map((i) => (live ? Math.max(0, Math.sin(t * hz * TAU + phase + (i % 2) * Math.PI)) * FIG.legLift : 0));
    P.bob = live ? FIG.bob * Math.abs(w) : 0;
    P.armL = FIG.armSwing * w;
    P.armR = -FIG.armSwing * w;
  };
  switch (state) {
    case 'working':
      Object.assign(P, { eyes: 'squint', running: 1 });
      walk(FIG.stepHz);
      break;
    case 'testing':
      Object.assign(P, { eyes: 'squint', running: 1, look: { x: live ? Math.sin(t * 2.4) : 0, y: 0 } });
      walk(FIG.testHz);
      break;
    case 'thinking':
      Object.assign(P, { eyes: 'squint', armR: FIG.armThink, bob: breath, tilt: live ? FIG.tiltThink * Math.sin(t * 0.8 + phase) : 0, look: { x: -0.5, y: 0.6 } });
      break;
    case 'waiting':
      Object.assign(P, { lid: (1 - blink) * FIG.sleepy, bob: breath, dim: FIG.waitDim, look: { x: 0, y: -0.4 } });
      break;
    case 'blocked':
      Object.assign(P, { armL: FIG.armDroop, armR: FIG.armDroop, bob: breath, shakeX: live ? 0.08 * Math.sin(t * 22) * Math.max(0, Math.sin(t * 1.3 + phase)) : 0, look: { x: 0, y: -0.5 } });
      break;
    case 'failed': {
      const shake = live && since < FIG.failSec ? Math.sin(since * 26) * FIG.failShake * (1 - since / FIG.failSec) : 0;
      Object.assign(P, { eyes: 'cross', lid: 1, armL: FIG.armFail, armR: FIG.armFail, shakeX: shake, sy: 0.96, sx: 1.03, dim: 0.9 });
      break;
    }
    case 'done': {
      const u = Math.min(since / FIG.hopSec, 1);
      const hop = live && u < 1 ? Math.sin(u * Math.PI) : 0;
      Object.assign(P, { lid: (1 - blink * 0.6) * FIG.wide, armL: u < 1 || !live ? FIG.armUp : FIG.armRest, armR: u < 1 || !live ? FIG.armUp : FIG.armRest, lift: FIG.hop * hop, sy: 1 + 0.06 * hop, bob: live && u >= 1 ? breath : 0, dim: FIG.doneDim });
      break;
    }
    default:
      P.bob = breath;
      break;
  }
  return P;
}
