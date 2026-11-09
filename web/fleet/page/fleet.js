// Fleet page: connects to the SSE feed, keeps the filter / sort / selection, and draws the summary, the grouped rows and the
// drill-down panel. State arrives whole (it is small); nothing here ever builds HTML from text.
import { ensureStyle, h, setChildren } from './kit/ui/core.js';
import { ago, ageAt } from './format.js';
import { DEFAULT_SORT, SORTS, filterSessions, groupSessions, sortSessions } from './model.js';
import { list, summary, tickAges } from './rows.js';
import { createDetail } from './detail.js';

const TICK_MS = 1000;
const STALE_MS = 30000;
const DETAIL_PAGE = 30;
const DETAIL_REFRESH_MS = 1500;
const HASH_KEY = '#s=';
const SELECT_KEY = 'fleet.sort';

ensureStyle();
const app = { state: null, receivedAt: 0, skew: 0, query: '', sort: DEFAULT_SORT, selected: null, showAllEarlier: false, limit: DETAIL_PAGE, lastWrite: null, lastFetch: 0, connected: false };
try { app.sort = SORTS[localStorage.getItem(SELECT_KEY)] ? localStorage.getItem(SELECT_KEY) : DEFAULT_SORT; } catch { /* storage may be blocked */ }

const $ = (id) => document.getElementById(id);
const serverNow = () => Date.now() + app.skew;
const ctx = {
  get state() { return app.state; },
  get selected() { return app.selected; },
  get hasFilter() { return app.query.trim() !== ''; },
  get showAllEarlier() { return app.showAllEarlier; },
  select, expandEarlier: () => { app.showAllEarlier = true; render(); },
  close: () => select(null), more: () => { app.limit += DETAIL_PAGE; void loadDetail(true); },
};
const detail = createDetail(ctx);
$('detail-slot').append(detail.el);

function select(id) {
  app.selected = id;
  app.limit = DETAIL_PAGE;
  app.lastWrite = null;
  history.replaceState(null, '', id === null ? location.pathname : `${HASH_KEY}${id}`);
  document.body.dataset.detail = id === null ? 'closed' : 'open';
  if (id === null) detail.hide(); else { detail.show(id); void loadDetail(true); }
  render();
}

async function loadDetail(force) {
  const id = app.selected;
  const s = app.state?.sessions.find((x) => x.id === id);
  if (id === null) return;
  if (s === undefined) { detail.error('This session is no longer in the fleet window.'); return; }
  if (!force && s.lastWriteAt === app.lastWrite) return;
  if (Date.now() - app.lastFetch < DETAIL_REFRESH_MS && !force) return;
  app.lastFetch = Date.now(); app.lastWrite = s.lastWriteAt;
  try {
    const res = await fetch(`session/${id}?limit=${app.limit}`);
    if (!res.ok) { detail.error(`Could not read this transcript (${res.status}).`); return; }
    const data = await res.json();
    if (app.selected === id) detail.render(data, serverNow());
    tickAges(document, serverNow());
  } catch (err) { detail.error(`Could not load the detail: ${err.message}`); }
}

function renderHealth() {
  const st = app.state;
  const el = $('health');
  if (st === null) { setChildren(el, 'connecting…'); el.dataset.tone = 'wait'; return; }
  const feedAge = ageAt(st.generatedAt, serverNow());
  const stale = !app.connected || feedAge > STALE_MS;
  el.dataset.tone = stale ? 'bad' : 'ok';
  const c = st.counters;
  setChildren(el, h('b', stale ? (app.connected ? 'feed stalled' : 'disconnected') : 'live'), ` · updated ${ago(feedAge)}`);
  el.title = `${c.transcriptsIndexed} transcripts indexed, ${c.registryEntries} registry files (${c.registryStale} stale), ${c.processesSeen} processes scanned, ps ${c.psOk ? 'ok' : 'FAILED'}`;
  $('diag').textContent = `Rows read: ${c.rowsParsed} parsed, ${c.rowsUnparsed} not JSON, ${c.rowsSkipped} skipped on purpose, ${c.unknownRowTypes} of an unknown type. ${st.hub?.online ? `Hub online (session ${String(st.hub.sessionId).slice(0, 8)}).` : 'No hub online: sending is off.'} † Counts cover only the part of a transcript the feed has read (its last 512 KB at first sight, then what was appended).`;
}

function render() {
  const st = app.state;
  renderHealth();
  if (st === null) return;
  const visible = sortSessions(filterSessions(st.sessions, app.query), app.sort);
  setChildren($('summary'), summary(st));
  setChildren($('list'), list(groupSessions(visible), ctx));
  tickAges(document, serverNow());
  detail.refreshCompose();
  if (app.selected !== null) void loadDetail(false);
}

function connect() {
  const es = new EventSource('events');
  es.onopen = () => { app.connected = true; renderHealth(); };
  es.onerror = () => { app.connected = false; renderHealth(); };
  es.onmessage = (ev) => {
    try { app.state = JSON.parse(ev.data); } catch { return; }
    app.receivedAt = Date.now(); app.skew = app.state.generatedAt - app.receivedAt; app.connected = true;
    render();
  };
}

const search = $('q');
search.addEventListener('input', () => { app.query = search.value; render(); });
const sortSel = $('sort');
setChildren(sortSel, Object.entries(SORTS).map(([k, v]) => h('option', { value: k, selected: k === app.sort }, v.label)));
sortSel.addEventListener('change', () => { app.sort = sortSel.value; try { localStorage.setItem(SELECT_KEY, app.sort); } catch { /* ignore */ } render(); });
addEventListener('keydown', (e) => { if (e.key === 'Escape' && app.selected !== null) select(null); });
setInterval(() => { tickAges(document, serverNow()); renderHealth(); }, TICK_MS);

connect();
const hashId = location.hash.startsWith(HASH_KEY) ? location.hash.slice(HASH_KEY.length) : '';
if (/^[0-9a-f-]{36}$/.test(hashId)) select(hashId);
