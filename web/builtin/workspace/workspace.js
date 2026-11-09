"use strict";
/* The workspace page: tiles every scene of the panel state in one grid (layout.js decides the grid from the viewport)
 * and keeps them alive. Served by the panel server at /<token>/workspace/ (same origin as /state and /events); the scenes
 * are the usual /s/<id>/ pages and stay sandboxed by their own CSP. The terminal's live preview screencasts this page.
 *   ?hero=<id>   the scene the person picked: it becomes the big tile (first in order)
 *   #<id>.<h>_<v>  moves one tile's deck (layout.js tileHash); the page also forwards ArrowLeft/ArrowRight/... to the deck that spoke last, else the big tile */
(function () {
  const L = globalThis.PanelWorkspaceLayout;
  const STATE_EVENTS = "../events";
  const SCENE_BASE = "../s/";
  const SANDBOX = "allow-scripts";
  const ALLOW = "autoplay; fullscreen";
  const HOST_TYPE = "panel-host";
  const CHANNEL_NAME = "channel";
  const DECK_TYPE = "panel-deck";
  const ANY_ORIGIN = "*";
  const FORWARD_KEYS = ["ArrowLeft", "ArrowRight", "PageUp", "PageDown", "Home", "End", " "];
  const EVENT_URL = "../event";
  const EMIT_TYPE = "panel-emit";
  const HOST_PREFIX = "deck.";
  const EMIT_NAME_RE = /^[a-z0-9._-]{1,40}$/;
  const EMIT_MIN_INTERVAL_MS = 100;
  const EMIT_MAX_BYTES = 2200;
  const MORE_TEXT = (n) => "+" + n + " more";

  const grid = document.getElementById("workspace");
  const moreChip = document.getElementById("more");
  const hero = new URLSearchParams(location.search).get("hero") || "";
  const tiles = new Map(); // id -> { node, strip, iframe, version }
  const hashes = new Map(); // id -> the deck hash the tile was moved to (kept for a scene that is not published yet)
  let scenes = [];
  let deckId = ""; // the scene that reported a deck last: it gets the arrow keys

  // This page is the server's own code, same origin as POST event: a scene's panel.emit travels through it (the scene id comes from
  // the iframe the message came from, never from the message), so a click in the terminal pane reaches Claude like one on the browser page.
  const tellChannel = (iframe) => iframe.contentWindow && iframe.contentWindow.postMessage({ type: HOST_TYPE, name: CHANNEL_NAME, data: { emit: true } }, ANY_ORIGIN);
  const sceneOf = (source) => { for (const [id, t] of tiles) if (t.iframe.contentWindow === source) return id; return ""; };
  let lastEmitAt = 0;
  function forwardEmit(ev) {
    const d = ev.data;
    const id = sceneOf(ev.source);
    if (!id || typeof d.name !== "string" || !EMIT_NAME_RE.test(d.name) || d.name.indexOf(HOST_PREFIX) === 0) return;
    const now = Date.now();
    if (now - lastEmitAt < EMIT_MIN_INTERVAL_MS) return;
    lastEmitAt = now;
    const body = JSON.stringify({ scene: id, name: d.name, data: d.data === undefined ? null : d.data });
    if (body.length > EMIT_MAX_BYTES) return;
    fetch(EVENT_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body }).catch(() => {});
  }
  const versionOf = (s) => (Number(s.rev) || 0) + "-" + (Number(s.mtime) || 0);
  const srcOf = (id, version, hash) => SCENE_BASE + id + "/?v=" + version + hash;

  function makeTile(id) {
    const node = document.createElement("section");
    node.className = "tile";
    node.dataset.sceneId = id;
    const strip = document.createElement("header");
    strip.className = "strip";
    const iframe = document.createElement("iframe");
    iframe.setAttribute("sandbox", SANDBOX);
    iframe.setAttribute("allow", ALLOW);
    iframe.setAttribute("referrerpolicy", "no-referrer");
    iframe.addEventListener("load", () => tellChannel(iframe));
    node.append(strip, iframe);
    return { node, strip, iframe, version: "" };
  }

  function update(t, s) {
    const title = s.title || s.id;
    t.strip.textContent = title;
    t.iframe.title = s.alt || title;
    const version = versionOf(s);
    if (version === t.version) return;
    t.version = version;
    t.iframe.src = srcOf(s.id, version, hashes.get(s.id) || ""); // a rev / file change reloads the tile, at the hash it was moved to
  }

  function layout() {
    const order = L.orderTiles(L.tilesOf(scenes), hero);
    const plan = L.chooseLayout(order.length, innerWidth, innerHeight);
    const shown = order.slice(0, plan.shown);
    const live = new Set(order.map((s) => s.id));
    for (const [id, t] of tiles) {
      if (live.has(id)) continue;
      t.node.remove();
      tiles.delete(id);
    }
    for (const s of order) {
      if (!tiles.has(s.id)) tiles.set(s.id, makeTile(s.id));
      update(tiles.get(s.id), s);
    }
    grid.dataset.count = String(plan.shown);
    grid.style.gridTemplateColumns = plan.cols.map((f) => "minmax(0," + f + "fr)").join(" ");
    grid.style.gridTemplateRows = plan.rows.map((f) => "minmax(0," + f + "fr)").join(" ");
    for (const [id, t] of tiles) if (!shown.some((s) => s.id === id)) t.node.remove(); // beyond the cap: off the page (and unloaded)
    shown.forEach((s, i) => {
      const c = plan.cells[i];
      const t = tiles.get(s.id);
      t.node.toggleAttribute("data-hero", i === 0); // the big tile: where the live view's scroll keys act (live.mjs)
      t.node.style.gridArea = c.row + " / " + c.col + " / span " + c.rowSpan + " / span " + c.colSpan;
      if (!t.node.parentNode) grid.appendChild(t.node); // placement is by grid-area, so DOM order never matters (and a moved iframe would reload)
    });
    moreChip.hidden = plan.more === 0;
    moreChip.textContent = plan.more === 0 ? "" : MORE_TEXT(plan.more);
    return shown;
  }

  const bigTile = () => {
    const first = L.orderTiles(L.tilesOf(scenes), hero)[0];
    return tiles.get(deckId) || (first ? tiles.get(first.id) : null) || null;
  };

  function onMessage(ev) {
    const d = ev.data;
    if (d && d.type === EMIT_TYPE) return forwardEmit(ev);
    if (!d || d.type !== DECK_TYPE) return;
    for (const [id, t] of tiles) if (t.iframe.contentWindow === ev.source) deckId = id;
  }

  function onHash() {
    const to = L.parseTileHash(location.hash);
    if (!to) return;
    hashes.set(to.id, to.hash);
    const t = tiles.get(to.id);
    if (t && t.version) t.iframe.src = srcOf(to.id, t.version, to.hash); // same document, new hash: a hashchange inside the scene, no reload
  }

  function onKeydown(ev) {
    if (!FORWARD_KEYS.includes(ev.key) || ev.ctrlKey || ev.metaKey || ev.altKey) return;
    const t = bigTile();
    if (!t || !t.iframe.contentWindow) return;
    ev.preventDefault();
    t.iframe.contentWindow.postMessage({ type: HOST_TYPE, name: "key", data: { key: ev.key } }, ANY_ORIGIN);
  }

  // The live view's control file reaches a scene here (web/live.mjs `host` line): the same panel-host message the page sends for keys, so the scene hears it with panel.on(name).
  function hostCommand(sceneId, name, data) {
    const t = tiles.get(sceneId);
    if (!t || !t.iframe.contentWindow) return false;
    t.iframe.contentWindow.postMessage({ type: HOST_TYPE, name: name, data: data }, ANY_ORIGIN);
    return true;
  }
  window.PanelWorkspace = Object.freeze({ hostCommand: hostCommand });

  function onState(raw) {
    scenes = Array.isArray(raw && raw.scenes) ? raw.scenes : [];
    layout();
  }

  onHash(); // opened at a hash (shot_at)
  addEventListener("resize", layout);
  addEventListener("hashchange", onHash);
  addEventListener("message", onMessage);
  document.addEventListener("keydown", onKeydown);
  if (typeof EventSource === "function") {
    const es = new EventSource(STATE_EVENTS);
    es.onmessage = (ev) => {
      try { onState(JSON.parse(ev.data)); } catch (e) { console.error("workspace: bad state", e); }
    };
  }
})();
