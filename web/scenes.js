"use strict";
/* Panel scenes: model-written web pages, shown in sandboxed iframes that reload when their files change.
 *
 * Security contract (do not weaken): the iframe is `sandbox="allow-scripts"` ONLY. Never add allow-same-origin
 * (scene code would then run with the panel page's origin), never use srcdoc. The only thing accepted back from a
 * scene is a {type:"panel-fit", height:number} message, and only from that scene's own iframe window.
 *
 * Liveness contract: an iframe's src changes ONLY when its scene's `rev` or `mtime` changes (or the user presses
 * reload). Re-rendering for any other state change updates text in place and leaves running scenes alone. */
(function () {
  const { el, kids, iconButton } = globalThis.PanelBlocks;

  const SCENE_BASE = "s/"; // relative on purpose: the page lives at /<token>/
  const FIT_MESSAGE = "panel-fit";
  const SANDBOX = "allow-scripts";
  const ALLOW = "autoplay; fullscreen";
  const REFERRER_POLICY = "no-referrer";
  const LOAD_TIMEOUT_MS = 8000;
  const MIN_HEIGHT = 120;
  const MAX_HEIGHT = 1200;
  const DEFAULT_HEIGHT = 420;
  const DEFAULT_SPAN = 3;
  const SPANS = [1, 2, 3];
  const ID_RE = /^[a-z0-9-]{1,24}$/;
  const LAYOUTS = ["card", "stage"];
  const DEFAULT_LAYOUT = "card";
  const SLOTS = ["big", "side", "auto"];
  const DEFAULT_SLOT = "auto";

  const clamp = (n) => Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.round(n)));
  const isObj = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
  const num = (x, fallback) => (typeof x === "number" && Number.isFinite(x) ? x : fallback);

  /* The page never trusts the shape of the state, same as ui.js. */
  function normScenes(raw) {
    const seen = new Set();
    const out = [];
    for (const s of Array.isArray(raw) ? raw : []) {
      if (!isObj(s) || typeof s.id !== "string" || !ID_RE.test(s.id) || seen.has(s.id)) continue;
      seen.add(s.id);
      out.push({
        id: s.id,
        title: typeof s.title === "string" ? s.title : "",
        alt: typeof s.alt === "string" ? s.alt : "",
        span: SPANS.includes(s.span) ? s.span : DEFAULT_SPAN,
        height: clamp(num(s.height, DEFAULT_HEIGHT)),
        pin: s.pin === true,
        builtin: s.builtin === true,
        slot: SLOTS.includes(s.slot) ? s.slot : DEFAULT_SLOT,
        layout: LAYOUTS.includes(s.layout) ? s.layout : DEFAULT_LAYOUT,
        rev: num(s.rev, 0),
        mtime: num(s.mtime, 0),
      });
    }
    return out;
  }

  const frames = new Map(); // id -> frame (DOM nodes + load state); lives as long as the scene exists

  /* f.hash is only ever set on stage frames (the deck position reported by the frame, "#/h/v/f"); card frames have none. */
  function sceneUrl(f, version, withReload) {
    return SCENE_BASE + f.id + "/?v=" + version + (withReload && f.reloads ? "&r=" + f.reloads : "") + (f.hash || "");
  }
  function setBodyHeight(f, px) {
    f.body.style.height = px + "px";
  }
  /* (Re)navigate the iframe and restart the load watchdog. */
  function load(f) {
    f.body.classList.add("loading");
    f.body.classList.remove("slow");
    clearTimeout(f.timer);
    f.timer = setTimeout(() => { if (f.body.classList.contains("loading")) f.body.classList.add("slow"); }, LOAD_TIMEOUT_MS);
    f.iframe.src = sceneUrl(f, f.version, true);
    if (f.open) f.open.href = sceneUrl(f, f.version, false);
  }

  /* The sandboxed iframe plus its loading skeleton (f.iframe, f.body, f.alt, f.skeleton), shared by card and stage frames. */
  function createBody(f, extraClass) {
    f.body = el("div", "scene-body loading" + (extraClass ? " " + extraClass : ""));
    f.alt = el("p", "scene-alt");
    f.skeleton = kids(el("div", "scene-skeleton"), [f.alt]);
    f.iframe = el("iframe", "scene-frame");
    // attribute order matters: sandbox and friends are set before the first navigation
    f.iframe.setAttribute("sandbox", SANDBOX);
    f.iframe.setAttribute("allow", ALLOW);
    f.iframe.setAttribute("referrerpolicy", REFERRER_POLICY);
    f.iframe.setAttribute("loading", "lazy");
    f.iframe.addEventListener("load", () => {
      clearTimeout(f.timer);
      f.body.classList.remove("loading", "slow");
      if (f.onLoad) f.onLoad();
    });
    kids(f.body, [f.iframe, f.skeleton]);
    return f;
  }

  function createFrame(id) {
    const f = { id, version: "", reloads: 0, baseHeight: 0, timer: 0 };
    f.root = el("article", "scene");
    f.root.dataset.sceneId = id;
    f.titleEl = el("h2", "card-title scene-title");
    f.reload = iconButton("button", "reload", "Reload scene");
    f.open = iconButton("a", "open", "Open scene in a new tab");
    f.open.target = "_blank";
    f.open.rel = "noopener";
    f.full = iconButton("button", "fullscreen", "Full screen");
    f.full.hidden = !document.fullscreenEnabled;
    const actions = kids(el("div", "scene-actions"), [f.reload, f.open, f.full]);
    createBody(f);
    f.reload.addEventListener("click", () => { f.reloads++; load(f); });
    f.full.addEventListener("click", () => {
      if (f.iframe.requestFullscreen) f.iframe.requestFullscreen().catch(() => {});
    });
    kids(f.root, [kids(el("div", "scene-head"), [f.titleEl, actions]), f.body]);
    return f;
  }

  /* Cheap, idempotent text/layout updates; navigates only when rev or mtime moved. */
  function updateFrame(f, s) {
    f.root.className = "scene span-" + s.span;
    f.root.setAttribute("aria-label", s.title || s.alt || s.id);
    f.titleEl.textContent = s.title;
    f.titleEl.hidden = !s.title;
    f.alt.textContent = s.alt;
    f.iframe.title = s.alt || s.title || s.id;
    if (s.height !== f.baseHeight) { // a new height from the model wins over an earlier panel.fit()
      f.baseHeight = s.height;
      setBodyHeight(f, s.height);
    }
    const version = s.rev + "-" + s.mtime;
    if (version !== f.version) {
      f.version = version;
      f.reloads = 0;
      load(f);
    }
  }

  function dispose(f) {
    clearTimeout(f.timer);
    f.root.remove();
  }

  /* DOM order = pinned scenes first, then the rest (each in state order). Nodes already in place are not touched:
   * moving an iframe in the DOM reloads it, so only a node that is out of order is inserted before its successor. */
  function placeInOrder(container, nodes) {
    let cursor = container.firstElementChild;
    for (const n of nodes) {
      if (n === cursor) cursor = cursor.nextElementSibling;
      else container.insertBefore(n, cursor);
    }
  }

  /* Reconcile `container` with the scene list; returns how many scenes are shown. */
  function sync(container, rawScenes) {
    const scenes = normScenes(rawScenes);
    const live = new Set(scenes.map((s) => s.id));
    for (const [id, f] of frames) if (!live.has(id)) { dispose(f); frames.delete(id); }
    const ordered = [...scenes.filter((s) => s.pin), ...scenes.filter((s) => !s.pin)];
    const nodes = [];
    for (const s of ordered) {
      let f = frames.get(s.id);
      if (!f) {
        f = createFrame(s.id);
        frames.set(s.id, f);
      }
      updateFrame(f, s);
      nodes.push(f.root);
    }
    placeInOrder(container, nodes);
    container.hidden = nodes.length === 0;
    return nodes.length;
  }

  /* Height requests from scenes: only {type:"panel-fit", height:number}, only from a frame's own window. */
  function onMessage(ev) {
    const d = ev.data;
    if (!isObj(d) || d.type !== FIT_MESSAGE || typeof d.height !== "number" || !Number.isFinite(d.height)) return;
    for (const f of frames.values()) {
      if (f.iframe.contentWindow === ev.source) {
        setBodyHeight(f, clamp(d.height));
        return;
      }
    }
  }
  window.addEventListener("message", onMessage);

  /* Id of the card-layout scene whose iframe window is `source`, else null (the id always comes from here, never from a message). */
  function sceneIdOf(source) {
    if (!source) return null;
    for (const f of frames.values()) if (f.iframe.contentWindow === source) return f.id;
    return null;
  }

  globalThis.PanelScenes = { sync, normScenes, onMessage, sceneIdOf, createBody, load, sceneUrl, constants: { LOAD_TIMEOUT_MS, ID_RE } };
})();
