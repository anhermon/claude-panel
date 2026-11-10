"use strict";
/* Return channel, browser side: user actions travel page -> POST <base>event -> events file -> Claude.
 *
 * Trust rules (do not weaken):
 *  - {type:"panel-open", url} (a link click in the board's html frames) is honoured from the board frame only.
 *  - Only THIS page sends events. A scene frame can only ask the page to, via {type:"panel-emit", name, data}; the page
 *    checks event.source against its own iframe windows and tags the scene id ITSELF (the id in a message is never read).
 *  - {panel-emit "session-open"} from the board (a card of its Other sessions frame) is routed to the Agents tile as the host message
 *    "open-session" and never sent to the server: it is a page-side command, not something the user told Claude.
 *  - Names starting with "deck." are page-side commands (fullscreen, drawer); they are handled here and never forwarded.
 *  - Failure is silent: the server may reject (rate limit, bad name); the user just sees no "Sent" feedback.
 * All URLs are relative: the page is served at /<token>/. */
(function () {
  const EVENT_PATH = "event";
  const EMIT_TYPE = "panel-emit";
  const OPEN_TYPE = "panel-open";
  const BOARD_SCENE = "board"; // the built-in board; its id is reserved, a model's scene cannot take it
  const MAX_URL_CHARS = 2048;
  const HOST_PREFIX = "deck.";
  const ASK_SCENE = "_ask";
  const ASK_NAME = "answer";
  const SCENE_RE = /^(?:[a-z0-9-]{1,24}|_ask)$/;
  const NAME_RE = /^[a-z0-9._-]{1,40}$/;
  const MAX_DATA_BYTES = 2048; // same cap the server applies
  const FRAME_MIN_INTERVAL_MS = 100; // a scene cannot flood the server's global rate limit and starve ask answers
  const TOAST_MS = 2000;
  const SENT_PREFIX = "Sent: ";
  const SESSION_OPEN = "session-open"; // what the board's statusboard emits for a card with `open` (web/kit/assets/statusboard.js)
  const OPEN_SESSION = "open-session"; // what the Agents tile listens for (web/builtin/agents-info/agents-info.js)
  const AGENTS_SCENE = "agents-info";
  const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
  const SESSION_STATES = ["busy", "waiting", "idle"];
  const MAX_TITLE_CHARS = 70;

  const isObj = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
  const byteLength = (s) => new TextEncoder().encode(s).length;

  const hostHandlers = new Map(); // "deck.fullscreen" -> fn
  let lastFrameEmit = 0;
  let toastTimer = 0;

  function toast(text) {
    const node = document.getElementById("toast");
    if (!node) return;
    node.textContent = text;
    node.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { node.hidden = true; }, TOAST_MS);
  }

  /* Resolves true when the server accepted the event, false otherwise (invalid input, network error, rejection). */
  function post(scene, name, data) {
    if (!SCENE_RE.test(scene) || !NAME_RE.test(name)) return Promise.resolve(false);
    try {
      const payload = data === undefined ? null : data;
      const dataJson = JSON.stringify(payload);
      if (dataJson === undefined || byteLength(dataJson) > MAX_DATA_BYTES) return Promise.resolve(false);
      const body = JSON.stringify({ scene, name, data: payload });
      return Promise.resolve(fetch(EVENT_PATH, { method: "POST", headers: { "Content-Type": "application/json" }, body }))
        .then((r) => !!r && r.ok === true, () => false);
    } catch (e) {
      return Promise.resolve(false);
    }
  }

  const str = (x, max) => (typeof x === "string" ? x.slice(0, max) : "");
  function sendAnswer(choice) {
    return post(ASK_SCENE, ASK_NAME, { id: str(choice && choice.id, 24), label: str(choice && choice.label, 40) });
  }

  function onHost(name, fn) {
    hostHandlers.set(name, fn);
  }

  /* Which scene (card or stage) owns this window? null for anything else. */
  function sceneIdOf(source) {
    const stage = globalThis.PanelStage;
    const cards = globalThis.PanelScenes;
    return (stage && stage.sceneIdOf(source)) || (cards && cards.sceneIdOf(source)) || null;
  }

  /* The board's html frames hold links, but its sandboxed iframe cannot open a tab itself (no allow-popups, and the
   * sandbox must stay as is): it asks the page. Only the board may ask, only for an absolute http(s) url, opened
   * in a new tab without opener or referrer. */
  function openLink(ev, d) {
    if (sceneIdOf(ev.source) !== BOARD_SCENE || typeof d.url !== "string" || d.url.length > MAX_URL_CHARS) return;
    if (!/^https?:\/\/[^/\\\s]/i.test(d.url)) return;
    let url;
    try { url = new URL(d.url); } catch { return; }
    if (url.protocol === "https:" || url.protocol === "http:") window.open(url.href, "_blank", "noopener,noreferrer");
  }

  /* A card of the board's Other sessions frame: tell the Agents tile (the only one that can show a transcript) which session to open,
   * with what the card already says. Only the board may ask; the id is checked here and again by the mod, which opens only a session it listed. */
  function openSession(d) {
    const data = isObj(d) ? d : {};
    if (typeof data.id !== "string" || !SESSION_ID_RE.test(data.id)) return;
    const msg = { id: data.id, title: str(data.title, MAX_TITLE_CHARS), state: SESSION_STATES.includes(data.state) ? data.state : "busy" };
    const stage = globalThis.PanelStage;
    const cards = globalThis.PanelScenes;
    (stage && stage.hostCommand(AGENTS_SCENE, OPEN_SESSION, msg)) || (cards && cards.hostCommand(AGENTS_SCENE, OPEN_SESSION, msg));
  }

  function onMessage(ev) {
    const d = ev.data;
    if (isObj(d) && d.type === OPEN_TYPE) { openLink(ev, d); return; }
    if (!isObj(d) || d.type !== EMIT_TYPE || typeof d.name !== "string" || !NAME_RE.test(d.name)) return;
    const id = sceneIdOf(ev.source);
    if (!id) return;
    if (d.name === SESSION_OPEN && id === BOARD_SCENE) { openSession(d.data); return; }
    if (d.name.startsWith(HOST_PREFIX)) {
      const fn = hostHandlers.get(d.name);
      if (fn) fn();
      return; // never forwarded, known or not
    }
    const now = Date.now();
    if (now - lastFrameEmit < FRAME_MIN_INTERVAL_MS) return;
    lastFrameEmit = now;
    post(id, d.name, d.data).then((ok) => { if (ok) toast(SENT_PREFIX + d.name); });
  }
  window.addEventListener("message", onMessage);

  globalThis.PanelEvents = { post, sendAnswer, onHost, onMessage, toast, constants: { EVENT_PATH, SENT_PREFIX } };
})();
