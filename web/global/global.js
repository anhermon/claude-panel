// Global view page. READ-ONLY: it polls ./state.json and draws it. Everything shown comes from other sessions and is untrusted,
// so the DOM is built from text nodes only (`textContent`, never parsed as markup) and a link is set only when it is an absolute
// http(s) URL (re-checked here), always with target=_blank rel="noopener noreferrer".
(() => {
  const POLL_MS = 4000;
  const JIRA_SESSIONS_MAX = 6;
  const ENDED_NEEDS_MAX = 10;
  const endedOpen = { value: false }; // the 'ended sessions' group stays open or closed across redraws
  const open = new Set(); // session ids whose card is expanded: kept across redraws
  const $ = (id) => document.getElementById(id);

  const safeUrl = (u) => {
    if (typeof u !== 'string' || !/^https?:\/\/[^/\s]/i.test(u)) return '';
    try { const p = new URL(u); return p.protocol === 'https:' || p.protocol === 'http:' ? p.href : ''; } catch { return ''; }
  };

  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'text') el.textContent = String(v);
      else if (k === 'class') el.className = v;
      else if (k.startsWith('data-') || k === 'role' || k.startsWith('aria-')) el.setAttribute(k, String(v)); // never style, href or on*
    }
    for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid);
    return el;
  }

  function link(url, text) {
    const href = safeUrl(url);
    if (href === '') return h('span', { text });
    const a = h('a', { text });
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    return a;
  }

  const STATE_LABEL = { busy: 'busy', waiting: 'may be waiting', idle: 'idle', ended: 'ended' };
  const NEED_KIND = { board: 'from the board', 'board-ask': 'board question', ask: 'question', waiting: 'tool call', question: 'question', error: 'error', stall: 'stall' };

  function ago(ms, now) {
    const min = Math.floor(Math.max(0, now - ms) / 60000);
    if (min < 1) return 'just now';
    if (min < 60) return `${min} min ago`;
    const hours = Math.floor(min / 60);
    return hours < 24 ? `${hours} h ago` : `${Math.floor(hours / 24)} d ago`;
  }

  function needItem(n) {
    return h('li', { class: `need${n.may ? ' is-may' : ''}${n.sessionState === 'ended' ? ' is-ended' : ''}` },
      h('b', { text: (n.may ? 'May: ' : '') + n.title }),
      n.why ? h('p', { class: 'why', text: n.why }) : null,
      h('p', { class: 'meta' },
        h('span', { text: n.sessionTitle }),
        h('span', { text: `${STATE_LABEL[n.sessionState] || n.sessionState} · ${NEED_KIND[n.kind] || n.kind}` }),
        n.link ? link(n.link, 'open source') : null));
  }

  function jiraItem(g) {
    const rows = []; // one row per distinct title: a session listed once, near-identical titles counted
    for (const s of g.sessions) {
      const row = rows.find((r) => r.title === s.title);
      if (row === undefined) rows.push({ title: s.title, state: s.state, n: 1 });
      else { row.n += 1; if (row.state === 'ended' && s.state !== 'ended') row.state = s.state; }
    }
    return h('div', { class: 'ticket' },
      h('div', {}, g.url ? link(g.url, g.key) : h('span', { class: 'key', text: g.key }), g.internal ? h('span', { class: 'muted', text: '  internal' }) : null,
        h('span', { class: 'muted', text: `  ${g.sessions.length} ${g.sessions.length === 1 ? 'session' : 'sessions'}` })),
      h('ul', {}, rows.slice(0, JIRA_SESSIONS_MAX).map((r) => h('li', { text: `${r.title}${r.n > 1 ? ` x${r.n}` : ''} (${STATE_LABEL[r.state] || r.state})` })),
        rows.length > JIRA_SESSIONS_MAX ? h('li', { class: 'muted', text: `and ${rows.length - JIRA_SESSIONS_MAX} more` }) : null));
  }

  function items(list) {
    return h('ul', {}, list.map((i) => h('li', { 'data-state': i.state, text: i.t })));
  }

  function card(s, state, now) {
    const needs = new Set(s.needs);
    const needCount = state.needsYou.filter((n) => needs.has(n.id)).length;
    const pct = s.progress && s.progress.total > 0 ? Math.round((100 * s.progress.done) / s.progress.total) : null;
    const bar = h('div', { class: 'bar', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': pct === null ? 0 : pct }, h('span'));
    if (pct !== null) bar.firstChild.style.width = `${pct}%`;
    const el = h('details', { class: 'card', 'data-state': s.state, 'data-id': s.id });
    el.open = open.has(s.id);
    el.addEventListener('toggle', () => { if (el.open) open.add(s.id); else open.delete(s.id); });
    el.append(
      h('summary', {},
        h('div', { class: 'row' }, h('span', { class: 'title', text: s.title }), needCount > 0 ? h('span', { class: 'chip is-need', text: `needs you ${needCount}` }) : null, h('span', { class: 'pill', 'data-state': s.state, text: STATE_LABEL[s.state] || s.state })),
        h('div', { class: 'row muted' }, h('span', { class: 'mono', text: s.project }), s.branch ? h('span', { class: 'chip mono', text: s.branch }) : null, h('span', { text: ago(s.lastActive, now) }),
          s.tickets.map((k) => h('span', { class: 'chip mono', text: k.key }))),
        s.task.title ? h('div', { class: 'task', text: s.task.title }) : null,
        s.doing ? h('div', { class: 'muted', text: s.doing }) : null,
        pct !== null ? bar : null,
        s.progress ? h('div', { class: 'muted', text: `${s.progress.done}/${s.progress.total} steps` }) : null,
        s.agents.length > 0 ? h('div', { class: 'muted', text: `${s.agents.filter((a) => a.state === 'running').length} running of ${s.agents.length} subagents` }) : null),
      h('div', { class: 'detail' },
        s.prompt ? h('div', {}, h('h3', { text: 'Last prompt' }), h('p', { text: s.prompt })) : null,
        s.task.why ? h('div', {}, h('h3', { text: 'Why' }), h('p', { text: s.task.why })) : null,
        s.doing ? h('div', {}, h('h3', { text: 'Doing' }), h('p', { text: s.doing })) : null,
        s.progress ? h('div', {}, h('h3', { text: s.progress.source === 'board' ? 'Steps (board)' : 'Todos' }), items(s.progress.items)) : null,
        s.agents.length > 0 ? h('div', {}, h('h3', { text: 'Subagents' }), h('ul', {}, s.agents.map((a) => h('li', {
          'data-state': a.state === 'done' ? 'done' : a.state === 'running' ? 'doing' : '',
          text: `${a.type ? `${a.type}: ` : ''}${a.desc || a.id} · ${a.state}${a.doing ? ` · ${a.doing}` : ''}${a.progress ? ` · ${a.progress.done}/${a.progress.total}` : ''}`,
        })))) : null,
        s.links.length > 0 ? h('div', {}, h('h3', { text: 'Links' }), h('ul', {}, s.links.map((l) => h('li', {}, link(l.url, l.label))))) : null));
    return el;
  }

  function render(state) {
    const now = Date.now();
    const t = state.totals;
    $('sub').textContent = `${t.sessions} sessions in the last ${state.windowHours} h: ${t.waiting} may be waiting, ${t.busy} busy, ${t.idle} idle, ${t.ended} ended`
      + (t.shown < t.sessions ? `. Showing the top ${t.shown}.` : '') + ` Updated ${new Date(state.generatedAt).toLocaleTimeString()}.`;
    const liveNeeds = state.needsYou.filter((n) => n.sessionState !== 'ended');
    const endedNeeds = state.needsYou.filter((n) => n.sessionState === 'ended');
    let ended = null;
    if (endedNeeds.length > 0) {
      ended = h('details', { class: 'ended-needs' }, h('summary', { text: `From ended sessions (${endedNeeds.length})` }),
        h('ol', { class: 'needs' }, endedNeeds.slice(0, ENDED_NEEDS_MAX).map(needItem)),
        endedNeeds.length > ENDED_NEEDS_MAX ? h('p', { class: 'muted', text: `and ${endedNeeds.length - ENDED_NEEDS_MAX} more` }) : null);
      ended.open = endedOpen.value;
      ended.addEventListener('toggle', () => { endedOpen.value = ended.open; });
    }
    $('needs-body').replaceChildren(...[
      liveNeeds.length === 0 && ended === null ? h('p', { class: 'empty', text: 'Nothing needs you right now.' }) : null,
      liveNeeds.length > 0 ? h('ol', { class: 'needs' }, liveNeeds.map(needItem)) : null,
      ended].filter((n) => n !== null));
    $('jira-body').replaceChildren(state.jira.length === 0 ? h('p', { class: 'empty', text: 'No ticket keys found in the sessions.' }) : h('div', { class: 'jira' }, state.jira.map(jiraItem)));
    $('sessions-body').replaceChildren(...state.sessions.map((s) => card(s, state, now)));
  }

  async function poll() {
    try {
      const res = await fetch('state.json', { cache: 'no-store' });
      if (!res.ok) throw new Error(String(res.status));
      render(await res.json());
    } catch (err) {
      $('sub').textContent = `Cannot reach the panel server (${err.message}). Retrying.`;
    }
  }

  poll();
  setInterval(poll, POLL_MS);
})();
