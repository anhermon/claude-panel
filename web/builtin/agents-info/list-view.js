// The agent list: one row per agent, updated in place (a row is never rebuilt, so its face keeps animating and a hover survives
// a data update). Row: the clay avatar with a progress ring, name, the one-line feed ("Writing UI: board.css"), state pill, kind, time, tokens.
// Order: the main session ("Me") first, then blocked, running, waiting, done. A thin bar under each row shows its size against the others
// (tokens, else time). Selecting a row (click / Enter) opens its detail; the legend names only the kinds present.
import { elapsedMs, formatDuration, formatErrors, formatTokens, hasKind, legendOf, sortAgents, waitingChipOf } from './agents-info-logic.mjs';
import { spanOf } from './gantt-logic.mjs';
import { createGantt, createTrack } from './gantt-view.js';
import { h } from './dom.js';
import { createAvatarView } from './avatar-set.js';
import { harnessInfo, harnessLine, harnessOf } from './avatar-harness.mjs';
import { NOT_STARTED_WORD, figureState, ringPctOf } from './avatar-model.mjs';
import { plainTitle, retitle, titleOf } from './title-of.mjs';
import { paintProof } from './proof-chip.js';
import { createIdent } from './ident-view.js';

const STATE_WORD = Object.freeze({ working: 'Working', testing: 'Testing', waiting: 'Waiting', blocked: 'Blocked', done: 'Done' });
const SEP = ' · ';
const PULSE_MS = 1100;

/** "Writing UI: board.css" (kind verb + file basenames), else the headline as posted. */
export function feedOf(a) {
  if (a.files.length === 0) return a.headline;
  const head = a.headline.includes(':') ? a.headline.split(':')[0] : a.headline || a.kindLabel;
  return `${head}: ${a.files.join(', ')}`;
}

export function createList(listEl, legendEl, hooks) {
  const rows = new Map();
  let selected = null;
  let last = null; // { sorted, kinds } of the last update

  function build(a) {
    const root = h('li', 'row');
    root.dataset.id = a.id;
    const btn = h('button', 'row-btn');
    btn.type = 'button';
    const face = createAvatarView({ key: a.id, label: titleOf(a), ring: true });
    const faceBox = h('span', 'row-face');
    faceBox.append(face.el);
    const name = h('span', 'row-name');
    const role = h('span', 'role-chip');
    const wait = h('span', 'wait-chip');
    const err = h('span', 'err-chip');
    const feed = h('span', 'row-feed');
    const pill = h('span', 'pill');
    const kind = h('span', 'row-kind');
    const branch = h('span', 'row-branch');
    const meta = h('span', 'row-meta');
    const main = h('span', 'row-main');
    const top = h('span', 'row-top');
    top.append(name, role, wait, err, pill);
    const sub = h('span', 'row-sub');
    const ident = createIdent();
    sub.append(kind, ident.el, branch, meta);
    const track = createTrack();
    main.append(top, feed, sub);
    btn.append(faceBox, main, track.el);
    root.append(btn);
    btn.addEventListener('click', () => hooks.onSelect(a.id));
    root.addEventListener('pointerenter', () => hooks.onHover(a.id));
    root.addEventListener('pointerleave', () => hooks.onHover(null));
    btn.addEventListener('focus', () => hooks.onHover(a.id));
    btn.addEventListener('blur', () => hooks.onHover(null));
    listEl.append(root);
    return { root, btn, face, name, role, wait, err, feed, pill, kind, ident, branch, meta, track, agent: a, pulseTimer: 0 };
  }

  function fill(r, a, now, all) {
    r.agent = a;
    r.root.dataset.state = a.state;
    r.root.dataset.main = String(a.isMain);
    r.root.dataset.titled = String(Boolean(a.isMain && a.title));
    r.root.dataset.notStarted = String(a.notStarted);
    r.root.style.setProperty('--c', a.kindColor);
    r.face.set(figureState(a), ringPctOf(a), harnessInfo(harnessOf(a)));
    const mainTitle = a.isMain && a.title ? plainTitle(a.title) : '';
    const title = a.isMain ? (mainTitle ? `${plainTitle(a.name)}${SEP}${mainTitle}` : plainTitle(a.name)) : titleOf(a);
    const stateWord = a.notStarted ? NOT_STARTED_WORD : STATE_WORD[a.state];
    r.face.label(`${title}, ${stateWord}`);
    r.name.textContent = title;
    r.name.title = [a.isMain ? mainTitle : '', a.branch ?? '', harnessLine(a)].filter(Boolean).join(SEP);
    r.role.textContent = a.role ?? '';
    r.role.hidden = a.role === null;
    if (a.ticket) r.role.title = `${titleOf(a)} · ${plainTitle(a.ticket.text, false)}`;
    else r.role.removeAttribute('title');
    const wait = waitingChipOf(a);
    r.wait.textContent = wait?.text ?? '';
    r.wait.hidden = wait === null;
    if (wait) r.wait.title = wait.title;
    else r.wait.removeAttribute('title');
    const errText = formatErrors(a.errors);
    r.err.textContent = errText;
    r.err.hidden = errText === '';
    r.feed.textContent = a.notStarted ? plainTitle(a.note, false) || stateWord : retitle(feedOf(a), all) || stateWord;
    r.pill.textContent = stateWord;
    paintProof(r.feed, a);
    r.kind.textContent = hasKind(a) ? `${a.kindGlyph} ${a.kindLabel}` : '';
    r.kind.hidden = !hasKind(a);
    r.ident.set(a);
    r.branch.textContent = a.branch ?? '';
    r.branch.hidden = !a.branch;
    const parts = [a.notStarted ? '' : formatDuration(elapsedMs(a, now)), spanOf(a, now), formatTokens(a.tokens) && `${formatTokens(a.tokens)} tok`, a.pct !== null && a.state !== 'done' && !a.notStarted ? `${a.pct}%` : ''];
    r.meta.textContent = parts.filter(Boolean).join(SEP);
    r.btn.setAttribute('aria-pressed', String(a.id === selected));
  }

  /** The shared axis and every row's bar, from the last update (the time moves on; the mode or the width can change). */
  function repaint(now) {
    if (last === null) return;
    const scale = gantt.update(last.sorted, now);
    for (const r of rows.values()) r.track.set(r.agent, scale, last.kinds);
  }
  const gantt = createGantt(document.getElementById('g-head'), listEl, () => repaint(Date.now()));

  function renderLegend(agents) {
    legendEl.replaceChildren();
    const items = legendOf(agents);
    legendEl.hidden = items.length === 0;
    for (const k of items) {
      const chip = h('span', 'legend-chip', `${k.glyph} ${k.label}`);
      chip.style.setProperty('--c', k.color);
      legendEl.append(chip);
    }
  }

  return {
    update(agents, now, kinds = {}) {
      const sorted = sortAgents(agents);
      last = { sorted, kinds };
      const ids = new Set(sorted.map((a) => a.id));
      for (const [id, r] of rows) if (!ids.has(id)) { clearTimeout(r.pulseTimer); r.face.dispose(); r.root.remove(); rows.delete(id); }
      sorted.forEach((a, i) => {
        const r = rows.get(a.id) ?? build(a);
        rows.set(a.id, r);
        fill(r, a, now, sorted);
        if (listEl.children[i] !== r.root) listEl.insertBefore(r.root, listEl.children[i] ?? null);
      });
      listEl.hidden = sorted.length === 0;
      renderLegend(sorted);
      repaint(now);
    },
    /** Durations of running agents (called about once a second; touches only text). */
    tick(now) {
      for (const r of rows.values()) if (r.agent.endedAt === null) {
        const parts = r.meta.textContent.split(SEP);
        parts[0] = formatDuration(elapsedMs(r.agent, now));
        r.meta.textContent = parts.join(SEP);
      }
      repaint(now);
    },
    select(id) {
      selected = id;
      for (const [rid, r] of rows) { r.root.classList.toggle('selected', rid === id); r.btn.setAttribute('aria-pressed', String(rid === id)); }
      if (id !== null) rows.get(id)?.root.scrollIntoView({ block: 'nearest' });
    },
    /** Highlight a row (the satellite under the pointer). */
    mark(id) { for (const [rid, r] of rows) r.root.classList.toggle('hot', rid === id); },
    /** One-shot animation of an event on the agent's row avatar (event-fx.mjs FX kinds). */
    play(id, kind) { rows.get(id)?.face.play(kind); },
    /** A status change of this agent: its row flashes once. */
    pulse(id) {
      const r = rows.get(id);
      if (!r) return;
      r.root.classList.add('pulse');
      r.face.flash();
      clearTimeout(r.pulseTimer);
      r.pulseTimer = setTimeout(() => r.root.classList.remove('pulse'), PULSE_MS);
    },
    count: () => rows.size,
  };
}
