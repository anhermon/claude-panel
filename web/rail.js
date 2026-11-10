"use strict";
/* Panel chrome for stage mode: the 40px rail (status, title, ask pill with inline answer buttons, deck
 * progress, buttons), the right-hand drawer, fullscreen with an auto-hiding rail, and the page-level keys `i` `f` Esc.
 * Also owns the ask answer buttons, which are shown both in the rail and in the drawer's ask section.
 *
 * The page keeps working without stage mode: ui.js only calls update({on:true}) when a stage scene exists. */
(function () {
  const { plainTitle } = globalThis.PanelTitles;
  const { el, kids, iconButton, isTextEntry, within } = globalThis.PanelBlocks;

  const SENT_MS = 3000; // "Sent: <label>" stays this long, then the answers are clickable again
  const AUTOHIDE_MS = 2500; // fullscreen: rail hides after this long without pointer movement
  const NARROW_QUERY = "(max-width: 699px)";
  const SENT_PREFIX = "Sent: ";
  const ASK_LABEL_PREFIX = "Question for you, open details: ";
  const DEFAULT_TITLE = "Panel";
  const noop = () => {};

  const $ = (id) => document.getElementById(id);
  const stage = () => globalThis.PanelStage;

  let stageOn = false;
  let drawerAllowed = false; // false while the board is alone: it carries the task and the question itself
  let drawerOpen = false;
  let fullscreen = false;
  let hideTimer = 0;
  let railHover = false;
  let askSig = "";
  const buttons = {}; // drawer, reload, open, fullscreen, close

  /* ---- ask answers: one group per place (rail pill, ask section), all showing the same "Sent" state ---- */
  const groups = new Map(); // where -> { node, btns, sentEl }
  let sentLabel = "";
  let sentTimer = 0;

  function paintGroup(g) {
    const on = sentLabel !== "";
    const hadFocus = within(document.activeElement, g.node);
    g.btns.forEach((b) => { b.hidden = on; });
    g.sentEl.hidden = !on;
    g.sentEl.textContent = on ? SENT_PREFIX + sentLabel : "";
    if (on && hadFocus) g.sentEl.focus(); // keep keyboard focus inside the group while the buttons are away
    if (!on && document.activeElement === g.sentEl && g.btns[0]) g.btns[0].focus();
  }
  function answer(choice) {
    const events = globalThis.PanelEvents;
    if (sentLabel || !events) return;
    events.sendAnswer(choice).then((ok) => {
      if (!ok) return; // silent: the server may reject
      sentLabel = choice.label;
      groups.forEach(paintGroup);
      clearTimeout(sentTimer);
      sentTimer = setTimeout(() => { sentLabel = ""; groups.forEach(paintGroup); }, SENT_MS);
    });
  }
  /* choices: [{id,label}]; where: "rail" | "ask". Returns the node, or null when there is nothing to click. */
  function choiceGroup(choices, where) {
    if (!choices.length) { groups.delete(where); return null; }
    const node = el("div", "choices");
    node.setAttribute("role", "group");
    node.setAttribute("aria-label", "Answers");
    node.setAttribute("aria-live", "polite");
    const btns = choices.map((c) => {
      const b = el("button", "choice", c.label);
      b.type = "button";
      b.title = c.label;
      b.dataset.choiceId = c.id;
      b.addEventListener("click", () => answer(c));
      return b;
    });
    const sentEl = el("span", "choice-sent");
    sentEl.tabIndex = -1;
    sentEl.hidden = true;
    kids(node, [...btns, sentEl]);
    const g = { node, btns, sentEl };
    groups.set(where, g);
    paintGroup(g);
    return node;
  }

  /* ---- drawer ---- */
  function setDrawer(open) {
    const drawer = $("drawer");
    if (open === drawerOpen || (open && !(stageOn && drawerAllowed))) return;
    drawerOpen = open;
    drawer.classList.toggle("open", open);
    buttons.drawer.setAttribute("aria-expanded", String(open));
    buttons.drawer.classList.toggle("active", open);
    // open: focus moves into the drawer (a labelled landmark). close: back to the stage, where the keys live.
    if (open) drawer.focus();
    else if (stage()) stage().focusActive();
  }
  const toggleDrawer = () => setDrawer(!drawerOpen);

  /* ---- fullscreen: the whole shell (rail, stage and drawer), so the rail can still appear over the stage ---- */
  function toggleFullscreen() {
    if (!document.fullscreenEnabled) return;
    if (document.fullscreenElement) {
      if (document.exitFullscreen) document.exitFullscreen();
      return;
    }
    const shell = $("shell");
    if (!shell.requestFullscreen) return;
    const r = shell.requestFullscreen();
    if (r && r.catch) r.catch(noop);
  }
  function showRail() {
    $("rail").classList.remove("rail-hidden");
    clearTimeout(hideTimer);
    if (fullscreen) hideTimer = setTimeout(hideRail, AUTOHIDE_MS);
  }
  function hideRail() {
    if (railHover || within(document.activeElement, $("rail"))) { hideTimer = setTimeout(hideRail, AUTOHIDE_MS); return; }
    $("rail").classList.add("rail-hidden");
  }
  function onFullscreenChange() {
    fullscreen = document.fullscreenElement === $("shell");
    document.body.classList.toggle("is-fullscreen", fullscreen);
    buttons.fullscreen.setAttribute("aria-pressed", String(fullscreen));
    showRail(); // entering arms the hide timer; leaving clears it and keeps the rail visible
    if (stage() && !drawerOpen) stage().focusActive();
  }

  /* ---- keys the page itself owns (stage.js forwards the deck keys): i, f, Esc ---- */
  function onKeydown(ev) {
    if (!stageOn) return;
    if (fullscreen) showRail();
    if (ev.key === "Escape") {
      if (drawerOpen) { setDrawer(false); ev.preventDefault(); }
      return; // leaving fullscreen with Esc is the browser's own job
    }
    if (ev.ctrlKey || ev.metaKey || ev.altKey || ev.defaultPrevented || isTextEntry(ev.target)) return;
    if (ev.key === "i") { toggleDrawer(); ev.preventDefault(); }
    else if (ev.key === "f") { toggleFullscreen(); ev.preventDefault(); }
  }

  /* ---- rail content ---- */
  function buildAskPill(pill, ask, choices) {
    pill.replaceChildren();
    const open = el("button", "rail-ask-text", ask);
    open.type = "button";
    open.title = ask;
    open.setAttribute("aria-label", ASK_LABEL_PREFIX + ask);
    open.addEventListener("click", () => setDrawer(true));
    kids(pill, [open, choiceGroup(choices, "rail")]);
  }

  /* v: { on, hasCustom, status, statusLabel, title, ask, choices, selectedId, progress, openHref } */
  function update(v) {
    stageOn = v.on === true;
    if (!stageOn) {
      setDrawer(false);
      if (fullscreen && document.exitFullscreen) document.exitFullscreen();
      return;
    }
    drawerAllowed = v.hasCustom === true;
    if (!drawerAllowed) setDrawer(false);
    buttons.drawer.hidden = !drawerAllowed;
    $("rail-dot").className = "dot " + v.status;
    $("rail-status").textContent = v.statusLabel;
    const title = $("rail-title");
    title.textContent = plainTitle(v.title, false) || DEFAULT_TITLE;
    title.title = plainTitle(v.title, false);

    const ask = drawerAllowed ? v.ask : ""; // alone, the board's own ask frame is the question
    const sig = JSON.stringify([ask, v.choices]);
    if (sig !== askSig) {
      askSig = sig;
      const pill = $("rail-ask");
      pill.hidden = !ask;
      if (ask) buildAskPill(pill, ask, v.choices);
      else groups.delete("rail");
    }
    buttons.drawer.classList.toggle("has-ask", !!ask); // narrow screens: a badge dot stands in for the pill

    const prog = $("rail-progress");
    prog.hidden = !v.progress;
    if (v.progress) {
      prog.textContent = v.progress.n + "/" + v.progress.count;
      prog.setAttribute("aria-label", "Slide " + v.progress.n + " of " + v.progress.count);
    }
    buttons.open.href = v.openHref || "";
  }

  function setOffline(offline) {
    $("rail-conn").hidden = !offline;
  }

  function init() {
    buttons.drawer = iconButton("button", "drawer", "Notes and summary (i)");
    buttons.drawer.setAttribute("aria-controls", "drawer");
    buttons.drawer.setAttribute("aria-expanded", "false");
    buttons.reload = iconButton("button", "reload", "Reload stage");
    buttons.open = iconButton("a", "open", "Open stage in a new tab");
    buttons.open.target = "_blank";
    buttons.open.rel = "noopener";
    buttons.fullscreen = iconButton("button", "fullscreen", "Full screen (f)");
    buttons.fullscreen.setAttribute("aria-pressed", "false");
    buttons.fullscreen.hidden = !document.fullscreenEnabled;
    buttons.close = iconButton("button", "close", "Close panel details");
    kids($("rail-actions"), [buttons.drawer, buttons.reload, buttons.open, buttons.fullscreen]);
    $("drawer-head").appendChild(buttons.close);

    buttons.drawer.addEventListener("click", toggleDrawer);
    buttons.close.addEventListener("click", () => setDrawer(false));
    buttons.reload.addEventListener("click", () => { if (stage()) stage().reload(); });
    buttons.fullscreen.addEventListener("click", toggleFullscreen);

    const rail = $("rail");
    rail.addEventListener("pointerenter", () => { railHover = true; });
    rail.addEventListener("pointerleave", () => { railHover = false; });
    document.addEventListener("pointermove", () => { if (fullscreen) showRail(); });
    document.addEventListener("touchstart", () => { if (fullscreen) showRail(); });
    document.addEventListener("keydown", onKeydown);
    document.addEventListener("fullscreenchange", onFullscreenChange);

    if (typeof matchMedia === "function") {
      const mq = matchMedia(NARROW_QUERY);
      const apply = () => document.body.classList.toggle("narrow", mq.matches);
      apply();
      if (mq.addEventListener) mq.addEventListener("change", apply);
    }
    const events = globalThis.PanelEvents;
    if (events) {
      events.onHost("deck.fullscreen", toggleFullscreen);
      events.onHost("deck.drawer", toggleDrawer);
    }
  }

  globalThis.PanelRail = {
    init, update, setOffline, choiceGroup, setDrawer, toggleDrawer, toggleFullscreen, onKeydown,
    isDrawerOpen: () => drawerOpen,
    constants: { SENT_MS, AUTOHIDE_MS, NARROW_QUERY },
  };
})();
