"use strict";
/* Panel stage: the WORKSPACE. Every tile scene (stage scenes, pinned ones and the board; see
 * builtin/workspace/layout.js) is one tile of a grid that fills the viewport under the rail; the grid is chosen from the
 * viewport shape and the tile count. One iframe per scene, all kept alive (audio and animation survive a re-layout). A tile's
 * title strip opens that scene alone (solo, "#stage=<id>"); Esc or the strip goes back to all of them.
 *
 * Same security contract as scenes.js: `sandbox="allow-scripts"` only (the shared createBody builds the iframe), never
 * allow-same-origin or srcdoc. From a stage frame the page accepts only {type:"panel-deck"} (this file) and
 * {type:"panel-emit"} (events-client.js), and only when event.source is that frame's own window. {type:"panel-fit"} is
 * ignored: a stage never auto-sizes.
 *
 * Liveness contract: a frame navigates ONLY when its scene's rev or mtime changes (or the user presses reload), and then
 * the URL carries the last position the deck reported (#/h/v/f), so a deck reloads on the slide it was showing. */
(function () {
  const { el, kids, isTextEntry, within } = globalThis.PanelBlocks;
  const Scenes = globalThis.PanelScenes;
  const Layout = globalThis.PanelWorkspaceLayout;

  const STAGE_HASH_PREFIX = "#stage=";
  const STAGE_HASH_RE = /^#stage=([a-z0-9-]{1,24})$/;
  const DECK_TYPE = "panel-deck";
  const HOST_TYPE = "panel-host";
  const ANY_ORIGIN = "*"; // the sandboxed frame has an opaque origin: no other target origin can match it
  const MAX_INDEX = 9999;
  const MAX_NOTES_CHARS = 4000;
  const FORWARD_KEYS = ["ArrowLeft", "ArrowRight", "PageUp", "PageDown", "Home", "End", " ", "o"];
  const ESCAPE = "Escape";
  const FALLBACK_SIZE = { width: 1280, height: 720 }; // a stage that cannot be measured (no layout engine)
  const SOLO_PREFIX = "\u2190 "; // "<- Title": the strip of the scene shown alone
  const MORE_TEXT = (n) => "+" + n + " more";

  const isObj = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
  const noop = () => {};

  const frames = new Map(); // id -> frame (see createFrame); one per tile scene
  let container = null;
  let moreEl = null;
  let order = []; // their ids, first tile first
  let hasCustom = false; // a tile scene of the model's own exists
  let soloId = ""; // the scene shown alone, or "" for the workspace
  let deckId = ""; // the scene that reported a deck last: it owns the arrow keys, the progress and the notes
  let hooks = { onChange: noop, canFocus: () => true };

  /* ---- deck reports ---- */
  const index = (x) => (Number.isInteger(x) && x >= -1 && x <= MAX_INDEX ? Math.max(0, x) : null);
  function normDeck(d) {
    const h = index(d.h);
    const v = d.v === undefined ? 0 : index(d.v);
    const f = d.f === undefined ? 0 : index(d.f);
    const count = index(d.count);
    if (h === null || v === null || f === null || !count || h >= count) return null;
    return { h, v, f, count, notes: typeof d.notes === "string" ? d.notes.slice(0, MAX_NOTES_CHARS) : "" };
  }
  /* "#/<h>[/<v>[/<f>]]": the deck's own location format. */
  function hashOf(deck) {
    const parts = [deck.h];
    if (deck.v || deck.f) parts.push(deck.v);
    if (deck.f) parts.push(deck.f);
    return "#/" + parts.join("/");
  }

  /* ---- frames ---- */
  function createFrame(id) {
    const f = { id, title: "", version: "", reloads: 0, timer: 0, hash: "", deck: null, loaded: false, visible: true };
    Scenes.createBody(f, "stage-frame");
    f.body.dataset.sceneId = id;
    f.strip = el("button", "tile-strip");
    f.strip.type = "button";
    f.strip.addEventListener("click", () => {
      f.strip.blur(); // the deck keys are forwarded only while the page itself (not a button) has focus
      setSolo(soloId === id ? "" : id, true);
    });
    f.tile = el("section", "tile");
    f.tile.dataset.sceneId = id;
    kids(f.tile, [f.strip, f.body]);
    f.onLoad = () => {
      f.loaded = true; // a frame that never loaded has nobody to tell
      postHost(f, "visible", { visible: f.visible });
      if (f === active() && hooks.canFocus()) focusFrame(f);
    };
    return f;
  }
  function updateFrame(f, s) {
    f.title = s.title || s.id;
    paintStrip(f);
    f.alt.textContent = s.alt;
    f.iframe.title = s.alt || s.title || s.id;
    const version = s.rev + "-" + s.mtime;
    if (version !== f.version) {
      f.version = version;
      f.reloads = 0;
      Scenes.load(f); // f.hash is kept: the new src reopens the deck where it was
    }
  }
  function paintStrip(f) {
    const isSolo = f.id === soloId;
    f.strip.textContent = (isSolo ? SOLO_PREFIX : "") + f.title;
    f.strip.title = isSolo ? "Back to all frames (Esc)" : "Open " + f.title + " alone";
    f.strip.setAttribute("aria-label", f.strip.title);
  }
  function postHost(f, name, data) {
    try {
      f.iframe.contentWindow.postMessage({ type: HOST_TYPE, name, data }, ANY_ORIGIN);
    } catch (e) { /* frame not ready or gone */ }
  }
  function focusFrame(f) {
    try {
      f.iframe.focus();
      if (f.iframe.contentWindow && f.iframe.contentWindow.focus) f.iframe.contentWindow.focus();
    } catch (e) { /* ignore */ }
  }
  /* The frame the keys, the progress and the notes belong to: the scene shown alone, else the deck, else the first tile. */
  const active = () => frames.get(soloId) || frames.get(deckId) || frames.get(order[0]) || null;

  /* ---- the grid ---- */
  function stageSize() {
    const w = container && container.clientWidth;
    const h = container && container.clientHeight;
    return w > 0 && h > 0 ? { width: w, height: h } : FALLBACK_SIZE;
  }
  /* Place every tile for the stage's shape (or the one scene alone), tell the frames whether they can be seen. */
  function applyLayout() {
    if (!container) return;
    const ids = soloId && frames.has(soloId) ? [soloId] : order;
    const size = stageSize();
    const plan = Layout.chooseLayout(ids.length, size.width, size.height);
    const shown = ids.slice(0, plan.shown);
    container.dataset.count = String(plan.shown);
    container.classList.toggle("is-solo", ids.length === 1 && order.length > 1);
    container.style.gridTemplateColumns = plan.cols.map((fr) => "minmax(0," + fr + "fr)").join(" ");
    container.style.gridTemplateRows = plan.rows.map((fr) => "minmax(0," + fr + "fr)").join(" ");
    for (const f of frames.values()) {
      const at = shown.indexOf(f.id);
      f.tile.hidden = at < 0;
      paintStrip(f);
      if (at >= 0) {
        const c = plan.cells[at];
        f.tile.style.gridArea = c.row + " / " + c.col + " / span " + c.rowSpan + " / span " + c.colSpan;
      }
      const visible = at >= 0;
      if (visible !== f.visible) {
        f.visible = visible;
        if (f.loaded) postHost(f, "visible", { visible });
      }
    }
    moreEl.hidden = plan.more === 0;
    moreEl.textContent = plan.more === 0 ? "" : MORE_TEXT(plan.more);
  }

  /* Show one scene alone ("" = back to the workspace); `focus` hands the keys to its frame. */
  function setSolo(id, writeHash) {
    const next = id && frames.has(id) ? id : "";
    const changed = next !== soloId;
    soloId = next;
    if (writeHash && globalThis.location) location.hash = next ? STAGE_HASH_PREFIX + next : "";
    applyLayout();
    const f = active();
    if (changed && f && hooks.canFocus()) focusFrame(f);
    if (changed) hooks.onChange();
  }

  const hashId = () => {
    const m = STAGE_HASH_RE.exec(globalThis.location ? location.hash : "");
    return m ? m[1] : "";
  };

  /* Reconcile with the tile scenes (normalized, in state order). The solo scene survives while it exists; a page opened on
   * "#stage=<id>" starts with that scene alone. */
  function sync(parent, tileScenes) {
    if (container !== parent) {
      container = parent;
      moreEl = el("p", "tile-more");
      moreEl.hidden = true;
      container.appendChild(moreEl);
      window.addEventListener("resize", applyLayout);
    }
    const live = new Set(tileScenes.map((s) => s.id));
    const isFirstSync = frames.size === 0;
    for (const [id, f] of frames) {
      if (live.has(id)) continue;
      clearTimeout(f.timer);
      f.tile.remove();
      frames.delete(id);
    }
    order = Layout.orderTiles(tileScenes, "").map((s) => s.id);
    for (const s of tileScenes) {
      let f = frames.get(s.id);
      if (!f) {
        f = createFrame(s.id);
        frames.set(s.id, f);
        container.insertBefore(f.tile, moreEl);
      }
      updateFrame(f, s);
    }
    hasCustom = tileScenes.some((s) => !s.builtin);
    if (isFirstSync && hashId() && live.has(hashId())) soloId = hashId();
    if (soloId && !live.has(soloId)) soloId = "";
    applyLayout();
  }

  function onHashChange() {
    const id = hashId();
    if (id !== soloId && (id === "" || frames.has(id))) setSolo(id, false);
  }

  function reload() {
    const f = active();
    if (!f) return;
    f.reloads++;
    Scenes.load(f);
  }

  /* What the rail and the drawer show. */
  function view() {
    const f = active();
    return {
      hasCustom,
      selectedId: soloId,
      progress: f && f.deck ? { n: f.deck.h + 1, count: f.deck.count } : null,
      notes: f && f.deck ? f.deck.notes : "",
      openHref: f ? Scenes.sceneUrl(f, f.version, false) : "",
    };
  }

  function sceneIdOf(source) {
    if (!source) return null;
    for (const f of frames.values()) if (f.iframe.contentWindow === source) return f.id;
    return null;
  }

  function onMessage(ev) {
    const d = ev.data;
    if (!isObj(d) || d.type !== DECK_TYPE) return;
    const id = sceneIdOf(ev.source);
    if (!id) return;
    const deck = normDeck(d);
    if (!deck) return;
    const f = frames.get(id);
    f.deck = deck;
    f.hash = hashOf(deck);
    deckId = id;
    if (f === active()) hooks.onChange();
  }

  /* Esc leaves the solo view; keys reach the page only while the page (not the frame) has focus: pass the stage keys on. */
  function onKeydown(ev) {
    if (ev.key === ESCAPE && soloId && !ev.defaultPrevented && hooks.canFocus()) {
      ev.preventDefault();
      setSolo("", true);
      return;
    }
    const f = active();
    if (!f || ev.defaultPrevented || ev.ctrlKey || ev.metaKey || ev.altKey || !FORWARD_KEYS.includes(ev.key)) return;
    const t = ev.target;
    if (isTextEntry(t) || (t && t.tagName === "BUTTON")) return;
    if (within(t, document.getElementById("drawer")) || within(t, document.getElementById("rail"))) return;
    if (document.activeElement === f.iframe) return;
    ev.preventDefault();
    postHost(f, "key", { key: ev.key });
  }

  function init(options) {
    hooks = { ...hooks, ...options };
    window.addEventListener("message", onMessage);
    window.addEventListener("hashchange", onHashChange);
    document.addEventListener("keydown", onKeydown);
  }

  globalThis.PanelStage = {
    init, sync, selectTab: (id) => setSolo(id, true), reload, view, sceneIdOf, onMessage, onKeydown, onHashChange,
    focusActive: () => { const f = active(); if (f) focusFrame(f); },
    hasStage: () => frames.size > 0,
    constants: { FORWARD_KEYS, STAGE_HASH_PREFIX },
  };
})();
