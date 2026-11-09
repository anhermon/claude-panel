// The crew: one card per agent beside/under the team's head, DOM so every label is real text and cards never overlap (a grid, not
// floating pins). A card = the agent's avatar (avatar-set.js: a snapshot of the 3D mascot, or its flat twin without WebGL) with a thin
// progress ring, the plain TITLE of its task (never a ticket id), a state chip (colour AND word) and its role. Pointing at a card or
// clicking it grows it into a callout (a bigger avatar, full title, state, what it is doing now, time, tool calls, tokens, its last
// three events, an Open button); clicking again, leaving it or Escape collapses it, Open goes to the agent's detail.
// More agents than cells collapse into one "+N" chip. `createCrew(host, hooks)`; hooks: onHover(id|null), onPick(id) (= open).
import { crewCells, crewSplit, FIGURE_THEME, figureState, chipText, ringPctOf, NOT_STARTED_WORD } from './avatar-model.mjs';
import { createAvatarView } from './avatar-set.js';
import { harnessInfo, harnessLine, harnessOf } from './avatar-harness.mjs';
import { elapsedMs, formatDuration, formatTokens } from './agents-info-logic.mjs';
import { h } from './dom.js';
import { feedOf } from './list-view.js';
import { captionOf, recentFor } from './event-fx.mjs';
import { idHint, retitle, titleOf } from './title-of.mjs';
import { paintProof } from './proof-chip.js';
import { createIdent } from './ident-view.js';
import { identLine, modelEffortOf, typeOf } from './ident-logic.mjs';

const FLASH_MS = 900;
const LEAVE_MS = 160;
const CALLOUT_GAP_PX = 4;
const SEP = ' · ';

export function createCrew(host, hooks) {
  const root = h('div', 'crew');
  const grid = h('ul', 'crew-grid');
  const callout = h('div', 'crew-callout');
  callout.setAttribute('role', 'group');
  callout.setAttribute('aria-hidden', 'true');
  root.append(grid, callout);
  host.append(root);
  const cards = new Map();
  const view = { agents: [], events: [], now: 0, pointed: null, pinned: null, picked: null, size: { w: 0, h: 0 }, open: null, leave: 0, sig: '' };
  let calloutAvatar = null;

  function build(a) {
    const li = h('li', 'crew-card');
    li.dataset.id = a.id;
    const btn = h('button', 'crew-btn');
    btn.type = 'button';
    const avatar = createAvatarView({ key: a.id, ring: true });
    avatar.el.classList.add('crew-av');
    const title = h('span', 'crew-title');
    const chip = h('span', 'crew-chip');
    const role = h('span', 'role-chip');
    const meta = h('span', 'crew-meta');
    meta.append(chip, role);
    const text = h('span', 'crew-txt');
    const ident = createIdent();
    text.append(title, meta, ident.el);
    btn.append(avatar.el, text);
    li.append(btn);
    btn.addEventListener('click', () => { view.pinned = view.pinned === a.id ? null : a.id; paintCallout(); });
    li.addEventListener('pointerenter', () => enter(a.id));
    li.addEventListener('pointerleave', leaveSoon);
    btn.addEventListener('focus', () => hooks.onHover(a.id));
    btn.addEventListener('blur', () => hooks.onHover(null));
    grid.append(li);
    return { li, btn, avatar, title, chip, role, ident, flashTimer: 0, agent: a };
  }

  function fill(c, a) {
    c.agent = a;
    const fs = figureState(a);
    const title = titleOf(a);
    c.li.dataset.state = fs;
    c.li.style.setProperty('--c', FIGURE_THEME[fs].accent);
    c.title.textContent = title;
    c.title.title = [title, harnessLine(a), idHint(a)].filter(Boolean).join(SEP);
    c.chip.textContent = a.notStarted ? NOT_STARTED_WORD : FIGURE_THEME[fs].word;
    c.role.textContent = a.role ?? '';
    c.role.hidden = a.role === null;
    c.ident.set(a);
    paintProof(c.title, a);
    c.btn.setAttribute('aria-label', `${title}: ${chipText(a)}`);
    c.btn.setAttribute('aria-pressed', String(a.id === view.pinned));
    c.li.classList.toggle('sel', a.id === view.picked);
    c.avatar.set(fs, ringPctOf(a), harnessInfo(harnessOf(a)));
    c.avatar.label(`${title}: ${chipText(a)}`);
  }

  let more = null;
  function layout() {
    const { cols, cells } = crewCells(view.size.w, view.size.h);
    root.style.setProperty('--cols', String(cols));
    const { shown, hidden } = crewSplit(view.agents.length, cells);
    const keep = new Set(view.agents.slice(0, shown).map((a) => a.id));
    for (const [id, c] of cards) if (!keep.has(id)) { clearTimeout(c.flashTimer); c.avatar.dispose(); c.li.remove(); cards.delete(id); }
    view.agents.slice(0, shown).forEach((a, i) => {
      const c = cards.get(a.id) ?? build(a);
      cards.set(a.id, c);
      fill(c, a);
      if (grid.children[i] !== c.li) grid.insertBefore(c.li, grid.children[i] ?? null);
    });
    more?.remove();
    more = null;
    if (hidden > 0) {
      more = h('li', 'crew-more', `+${hidden}`);
      more.title = view.agents.slice(shown).map((a) => titleOf(a)).join(', ');
      more.setAttribute('aria-label', `${hidden} more agents: ${more.title}`);
      grid.append(more);
    }
    root.hidden = shown === 0;
    view.sig = ''; // the cards moved: place the callout again
    paintCallout();
  }

  /** Pointer on a card or on the callout: show it at once; pointer away: collapse after a moment (so the pointer can cross onto the callout). */
  function enter(id) { clearTimeout(view.leave); hooks.onHover(id); }
  function leaveSoon() { clearTimeout(view.leave); view.leave = setTimeout(() => hooks.onHover(null), LEAVE_MS); }
  callout.addEventListener('pointerenter', () => clearTimeout(view.leave));
  callout.addEventListener('pointerleave', leaveSoon);
  const collapse = () => { view.pinned = null; view.pointed = null; hooks.onHover(null); paintCallout(); };
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !callout.classList.contains('open')) return;
    e.stopPropagation(); // the callout closes first; a second Escape closes the open detail
    collapse();
  }, true);

  function paintCallout() {
    const id = view.pointed ?? view.pinned; // the pointer wins over a pinned one
    const a = id === null ? null : view.agents.find((x) => x.id === id);
    const c = a ? cards.get(a.id) : undefined;
    for (const [cid, card] of cards) {
      card.li.classList.toggle('hot', cid === id);
      card.btn.setAttribute('aria-pressed', String(cid === view.pinned));
      card.avatar.hot(cid === id);
    }
    if (!a || !c) {
      callout.classList.remove('open');
      callout.setAttribute('aria-hidden', 'true');
      view.open = null;
      view.sig = '';
      return;
    }
    const fs = figureState(a);
    const title = titleOf(a);
    const step = retitle(feedOf(a) || FIGURE_THEME[fs].word, view.agents);
    const recent = recentFor(view.events, a.id);
    const sig = JSON.stringify([a.id, title, fs, a.pct, step, a.calls, a.tokens, a.role, harnessLine(a), identLine(a), recent.map((e) => e.id)]);
    if (view.open !== a.id) { // a new agent: its own bigger avatar (the same figure as its card)
      calloutAvatar?.dispose();
      calloutAvatar = createAvatarView({ key: a.id, ring: true });
      calloutAvatar.el.classList.add('callout-av');
      view.open = a.id;
    }
    if (sig === view.sig) { callout.classList.add('open'); return; } // nothing changed: keep the DOM (a click on Open must not lose its button)
    view.sig = sig;
    calloutAvatar.set(fs, ringPctOf(a), harnessInfo(harnessOf(a)));
    calloutAvatar.label(`${title}: ${chipText(a)}`);
    callout.replaceChildren();
    const head = h('div', 'callout-head');
    const names = h('div', 'callout-names');
    const heading = h('p', 'callout-title', title);
    heading.title = [harnessLine(a), idHint(a)].filter(Boolean).join(SEP);
    names.append(heading, h('span', 'crew-chip', chipText(a)));
    head.append(calloutAvatar.el, names);
    const rows = [['Doing', step], ['Running', formatDuration(elapsedMs(a, view.now))], ['Tool calls', a.calls === null ? '' : String(a.calls)], ['Tokens', formatTokens(a.tokens)], ['Type', typeOf(a)], ['Model', modelEffortOf(a)], ['Harness', harnessLine(a)], ['Role', a.role ?? '']].filter(([, v]) => v !== '');
    const dl = h('dl', 'callout-rows');
    for (const [k, v] of rows) { const d = h('div'); d.append(h('dt', '', k), h('dd', k === 'Running' ? 'callout-time' : '', v)); dl.append(d); }
    callout.append(head, dl);
    if (recent.length > 0) {
      const ul = h('ul', 'callout-events');
      ul.setAttribute('aria-label', 'Recent events');
      for (const e of recent) ul.append(h('li', '', captionOf(e, view.agents)));
      callout.append(ul);
    }
    const open = h('button', 'callout-open', 'Open');
    open.type = 'button';
    open.setAttribute('aria-label', `Open ${title}`);
    open.addEventListener('click', () => { collapse(); hooks.onPick(a.id); });
    callout.append(open);
    callout.style.setProperty('--c', FIGURE_THEME[fs].accent);
    callout.dataset.id = a.id;
    callout.setAttribute('aria-hidden', 'false');
    const left = Math.min(Math.max(0, c.li.offsetLeft), Math.max(0, root.clientWidth - callout.offsetWidth));
    callout.style.left = `${left}px`;
    callout.style.top = `${Math.max(0, c.li.offsetTop - CALLOUT_GAP_PX)}px`;
    callout.style.setProperty('--ox', `${Math.max(0, c.li.offsetLeft - left) + c.li.offsetWidth / 2}px`);
    callout.classList.add('open');
  }

  // columns come from the stage's width, rows from the window's height (the stage itself is as tall as its content)
  const ro = new ResizeObserver(() => {
    const w = host.clientWidth;
    const hh = window.innerHeight;
    if (Math.abs(w - view.size.w) < 1 && hh === view.size.h) return;
    view.size = { w, h: hh };
    layout();
    hooks.onLayout?.();
  });
  ro.observe(host);
  ro.observe(document.documentElement);

  return {
    el: root,
    /** Agents sorted as the list is (blocked, running, waiting, done); `now` in ms. */
    update(agents, now, events = []) {
      view.agents = agents;
      view.events = events;
      view.now = now;
      layout();
    },
    /** Elapsed time in the open callout (about once a second). */
    tick(now) {
      view.now = now;
      const open = callout.hidden ? null : cards.get(callout.dataset.id)?.agent;
      const t = callout.querySelector('.callout-time');
      if (open && t) t.textContent = formatDuration(elapsedMs(open, now));
    },
    point(id) { view.pointed = id; paintCallout(); },
    /** The agent whose detail is open (its card is marked). */
    pick(id) { view.picked = id; for (const [cid, c] of cards) c.li.classList.toggle('sel', cid === id); },
    /** The avatar element of an agent's card (null: not shown), where a beam lands. */
    avatarEl: (id) => cards.get(id)?.avatar.el ?? null,
    /** One-shot animation of an event (FX of event-fx.mjs) on the agent's card and, when open, its callout. */
    play(id, kind) { cards.get(id)?.avatar.play(kind); if (view.open === id) calloutAvatar?.play(kind); },
    flash(id) {
      const c = cards.get(id);
      if (!c) return;
      c.li.classList.add('flash');
      c.avatar.flash();
      clearTimeout(c.flashTimer);
      c.flashTimer = setTimeout(() => c.li.classList.remove('flash'), FLASH_MS);
    },
    /** Height of the crew block, so the renderer keeps the big head above it. */
    height: () => (root.hidden ? 0 : root.offsetHeight),
    dispose() { ro.disconnect(); clearTimeout(view.leave); calloutAvatar?.dispose(); for (const c of cards.values()) c.avatar.dispose(); root.remove(); },
  };
}
