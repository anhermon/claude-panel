// The drill-down of one agent, inside the Agents tile: a header with a back button, four tabs (Progress, which opens first, Transcript,
// Metrics, Struggles) and the body of the active tab. Progress carries a red dot while something is open; Struggles a count of the open or recent problems. The page asks the host for the detail with
// `panel.emit('agent', {id, pages})` (repeated every heartbeat while open; 'agent-close' ends it) and reads the answer from
// live/detail.json once a second. Escape and the back button close it. Scroll position survives updates; a transcript that was
// scrolled to its end keeps following the newest entry.
import { titleOf } from './title-of.mjs';
import { h } from './dom.js';
import { DEFAULT_TAB, DETAIL_URL, plainTitle, EVENT_AGENT, EVENT_CLOSE, TABS, TAB_LABEL, TIMING, fillState, normalizeDetail, requestOf } from './detail-logic.mjs';
import { renderMetrics } from './detail-metrics.js';
import { paintProof } from './proof-chip.js';
import { renderProgress } from './detail-progress.js';
import { hasOpenIssue } from './detail-progress-logic.mjs';
import { renderStruggles } from './detail-struggles.js';
import { renderTranscript } from './detail-transcript.js';
import { formatDuration } from './agents-info-logic.mjs';

const STATE_WORD = Object.freeze({ working: 'Working', testing: 'Testing', waiting: 'Waiting', blocked: 'Blocked', done: 'Done' });
const FOLLOW_SLACK_PX = 24;
const PAGE_STEP = 1;
const TICK_MS = 1000;

/** `hooks.emit(name, data)` sends to the host; `hooks.onClose()` runs after the view closed. */
export function createDetail(root, hooks) {
  const back = h('button', 'back', 'Back');
  back.type = 'button';
  back.setAttribute('aria-label', 'Back to the agent list');
  const title = h('h2', 'detail-title');
  const pill = h('span', 'pill');
  const sub = h('p', 'detail-sub');
  const role = h('span', 'role-chip');
  const ticket = h('p', 'detail-ticket');
  const titleRow = h('div', 'detail-title-row');
  const head = h('header', 'detail-head');
  const names = h('div', 'detail-names');
  titleRow.append(title, role);
  names.append(titleRow, sub, ticket);
  head.append(back, names, pill);
  const tabs = h('div', 'tabs');
  tabs.setAttribute('role', 'tablist');
  const note = h('p', 'note detail-note');
  note.hidden = true;
  const body = h('div', 'detail-body');
  body.setAttribute('role', 'tabpanel');
  body.tabIndex = 0;
  root.append(head, tabs, note, body);

  const st = { id: null, row: null, pages: 1, openedAt: 0, detail: null, tab: DEFAULT_TAB, key: '', timer: 0, beat: 0, token: 0, follow: true, tabBtns: new Map() };

  const tabList = () => TABS;
  const request = () => hooks.emit(EVENT_AGENT, requestOf(st.id, st.pages));

  function buildTabs() {
    const names2 = tabList();
    if (!names2.includes(st.tab)) st.tab = DEFAULT_TAB;
    tabs.replaceChildren();
    st.tabBtns.clear();
    for (const name of names2) {
      const b = h('button', 'tab', TAB_LABEL[name]);
      b.type = 'button';
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', String(name === st.tab));
      if (name === 'struggles' && st.detail && st.detail.struggles.badge > 0) b.append(h('span', 'badge', String(st.detail.struggles.badge)));
      if (name === 'progress' && st.detail && hasOpenIssue(st.detail.progress)) {
        const dot = h('span', 'alert-dot');
        dot.setAttribute('role', 'img');
        dot.setAttribute('aria-label', `${st.detail.progress.issues.openCount} open issue${st.detail.progress.issues.openCount === 1 ? '' : 's'}`);
        b.append(dot);
      }
      b.addEventListener('click', () => setTab(name));
      tabs.append(b);
      st.tabBtns.set(name, b);
    }
  }

  function setTab(name) {
    st.tab = name;
    st.follow = name === 'transcript';
    for (const [n, b] of st.tabBtns) b.setAttribute('aria-selected', String(n === name));
    draw(true);
    body.scrollTop = name === 'transcript' ? body.scrollHeight : 0;
  }

  function drawBody() {
    const d = st.detail;
    if (d === null) { body.replaceChildren(); return; }
    if (st.tab === 'transcript') renderTranscript(body, d, { more: () => { st.pages += PAGE_STEP; st.keepBottom = body.scrollHeight - body.scrollTop; st.follow = false; request(); } });
    else if (st.tab === 'metrics') renderMetrics(body, d);
    else if (st.tab === 'progress') renderProgress(body, d);
    else renderStruggles(body, d);
  }

  function draw(force) {
    const d = st.detail;
    const key = d === null ? '' : JSON.stringify([{ ...d, updatedAt: 0 }, st.tab]);
    if (!force && key === st.key) return;
    st.key = key;
    const wasAtEnd = body.scrollHeight - body.scrollTop - body.clientHeight <= FOLLOW_SLACK_PX;
    const top = body.scrollTop;
    const fromBottom = st.keepBottom ?? null;
    buildTabs();
    fillProof();
    drawBody();
    if (st.tab === 'transcript' && fromBottom !== null) body.scrollTop = body.scrollHeight - fromBottom;
    else if (st.tab === 'transcript' && (st.follow || wasAtEnd)) body.scrollTop = body.scrollHeight;
    else body.scrollTop = top;
    st.keepBottom = null;
  }

  function status(now) {
    const fill = fillState(st.detail, st.id, now, st.openedAt);
    const words = {
      ok: '',
      loading: 'Loading the transcript and metrics...',
      none: 'No answer from the panel yet. The detail needs the panel mod running; go Back to the list, which still updates.',
      stale: `Not refreshed for ${formatDuration(now - (st.detail?.updatedAt ?? now))}; showing the last answer.`,
    };
    note.textContent = words[fill];
    note.hidden = fill === 'ok';
    note.dataset.fill = fill;
  }

  function fillHead() {
    const a = st.row;
    if (!a) return;
    title.textContent = titleOf(a);
    title.title = titleOf(a);
    pill.textContent = STATE_WORD[a.state] ?? a.state;
    pill.dataset.state = a.state;
    sub.textContent = a.isMain ? 'This session' : plainTitle(a.headline || a.kindLabel || '', false);
    role.textContent = a.role ?? '';
    role.hidden = a.role === null;
    ticket.textContent = a.ticket ? plainTitle(a.ticket.text) : '';
    ticket.title = a.ticket ? titleOf(a) : '';
    ticket.hidden = !a.ticket;
    fillProof();
  }

  // The proof under the title: the row's (a ticket's), else the one the run's own rollout shows (a brief with an Eval line, hooks/agent-detail-external.ts).
  function fillProof() {
    if (st.row) paintProof(sub, { ...st.row, proof: st.row.proof ?? st.detail?.external?.proof ?? null });
  }

  async function poll() {
    const mine = st.token;
    try {
      const res = await fetch(`${DETAIL_URL}?_=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) return;
      const d = normalizeDetail(await res.json());
      if (mine !== st.token || d === null || d.id !== st.id) return;
      st.detail = d;
    } catch { /* not written yet */ }
  }

  async function tick() {
    if (st.id === null) return;
    await poll();
    if (st.id === null) return;
    draw(false);
    status(Date.now());
    if (Date.now() - st.beat >= TIMING.heartbeatMs) { st.beat = Date.now(); request(); }
  }

  function close() {
    if (st.id === null) return;
    clearInterval(st.timer);
    st.id = null;
    st.token++;
    st.detail = null;
    st.key = '';
    root.hidden = true;
    hooks.emit(EVENT_CLOSE, {});
    hooks.onClose();
  }

  back.addEventListener('click', close);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && st.id !== null) { e.preventDefault(); close(); } });
  root.hidden = true;

  return {
    open(row) {
      if (st.id === row.id) return;
      if (st.id !== null) { clearInterval(st.timer); st.token++; }
      Object.assign(st, { id: row.id, row, pages: 1, openedAt: Date.now(), detail: null, key: '', tab: DEFAULT_TAB, follow: false, beat: Date.now() });
      root.hidden = false;
      fillHead();
      buildTabs();
      draw(true);
      status(Date.now());
      request();
      st.timer = setInterval(() => void tick(), TICK_MS);
      void tick();
      back.focus({ preventScroll: true });
    },
    close,
    /** A tab asked for by the host (the terminal pane's buttons); a tab that is not there is ignored. */
    tab(name) { if (st.id !== null && tabList().includes(name)) setTab(name); },
    /** The list row of the open agent changed (state, name). */
    refresh(rows) {
      if (st.id === null) return;
      const r = rows.find((a) => a.id === st.id);
      if (r) { st.row = r; fillHead(); }
    },
    openId: () => st.id,
    /** For tests of the page: the active tab and whether a detail has arrived. */
    state: () => ({ id: st.id, tab: st.tab, hasDetail: st.detail !== null }),
  };
}
