// The Agents scene: the state of the team as a small 3D Claude Code mascot (its mood) with one avatar card per agent (plain task title,
// state chip, progress ring, a callout when pointed at), a ticker of live events and a list with a small avatar and progress for every
// agent. Drawn from live/data.json (written by the panel mod,
// hooks/agents-info-host.ts; see README.md for the data contract). It moves ONLY for a reason: the head breathes, and a change in
// the data (new events) pulses, flashes, eases an arc or docks a satellite. No events: calm.
import panel from 'panel';
import { maxEventId, moodOf, moodOfAgent, newEvents, normalizeData, layoutFor, satellitesOf, sortAgents, summaryOf, waitingLabelOf } from './agents-info-logic.mjs';
import { FIGURE_THEME, MOOD_COLORS, MOOD_FIGURE, NOT_STARTED_WORD, figureState } from './avatar-model.mjs';
import { createAvatarView, useStudio } from './avatar-set.js';
import { harnessInfo, harnessOf } from './avatar-harness.mjs';
import { createCrew } from './crew-view.js';
import { createDetail } from './detail-view.js';
import { fxKindOf, captionOf } from './event-fx.mjs';
import { beam } from './fx-layer.js';
import { createList } from './list-view.js';
import { sessionRowOf } from './session-row.mjs';
import { createTicker } from './ticker.js';
import { titleOf } from './title-of.mjs';

const POLL_MS = 1000;
const TICK_MS = 1000;
const FORCE_FALLBACK = 'fallback';
const MOOD_LABEL = Object.freeze({ working: 'Working', thinking: 'Thinking', waiting: 'Waiting for you', blocked: 'Blocked', done: 'All done', idle: 'No agents yet' });

const $ = (id) => document.getElementById(id);
const app = $('app');
const reducedQuery = matchMedia('(prefers-reduced-motion: reduce)');
const emit = (name, data) => { try { panel.emit(name, data); } catch { /* the host is not listening */ } };

const view = { data: normalizeData(null), agents: [], mood: 'idle' };
const box = { studio: null, seen: null, selected: null, failed: null, synth: 0 };

/** The team's head: the same mascot as every agent, bigger; its state is the team's mood. */
const hero = createAvatarView({ key: 'hero', label: 'The state of the team as the Claude Code mascot; drag to turn it. The agents are the cards below it' });
hero.el.classList.add('hero');
$('avatar').append(hero.el);

const colorOf = (agentId) => { const a = view.agents.find((x) => x.id === agentId); return a ? FIGURE_THEME[figureState(a)].accent : MOOD_COLORS[view.mood]; };

function hasWebGL() {
  try {
    const c = document.createElement('canvas');
    return Boolean(c.getContext('webgl2') ?? c.getContext('webgl'));
  } catch { return false; }
}

// ---- interaction: a satellite / dot and its row are the same thing; selecting one opens its detail (Back / Escape closes it)
const selectedRow = () => view.agents.find((a) => a.id === box.selected) ?? null;
/** The mood the head shows: the open agent's own state while a detail is open, else the whole team's. */
const shownMood = () => { const a = selectedRow(); return a === null ? view.mood : moodOfAgent(a); };
function paintMood() {
  const a = selectedRow();
  const mood = shownMood();
  $('overall').style.setProperty('--mood', MOOD_COLORS[mood]);
  $('mood').textContent = a === null ? waitingLabelOf(view.data) || MOOD_LABEL[mood] : `${titleOf(a)}: ${a.notStarted ? NOT_STARTED_WORD : MOOD_LABEL[mood]}`;
  hero.set(MOOD_FIGURE[mood]);
}
function select(id) {
  const row = view.agents.find((a) => a.id === id);
  if (!row) return;
  box.selected = id;
  app.dataset.view = 'detail';
  list.select(id);
  crew.pick(row.isMain ? null : id);
  paintMood();
  detail.open(row);
}
function closed() {
  const id = box.selected;
  box.selected = null;
  app.dataset.view = 'list';
  list.select(null);
  crew.pick(null);
  paintMood();
  if (id !== null) document.querySelector(`.row[data-id="${CSS.escape(id)}"] .row-btn`)?.focus({ preventScroll: true });
}
/** A card or row under the pointer (null: none): its figure grows, its callout opens; the open agent's stays when nothing is pointed at. */
const pointed = (id) => { list.mark(id); crew.point(id); };
const crew = createCrew($('stage'), { onHover: pointed, onPick: select });
const sceneHooks = { isDark: () => true, reduced: () => reducedQuery.matches, onLost: () => { box.studio?.dispose(); box.studio = null; showFlat(); } };
const list = createList($('list'), $('legend'), { onSelect: select, onHover: pointed });
const agentById = (id) => view.agents.find((x) => x.id === id);
const ticker = createTicker($('ticker'), { colorOf, harnessOf: (id) => harnessInfo(harnessOf(agentById(id))), stateOf: (id) => { const a = view.agents.find((x) => x.id === id); return a ? figureState(a) : 'working'; }, textOf: (e) => captionOf(e, view.agents) });
const detail = createDetail($('detail'), { emit, onClose: closed });

// ---- the host's commands: the terminal pane has no mouse, so its Buttons reach the page as host messages (hooks/agent-controls.ts names the same three)
const HOST_OPEN = 'open-agent';
const HOST_TAB = 'tab';
const HOST_CLOSE = 'close';
const HOST_OPEN_SESSION = 'open-session'; // a card of the board's Other sessions frame, routed by the page (web/events-client.js)
panel.on(HOST_OPEN, (d) => { if (typeof d?.id === 'string') select(d.id); });
panel.on(HOST_TAB, (d) => detail.tab(d?.name));
panel.on(HOST_CLOSE, () => detail.close());
/** A session that is not one of this tile's agents: its detail is built by the host from the session's own transcript. */
panel.on(HOST_OPEN_SESSION, (d) => {
  const row = sessionRowOf(d);
  if (row === null) return;
  const known = view.agents.find((a) => a.id === row.id);
  if (known) { select(known.id); return; }
  box.selected = row.id;
  app.dataset.view = 'detail';
  list.select(null);
  crew.pick(null);
  paintMood();
  detail.open(row);
});

// ---- drawing
function apply(data, fresh) {
  view.data = data;
  view.agents = sortAgents(data.agents);
  view.mood = data.agents.length === 0 ? 'idle' : moodOf(data);
  list.update(view.agents, Date.now(), data.kinds);
  crew.update(satellitesOf(view.agents), Date.now(), data.events);
  list.select(box.selected);
  detail.refresh(view.agents);
  paintMood();
  $('summary').textContent = summaryOf(view.agents);
  $('empty').hidden = view.agents.length > 0;
  const events = [...fresh, ...failures(fresh)];
  if (events.length > 0) {
    ticker.push(events);
    for (const e of events) { list.pulse(e.agent); crew.flash(e.agent); act(e); }
  }
}

/** A ticket that just failed has no event of its own (the host diffs states): the page notices the figure turning "failed" and plays the error. */
function failures(fresh) {
  const told = new Set(fresh.map((e) => e.agent)); // an agent whose own event arrived with the failure already tells it (its caption says "failed")
  const now = new Set(view.agents.filter((a) => !a.isMain && figureState(a) === 'failed').map((a) => a.id));
  const out = box.failed === null ? [] : [...now].filter((id) => !box.failed.has(id) && !told.has(id)).map((id) => ({ id: -(++box.synth), t: Date.now(), agent: id, from: '', to: 'failed', kind: 'state', text: '' }));
  box.failed = now;
  return out;
}

/** What an event does on screen: a beam from the head to the worker on a handoff, else the one-shot animation of its kind on the agent's avatars. */
function act(e) {
  const agent = view.agents.find((a) => a.id === e.agent) ?? null;
  const kind = fxKindOf(e, agent);
  const land = () => { if (kind !== null) { crew.play(e.agent, kind); list.play(e.agent, kind); } };
  if (e.kind === 'handoff') { hero.play('tool'); beam($('stage'), hero.el, crew.avatarEl(e.agent), land); } else land();
}

function onData(raw) {
  const data = normalizeData(raw);
  // the first read marks what is there as seen: a reload replays nothing
  const fresh = box.seen === null ? [] : newEvents(data.events, box.seen);
  box.seen = Math.max(box.seen ?? 0, maxEventId(data.events));
  apply(data, fresh);
}

/** No WebGL: every avatar is the flat twin of the clay figure (mini-face.js). */
function showFlat() {
  app.dataset.mode = 'svg';
  useStudio(null);
}

async function start() {
  if (new URLSearchParams(location.search).has(FORCE_FALLBACK) || !hasWebGL()) return showFlat();
  try {
    const { createStudio } = await import('./avatar3d.js');
    box.studio = await createStudio(sceneHooks);
    useStudio(box.studio);
    app.dataset.mode = 'webgl';
  } catch (err) {
    console.warn('agents-info: 3D avatars unavailable, using the flat twins', err);
    showFlat();
  }
}

new ResizeObserver(() => { app.dataset.layout = layoutFor(app.clientWidth, app.clientHeight); }).observe(app);
reducedQuery.addEventListener('change', () => box.studio?.requestRender());
setInterval(() => { list.tick(Date.now()); crew.tick(Date.now()); }, TICK_MS);
app.dataset.layout = layoutFor(app.clientWidth, app.clientHeight);
panel.data(onData, { every: POLL_MS });
start();
window.__agentsInfo = { open: select, detail: () => detail.state(), mode: () => app.dataset.mode, stats: () => box.studio?.stats() ?? null, rows: () => list.count(), ticks: () => ticker.count() };
