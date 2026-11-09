// The drill-down panel of one session: now, tokens over time, tool mix, kind of work, turn timing, the recent transcript and
// the send-message box. The compose box is built once per opened session and never re-rendered, so a refresh of the data
// cannot eat what the person is typing. Dynamic text is only ever a text node (kit `h`).
import { h } from './kit/ui/core.js';
import { KIND_META } from './kind-meta.js';
import { ago, ageAt, bytes, count, duration, entrypointLabel, modelName } from './format.js';
import { titleOf } from './model.js';
import { kindBar, toolMix, tokensChart } from './charts.js';
import { agoEl } from './rows.js';

const RESULT_POLL_MS = 1000;
const DEFAULT_RESULT_WAIT_MS = 60000;
const DEFAULT_MESSAGE_MAX = 2000;
const clock = (t) => (t === null || t === undefined ? '' : new Date(t).toLocaleTimeString([], { hourCycle: 'h23', hour: '2-digit', minute: '2-digit', second: '2-digit' }));
const RESULT_TEXT = {
  pending: 'Waiting for a hub to pick this up…',
  queued: 'Queued: the session’s inbox has it and will read it on its next turn.',
  refused: 'Refused by the hub',
  failed: 'The hub could not send it',
};

const section = (title, caption, ...body) => h('section.fl-sec', h('h4', title), caption ? h('p.fl-cap', caption) : null, ...body);
const kv = (k, v) => [h('dt', k), h('dd', v)];

function eventEl(e) {
  const when = h('time', clock(e.ts));
  if (e.t === 'turn') return h('li.fl-ev.fl-ev-turn', when, h('span', `turn ended after ${duration(e.ms)}`));
  if (e.t === 'user') return h('li.fl-ev.fl-ev-user', when, h('b', 'You'), h('pre', e.text));
  if (e.t === 'say') return h('li.fl-ev.fl-ev-say', when, h('b', 'Assistant'), h('pre', e.text));
  if (e.t === 'error') return h('li.fl-ev.fl-ev-error', when, h('b', 'Error'), h('pre', e.text));
  const meta = KIND_META[e.kind] ?? null;
  return h('li.fl-ev.fl-ev-tool', { 'data-state': e.error ? 'error' : e.done ? 'done' : 'open' }, when,
    h('b', h('span.fl-key', { style: { '--k': meta?.color ?? 'var(--ui-mut)' } }, e.name)),
    h('code', e.command ?? e.label ?? ''),
    h('span.fl-ev-state', e.error ? 'failed' : e.done ? (e.ms === null ? 'done' : `done in ${duration(e.ms)}`) : 'no result yet'),
    e.error ? h('pre.fl-ev-err', e.error) : null);
}

function compose(session, ctx) {
  const max = ctx.state.limits?.messageMaxChars ?? DEFAULT_MESSAGE_MAX;
  const waitMs = ctx.state.limits?.resultWaitMs ?? DEFAULT_RESULT_WAIT_MS;
  const out = h('p.fl-result', { role: 'status', 'aria-live': 'polite' });
  const counter = h('span.fl-counter', `0 / ${max} characters`);
  const ta = h('textarea', { rows: 3, maxlength: max, 'aria-label': 'Message to send to this session', placeholder: 'Message to this session' });
  const btn = h('button.fl-send', { type: 'button' }, 'Send message');
  const note = h('p.fl-cap');
  const say = (text, tone) => { out.textContent = text; out.dataset.tone = tone ?? ''; };
  const refresh = () => {
    counter.textContent = `${ta.value.length} / ${max} characters`;
    const hub = ctx.state.hub;
    const can = session.live && hub?.online === true;
    ta.disabled = !session.live;
    btn.disabled = !can || ta.value.trim() === '' || ta.dataset.busy === '1';
    note.textContent = !session.live ? 'Only a running session can receive a message.'
      : hub?.online !== true ? 'No hub is online, so nothing can be delivered. A hub is any Claude Code session with the panel mod loaded.'
        : `Sent as a message from the fleet panel, through the hub (session ${String(hub.sessionId).slice(0, 8)}). It is queued; the session reads it on its next turn. Only this text is sent.`;
  };
  async function poll(id, startedAt) {
    for (;;) {
      await new Promise((r) => setTimeout(r, RESULT_POLL_MS));
      let r;
      try { r = await (await fetch(`result/${id}`)).json(); } catch { r = { status: 'pending' }; }
      if (r.status !== 'pending') return r;
      if (Date.now() - startedAt > waitMs) return { status: 'failed', reason: `no hub picked it up within ${Math.round(waitMs / 1000)} s` };
    }
  }
  btn.addEventListener('click', async () => {
    const text = ta.value;
    ta.dataset.busy = '1'; refresh(); say(RESULT_TEXT.pending, 'wait');
    try {
      const res = await fetch('send', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: session.id, text }) });
      const body = await res.json();
      if (!res.ok) { say(`Not sent: ${body.reason ?? res.status}`, 'bad'); return; }
      const r = await poll(body.id, Date.now());
      const good = r.status === 'queued';
      say(`${RESULT_TEXT[r.status] ?? r.status}${r.reason ? `: ${r.reason}` : ''}`, good ? 'ok' : 'bad');
      if (good) ta.value = '';
    } catch (err) { say(`Not sent: ${err.message}`, 'bad'); } finally { ta.dataset.busy = '0'; refresh(); }
  });
  ta.addEventListener('input', refresh);
  refresh();
  return { el: section('Send a message', null, ta, h('div.fl-compose-row', counter, btn), note, out), refresh };
}

/** The panel. `ctx`: { state (live getter), close(), more(), cap }. */
export function createDetail(ctx) {
  const body = h('div.fl-detail-body');
  const root = h('aside.fl-detail', { hidden: true, 'aria-label': 'Session detail' }, body);
  let composeRef = null;
  let shownId = null;

  function render(data, serverNow) {
    const s = data.session;
    if (shownId !== s.id) { composeRef = compose(s, ctx); shownId = s.id; }
    composeRef.refresh();
    const m = data.metrics;
    const u = s.tokens;
    body.replaceChildren(
      h('header.fl-detail-head',
        h('button.fl-back', { type: 'button', onclick: ctx.close }, '← All sessions'),
        h('h3', titleOf(s)),
        h('p.fl-sub', `${s.project ?? 'unknown folder'} · ${modelName(s.model)} · ${entrypointLabel(s.entrypoint)}${s.version ? ` ${s.version}` : ''}`)),
      section('Now', null, h('dl.fl-kv',
        kv('State', `${s.group}${s.registryStatus ? ` (${s.registryStatus})` : s.live ? '' : ' (ended)'}`),
        kv('Last write', agoEl(s.lastWriteAt, '')),
        kv('Current tool', s.currentTool ? `${s.currentTool.name} ${s.currentTool.label}${s.mayBeWaiting ? '  [may be waiting: heuristic]' : ''}` : 'none'),
        kv('Folder', s.cwd ?? 'unknown'), kv('Process', s.pid === null ? 'none found' : `pid ${s.pid}`), kv('Session id', h('code', s.id)),
        kv('Transcript', `${bytes(s.transcript.bytes)} on disk, ${bytes(s.transcript.readBytes)} read, ${s.transcript.unparsedRows} unparsed rows`))),
      section('Tokens over time', 'Output and new input tokens per time bucket, from the part of the transcript read.',
        tokensChart(m?.tokens, m?.bucketMs),
        h('p.fl-cap', `Totals read: ${count(u.out)} output, ${count(u.in)} new input, ${count(u.cacheRead)} read from cache (tokens).`)),
      section('Tool mix', 'Tool calls by tool name.', toolMix(s.tools.byName), h('p.fl-cap', `${s.tools.total} calls, ${s.errors} errors.`)),
      section('Kind of work', 'Share of tool calls by kind (same classes as the board).', kindBar(s.tools.byKind)),
      section('Turns', null, h('dl.fl-kv', kv('Turns seen', String(s.turns.count)), kv('Last turn', duration(s.turns.lastMs)), kv('Average turn', duration(s.turns.avgMs)), kv('Longest turn', duration(s.turns.maxMs)))),
      section('Recent transcript', `Newest first. ${data.total} events${data.isPartial ? ' in the last part of the file' : ''}; passwords, keys and tokens are masked; thinking and successful tool output are not shown.`,
        h('ol.fl-events', data.events.map(eventEl)),
        data.next === null ? null : h('button.fl-more', { type: 'button', onclick: ctx.more }, 'Show older events')),
      composeRef.el);
  }

  return {
    el: root,
    show(id) { if (id !== shownId) { composeRef = null; shownId = null; body.replaceChildren(h('p.fl-empty', 'Loading…')); } root.hidden = false; },
    hide() { root.hidden = true; shownId = null; composeRef = null; },
    render,
    refreshCompose() { composeRef?.refresh(); },
    error(text) { if (shownId === null) body.replaceChildren(h('header.fl-detail-head', h('button.fl-back', { type: 'button', onclick: ctx.close }, '← All sessions')), h('p.fl-empty', text)); },
  };
}
