"use strict";
/* Panel front end: state + SSE + layout. Block rendering lives in blocks.js (PanelBlocks), card scene frames in
 * scenes.js (PanelScenes), stage frames in stage.js (PanelStage), the rail/drawer/ask answers in rail.js (PanelRail),
 * the return channel in events-client.js (PanelEvents). All URLs are relative: the page is served at /<token>/.
 * Order top to bottom: header, ask, notes, pinned cards, scenes (pinned first), core columns, unpinned cards.
 * Stage mode (any scene with layout "stage"): the same sections move into the right-hand drawer, the stage fills the page.
 * Without stage.js and rail.js the page degrades to the plain v3 page (stage scenes then show as card scenes). */
(function () {
  const { plainTitle } = globalThis.PanelTitles;
  const { renderBlock, el, str, kids } = globalThis.PanelBlocks;
  const { sync: syncSceneFrames, normScenes } = globalThis.PanelScenes;
  const Stage = globalThis.PanelStage;
  const Rail = globalThis.PanelRail;
  const Layout = globalThis.PanelWorkspaceLayout;
  const STAGE_READY = !!(Stage && Rail && Layout);

  const EVENTS_PATH = "events";
  const TICK_MS = 1000;
  const FLASH_MS = 600;
  const DEFAULT_STATUS = "working";
  const STATUS_LABELS = { working: "Working", waiting: "Waiting", blocked: "Blocked", done: "Done" };
  const CARD_TONES = ["info", "warn", "ok", "danger"];
  const SPANS = [1, 2, 3];
  const DEFAULT_SPAN = 3;
  const MAX_CHOICES = 6;
  const STAGE_LAYOUT = "stage";
  /* The tiles of the workspace: stage scenes, pinned ones and the board (layout.js). */
  const isTile = (s) => (Layout ? Layout.isTile(s) : s.layout === STAGE_LAYOUT);
  const TITLE_PREFIX = "Panel";
  const TITLE_SEP = " — ";
  const JUST_NOW_S = 5;
  const SECS = { m: 60, h: 3600, d: 86400 };
  const COLUMNS = [
    { key: "context", heading: "Context" },
    { key: "done", heading: "Done" },
    { key: "next", heading: "Next" },
  ];

  const $ = (id) => document.getElementById(id);
  const els = {
    status: $("status"), dot: $("dot"), statusLabel: $("status-label"), conn: $("conn"), updated: $("updated"),
    shell: $("shell"), main: $("main"), content: $("content"), rail: $("rail"), stage: $("stage"), drawer: $("drawer"),
    drawerBody: $("drawer-body"), notes: $("notes"),
    head: $("head"), ask: $("ask"), pinned: $("pinned"), scenes: $("scenes"), cols: $("cols"), cards: $("cards"), waiting: $("waiting"),
  };
  for (const c of COLUMNS) els["col-" + c.key] = $("col-" + c.key);

  let updatedAt = 0;
  let rendered = false;

  /* ---- Normalisation: never trust the shape of the state ---- */
  const strs = (x) => (Array.isArray(x) ? x.map(str).filter(Boolean) : []);
  const isObj = (x) => x !== null && typeof x === "object" && !Array.isArray(x);

  function normCards(raw) {
    const seen = new Set();
    const out = [];
    for (const c of Array.isArray(raw) ? raw : []) {
      if (!isObj(c)) continue;
      const id = str(c.id);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push({
        id,
        title: plainTitle(str(c.title), false),
        span: SPANS.includes(c.span) ? c.span : DEFAULT_SPAN,
        pin: c.pin === true,
        tone: CARD_TONES.includes(c.tone) ? c.tone : "",
        blocks: Array.isArray(c.blocks) ? c.blocks : [],
      });
    }
    return out;
  }
  function normChoices(raw) {
    const out = [];
    for (const c of Array.isArray(raw) ? raw : []) {
      if (isObj(c) && str(c.id) && str(c.label) && out.length < MAX_CHOICES) out.push({ id: str(c.id), label: plainTitle(str(c.label), false) });
    }
    return out;
  }
  function normalize(raw) {
    const s = isObj(raw) ? raw : {};
    const task = isObj(s.task) ? s.task : {};
    const labels = isObj(s.labels) ? s.labels : {};
    return {
      status: Object.prototype.hasOwnProperty.call(STATUS_LABELS, s.status) ? s.status : DEFAULT_STATUS,
      updatedAt: Number(s.updatedAt) || 0,
      title: plainTitle(str(task.title), false), why: str(task.why), ask: str(s.ask), choices: normChoices(s.choices),
      labels: { context: str(labels.context), done: str(labels.done), next: str(labels.next) },
      context: strs(s.context), done: strs(s.done), next: strs(s.next),
      cards: normCards(s.cards),
      scenes: Array.isArray(s.scenes) ? s.scenes : [], // PanelScenes validates each one
    };
  }

  /* ---- Section builders ---- */
  function buildHead(slot, d) {
    if (d.title) slot.appendChild(el("h1", "", d.title));
    if (d.why) {
      const w = el("div", "why");
      w.appendChild(el("span", "label", "Why this way"));
      w.appendChild(el("p", "", d.why));
      slot.appendChild(w);
    }
  }
  function buildAsk(slot, d) {
    slot.appendChild(el("div", "label", "Claude needs you"));
    slot.appendChild(el("p", "", d.ask));
    if (STAGE_READY) {
      const choices = Rail.choiceGroup(d.choices, "ask");
      if (choices) slot.appendChild(choices);
    }
  }
  function buildNotes(slot, text) {
    slot.appendChild(el("h2", "", "Speaker notes"));
    slot.appendChild(el("p", "notes-text", text));
  }
  function buildColumn(key) {
    return (slot, d) => {
      slot.appendChild(el("h2", "", d.heading));
      const list = el(key === "next" ? "ol" : "ul");
      for (const t of d.items) list.appendChild(el("li", "", t));
      if (key === "next") {
        list.firstChild.classList.add("first");
        list.firstChild.insertBefore(el("span", "tag", "up next"), list.firstChild.firstChild);
      } else if (key === "done") {
        list.lastChild.classList.add("newest"); // newest = last item
      }
      slot.appendChild(list);
    };
  }
  /* A card with nothing renderable inside is dropped, not shown as an empty box. */
  function buildCard(c) {
    const blocks = c.blocks.map(renderBlock).filter(Boolean);
    if (!blocks.length) return null;
    const card = el("article", "card span-" + c.span + (c.tone ? " tone-" + c.tone : ""));
    card.dataset.cardId = c.id;
    if (c.title) card.appendChild(el("h2", "card-title", c.title));
    return kids(card, blocks);
  }

  /* ---- Rendering: replace only what changed, flash only that ---- */
  function flash(node) {
    node.classList.remove("flash");
    void node.offsetWidth; // restart the animation
    node.classList.add("flash");
    setTimeout(() => node.classList.remove("flash"), FLASH_MS);
  }
  function put(slot, data, isEmpty, build) {
    const sig = JSON.stringify(data);
    if (slot._sig === sig) return;
    slot._sig = sig;
    slot.replaceChildren();
    slot.hidden = isEmpty;
    if (isEmpty) return;
    build(slot, data);
    if (rendered) flash(slot);
  }

  const cardCache = new Map(); // id -> { sig, node }
  function sameChildren(slot, nodes) {
    return slot.children.length === nodes.length && nodes.every((n, i) => slot.children[i] === n);
  }
  /* Keyed by card id: untouched cards keep their node (and scroll position); changed ones are rebuilt and flash. */
  function syncCards(cards) {
    const pinned = [];
    const rest = [];
    const live = new Set();
    for (const c of cards) {
      const sig = JSON.stringify(c);
      let ent = cardCache.get(c.id);
      if (!ent || ent.sig !== sig) {
        let node = null;
        try { node = buildCard(c); } catch (e) { console.error("panel: skipped card " + c.id, e); }
        ent = { sig, node };
        cardCache.set(c.id, ent);
        if (node && rendered) flash(node);
      }
      if (!ent.node) continue;
      live.add(c.id);
      (c.pin ? pinned : rest).push(ent.node);
    }
    for (const id of [...cardCache.keys()]) if (!live.has(id)) cardCache.delete(id);
    for (const [slot, nodes] of [[els.pinned, pinned], [els.cards, rest]]) {
      if (!sameChildren(slot, nodes)) slot.replaceChildren(...nodes);
      slot.hidden = nodes.length === 0;
    }
    return pinned.length + rest.length;
  }

  function render(raw) {
    const d = normalize(raw);
    updatedAt = d.updatedAt;
    document.title = d.title ? TITLE_PREFIX + TITLE_SEP + d.title : TITLE_PREFIX;

    els.dot.className = "dot " + d.status;
    els.statusLabel.textContent = STATUS_LABELS[d.status];

    put(els.head, { title: d.title, why: d.why }, !d.title && !d.why, buildHead);
    put(els.ask, { ask: d.ask, choices: d.choices }, !d.ask, buildAsk);
    const cardCount = syncCards(d.cards);
    const scenes = normScenes(d.scenes);
    const stageScenes = STAGE_READY ? scenes.filter(isTile) : [];
    let sceneCount = 0;
    try {
      sceneCount = syncSceneFrames(els.scenes, scenes.filter((s) => !stageScenes.includes(s) && !(STAGE_READY && s.builtin))); // a built-in that is not a tile (the retired pulse) is shown nowhere
      if (STAGE_READY) Stage.sync(els.stage, stageScenes); // [] disposes the frames of a stage that went away
    } catch (e) { console.error("panel: scenes failed", e); }
    setStageMode(stageScenes.length > 0);
    let visible = 0;
    for (const c of COLUMNS) {
      const items = d[c.key];
      if (items.length) visible++;
      const heading = d.labels[c.key] || c.heading;
      put(els["col-" + c.key], { heading, items }, !items.length, buildColumn(c.key));
    }
    els.cols.hidden = visible === 0;
    els.cols.style.setProperty("--n", String(Math.max(visible, 1)));

    const empty = !d.title && !d.why && !d.ask && visible === 0 && cardCount === 0 && sceneCount === 0 && stageScenes.length === 0;
    els.status.hidden = empty;
    els.waiting.hidden = !empty;
    rendered = true;
    last = d;
    refreshStage();
    tick();
  }

  /* ---- Stage mode: rail + stage + drawer instead of the single column ---- */
  let last = null;
  let stageOn = false;
  /* The sections live in #content: in #main on the plain page, in the drawer in stage mode. */
  function setStageMode(on) {
    stageOn = on;
    document.body.classList.toggle("stage-mode", on);
    const home = on ? els.drawerBody : els.main;
    if (els.content.parentNode !== home) home.appendChild(els.content); // moving an iframe reloads it: only move on a mode change
    els.main.hidden = on;
    els.rail.hidden = !on;
    els.stage.hidden = !on;
    els.drawer.hidden = !on;
  }
  /* Rail, progress and speaker notes from the last state plus whatever the active stage frame reported. */
  function refreshStage() {
    if (!STAGE_READY || !last) return;
    const v = Stage.view();
    Rail.update({
      on: stageOn, hasCustom: v.hasCustom, status: last.status, statusLabel: STATUS_LABELS[last.status], title: last.title,
      ask: last.ask, choices: last.choices, selectedId: v.selectedId, progress: v.progress, openHref: v.openHref,
    });
    put(els.notes, v.notes, !stageOn || !v.notes, buildNotes);
  }

  /* ---- "updated Ns ago", live ---- */
  function ago(seconds) {
    if (seconds < JUST_NOW_S) return "just now";
    if (seconds < SECS.m) return seconds + "s ago";
    if (seconds < SECS.h) return Math.floor(seconds / SECS.m) + "m ago";
    if (seconds < SECS.d) return Math.floor(seconds / SECS.h) + "h ago";
    return Math.floor(seconds / SECS.d) + "d ago";
  }
  function tick() {
    els.updated.textContent = updatedAt ? "updated " + ago(Math.max(0, Math.floor((Date.now() - updatedAt) / 1000))) : "";
  }
  setInterval(tick, TICK_MS);

  /* ---- Live connection ---- */
  function connect() {
    const es = new EventSource(EVENTS_PATH);
    const online = (yes) => { els.conn.hidden = yes; if (STAGE_READY) Rail.setOffline(!yes); };
    es.onopen = () => online(true);
    es.onmessage = (ev) => {
      online(true);
      try { render(JSON.parse(ev.data)); } catch (e) { console.error("panel: bad state", e); }
    };
    es.onerror = () => online(false); // EventSource retries by itself; last state stays on screen
  }

  if (STAGE_READY) {
    Stage.init({ onChange: refreshStage, canFocus: () => !Rail.isDrawerOpen() });
    Rail.init();
  }

  globalThis.PanelUI = { render };
  if (typeof EventSource === "function") connect();
})();
