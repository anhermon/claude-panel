// The summary strip and the grouped session rows. Every dynamic text goes through `h` as a text node.
import { h } from './kit/ui/core.js';
import { ago, ageAt, count, duration, entrypointLabel, modelName } from './format.js';
import { titleOf } from './model.js';

const GROUP_LABEL = { running: 'running', idle: 'idle', earlier: 'earlier' };
const EARLIER_PREVIEW = 12;
const WAITING_TEXT = 'may be waiting';
const WAITING_TIP = 'Heuristic: a tool call has had no answer and the transcript has been quiet for a while. It may be running a long command, or waiting for a permission or a question. Not confirmed.';

const stat = (value, caption, tip, isPartial) => h('div.fl-stat', { title: tip ?? null }, h('dd', value), h('dt', isPartial ? `${caption} †` : caption));

/** Marks an element whose text is an age that the page re-renders every second. */
export const agoEl = (at, prefix, tag = 'span') => h(`${tag}.fl-ago`, { 'data-at': at ?? '', 'data-prefix': prefix ?? '' }, `${prefix ?? ''}${at === null ? 'unknown' : ''}`);

/** The segmented bar of the three groups plus the headline numbers. */
export function summary(state) {
  const c = state.counters;
  const total = Math.max(1, c.sessions);
  const seg = (name, n, label) => h('div.fl-sum', { 'data-group': name }, h('b', n), h('span', label));
  return h('div.fl-summary',
    h('div.fl-sums', seg('running', c.running, 'running now'), seg('idle', c.idle, 'idle, process alive'), seg('earlier', c.earlier, `earlier in the last ${Math.round(state.window.ms / 3600000)} h`)),
    h('div.fl-split', { role: 'img', 'aria-label': 'Share of sessions by state' }, ['running', 'idle', 'earlier'].map((g) => h('i', { 'data-group': g, style: { width: `${(c[g] / total) * 100}%` } }))));
}

function currentLine(s) {
  if (s.currentTool !== null) {
    return h('span.fl-cur', s.mayBeWaiting ? h('span.fl-flag', { title: WAITING_TIP }, `${WAITING_TEXT} (heuristic)`) : null, h('span', ` ${s.mayBeWaiting ? 'on' : 'running'} `), h('code', s.currentTool.name), s.currentTool.label ? h('span.fl-label', ` ${s.currentTool.label}`) : null);
  }
  return null;
}

export function row(s, ctx) {
  const lastTurn = s.turns.lastMs === null ? null : duration(s.turns.lastMs);
  const el = h('article.fl-row', {
    'data-group': s.group, 'data-id': s.id, tabindex: 0, role: 'button', 'aria-pressed': ctx.selected === s.id ? 'true' : 'false',
    onclick: () => ctx.select(s.id), onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); ctx.select(s.id); } },
  },
  h('header.fl-row-head',
    h('span.fl-status', { 'data-group': s.group }, h('i'), GROUP_LABEL[s.group] ?? s.group, s.registryStatus ? ` · ${s.registryStatus}` : s.live ? '' : ' · ended'),
    h('h3.fl-title', titleOf(s)),
    h('span.fl-badge', entrypointLabel(s.entrypoint)),
    s.source === 'ps' ? h('span.fl-badge.fl-badge-dim', { title: 'Found with ps; there is no registry file for this process' }, 'ps only') : null,
    s.unverified ? h('span.fl-badge.fl-badge-dim', { title: 'ps failed, so liveness is taken from the registry file alone' }, 'unverified') : null),
  h('p.fl-sub', `${s.project ?? 'unknown folder'}`, h('span', ' · '), modelName(s.model), s.branch ? h('span', ` · ${s.branch}`) : null, s.subagents.total > 0 ? h('span', ` · ${s.subagents.active}/${s.subagents.total} subagents active`) : null),
  s.lastPrompt ? h('p.fl-prompt', h('b', 'Last prompt'), ' ', s.lastPrompt) : h('p.fl-prompt.fl-dim', 'No prompt in the part of the transcript read.'),
  h('p.fl-now', agoEl(s.lastWriteAt, 'last write '), currentLine(s)),
  s.lastError ? h('p.fl-err', h('b', 'Last error'), ' ', s.lastError) : null,
  h('dl.fl-stats',
    stat(s.tools.total, 'tool calls', null, s.transcript.isPartial),
    stat(s.errors, 'tool errors', null, s.transcript.isPartial),
    stat(count(s.tokens.out), 'output tokens', 'Output tokens counted over the part of the transcript read', s.transcript.isPartial),
    stat(lastTurn ?? 'n/a', 'last turn', s.turns.count > 0 ? `${s.turns.count} turns seen, average ${duration(s.turns.avgMs)}` : 'No turn finished in the part read')));
  return el;
}

/** The grouped list; the "earlier" group is cut to a preview until the person asks for all of it. */
export function list(groups, ctx) {
  if (groups.length === 0) return h('p.fl-empty', ctx.hasFilter ? 'No session matches the filter.' : 'No Claude Code session was active in the window.');
  return groups.map((g) => {
    const cut = g.group === 'earlier' && !ctx.showAllEarlier && !ctx.hasFilter && g.sessions.length > EARLIER_PREVIEW;
    const shown = cut ? g.sessions.slice(0, EARLIER_PREVIEW) : g.sessions;
    return h('section.fl-group', { 'data-group': g.group },
      h('header.fl-group-head', h('h2', g.title), h('span.fl-count', `${g.sessions.length} ${g.sessions.length === 1 ? 'session' : 'sessions'}`), h('p', g.caption)),
      h('div.fl-grid', shown.map((s) => row(s, ctx))),
      cut ? h('button.fl-more', { type: 'button', onclick: ctx.expandEarlier }, `Show ${g.sessions.length - EARLIER_PREVIEW} more earlier sessions`) : null);
  });
}

/** Re-renders every age text from the server clock. */
export function tickAges(root, serverNow) {
  for (const el of root.querySelectorAll('.fl-ago')) {
    const at = el.dataset.at === '' ? null : Number(el.dataset.at);
    const text = ago(ageAt(at, serverNow));
    const next = `${el.dataset.prefix}${text}`;
    if (el.textContent !== next) el.textContent = next;
  }
}
