// What an event of the host (hooks/agents-info-data.ts: spawn, handoff, state, work, progress) does to the avatar it is about: which
// one-shot animation plays (FX), and the one-line caption in words with the task TITLE, never an id ("Fix transcript lookup: done").
// Pure (no DOM); tested by event-fx.test.mjs. The animations themselves are CSS (agents-info.css, `.av[data-fx]`) and the beam (fx-layer.js).
import { figureState } from './avatar-model.mjs';
import { clipTitle, plainTitle, titleOf } from './title-of.mjs';

/** The one-shot animations: how long each plays (ms) and the glyph that bursts from the avatar (null: only the motion). */
export const FX = Object.freeze({
  spawn: { ms: 900, glyph: '✦' },
  receive: { ms: 900, glyph: null },
  done: { ms: 1300, glyph: '✓' },
  error: { ms: 1000, glyph: '!' },
  blocked: { ms: 1200, glyph: null },
  change: { ms: 700, glyph: null },
  tool: { ms: 600, glyph: null },
});
export const BEAM_MS = 700;
export const RECENT_EVENTS = 3;

/** The animation an event plays on its agent: spawn -> pop + sparkle; handoff -> the worker receives a beam; a state change by what it became; a new kind of work -> a tool tick; progress: none (the ring eases). */
export function fxKindOf(event, agent = null) {
  switch (event.kind) {
    case 'spawn': return 'spawn';
    case 'handoff': return 'receive';
    case 'work': return 'tool';
    case 'state':
      if (event.to === 'failed' || (agent !== null && figureState(agent) === 'failed')) return 'error';
      if (event.to === 'done') return 'done';
      if (event.to === 'blocked') return 'blocked';
      return 'change';
    default: return null;
  }
}

const STATE_PHRASE = Object.freeze({ working: 'working', testing: 'testing', waiting: 'waiting for you', blocked: 'blocked', done: 'done', failed: 'failed' });
const KIND_LABEL = /^[^·]*·\s*/;

/** "Redesign agent avatars: done"; `agents` are the rows (a title comes from the agent the event is about, else the event's own text without ids is not used). */
export function captionOf(event, agents) {
  const a = agents.find((x) => x.id === event.agent);
  const title = a ? clipTitle(titleOf(a)) : '';
  const head = title === '' ? 'Agent' : title;
  switch (event.kind) {
    case 'spawn': return `${head}: created`;
    case 'handoff': return `${head}: started`;
    case 'work': return `${head}: ${plainTitle(event.text.replace(KIND_LABEL, ''), false).toLowerCase() || 'new step'}`;
    case 'progress': return `${head}: ${event.to}%`;
    case 'state': {
      const failed = event.to === 'failed' || (a && figureState(a) === 'failed');
      return `${head}: ${STATE_PHRASE[failed ? 'failed' : event.to] ?? plainTitle(event.to, false)}`;
    }
    default: return head;
  }
}

/** The newest `n` events about one agent, newest first (what the callout lists). */
export const recentFor = (events, agentId, n = RECENT_EVENTS) => events.filter((e) => e.agent === agentId).sort((a, b) => b.id - a.id).slice(0, n);
