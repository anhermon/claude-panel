"use strict";
/* Panel block renderers: one function per block kind, looked up through RENDERERS[kind].
 * Contract: renderer(block) returns an Element, or null when there is nothing to show.
 * Every string from state goes through textContent; never innerHTML. */
(function () {
  const SAFE_PROTOCOLS = ["http:", "https:"];
  const LINK_REL = "noopener noreferrer";
  const LINK_TARGET = "_blank";
  const CALLOUT_TONES = ["info", "warn", "ok"];
  const DEFAULT_CALLOUT_TONE = "info";
  const DELTA_TONES = ["ok", "warn", "danger"];
  const STEP_STATES = {
    todo: { glyph: "○", label: "To do" },
    doing: { glyph: "◐", label: "In progress" },
    done: { glyph: "✓", label: "Done" },
    failed: { glyph: "✗", label: "Failed" },
    skipped: { glyph: "–", label: "Skipped" },
  };
  const DEFAULT_STEP_STATE = "todo";
  const TREE_MARKS = {
    added: { glyph: "+", label: "added" },
    changed: { glyph: "~", label: "changed" },
    removed: { glyph: "-", label: "removed" },
    focus: { glyph: "◉", label: "focus" },
  };
  const TREE_INDENT_CH = 2;
  const PERCENT = 100;
  const BAR_DECIMALS = 100; // round bar values to 2 decimals for display
  const DIFF_HUNK_PREFIX = "@@";
  const DIFF_META_PREFIXES = ["+++", "---"];
  const EMPTY_LINE_FILL = " ";

  /* ---- helpers ---- */
  const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const str = (x) => (typeof x === "string" ? x : typeof x === "number" && Number.isFinite(x) ? String(x) : "");
  const arr = (x) => (Array.isArray(x) ? x : []);
  const isObj = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
  const objs = (x) => arr(x).filter(isObj);
  const strs = (x) => arr(x).map(str).filter(Boolean);
  const pick = (list, v) => (typeof v === "string" && list.includes(v) ? v : "");

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }
  function kids(parent, children) {
    for (const c of children) if (c) parent.appendChild(c);
    return parent;
  }
  function srOnly(text) {
    return el("span", "sr-only", text);
  }

  /* ---- icons and keyboard-target helper, shared by the card frames (scenes.js), the stage and the rail ---- */
  const SVG_NS = "http://www.w3.org/2000/svg";
  const ICON_VIEWBOX = "0 0 16 16";
  const ICON_STROKE_WIDTH = "1.5";
  const ICON_PATHS = {
    reload: "M13.25 8a5.25 5.25 0 1 1-1.54-3.71M13.25 2.5v3h-3",
    open: "M9 2.5h4.5V7M13.5 2.5l-6 6M12 9.5v3a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3",
    fullscreen: "M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10",
    drawer: "M3.5 2.5h9a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1zM10 2.5v11",
    close: "M3.5 3.5l9 9M12.5 3.5l-9 9",
  };
  const TEXT_ENTRY_TAGS = ["INPUT", "TEXTAREA", "SELECT"];
  function icon(name) {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", ICON_VIEWBOX);
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", ICON_STROKE_WIDTH);
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    const p = document.createElementNS(SVG_NS, "path");
    p.setAttribute("d", ICON_PATHS[name]);
    svg.appendChild(p);
    return svg;
  }
  /* tag is "button" or "a"; the label is both the accessible name and the tooltip. */
  function iconButton(tag, name, label) {
    const b = el(tag, "icon-btn");
    if (tag === "button") b.type = "button";
    b.setAttribute("aria-label", label);
    b.title = label;
    b.appendChild(icon(name));
    return b;
  }
  /* A key pressed in a text field (or select, or contenteditable) belongs to that control. */
  function isTextEntry(node) {
    return !!node && (TEXT_ENTRY_TAGS.includes(node.tagName) || node.isContentEditable === true);
  }
  function within(node, root) {
    for (let n = node; n; n = n.parentNode) if (n === root) return true;
    return false;
  }
  /* A horizontally scrollable region must be keyboard-reachable and named. */
  function scrollable(node, label) {
    node.tabIndex = 0;
    node.setAttribute("role", "region");
    node.setAttribute("aria-label", label);
    return node;
  }
  function listOf(tag, items, cls) {
    const l = el(tag, cls);
    for (const t of items) l.appendChild(el("li", "", t));
    return l;
  }
  function afterPaint(fn) {
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => requestAnimationFrame(fn));
    else fn();
  }
  /* Parsed URL only when it is http(s); anything else is dropped. */
  function safeUrl(raw) {
    const s = str(raw).trim();
    if (!s) return null;
    try {
      const u = new URL(s);
      return SAFE_PROTOCOLS.includes(u.protocol) ? u : null;
    } catch {
      return null;
    }
  }

  /* ---- the five v1 kinds ---- */
  function text(b) {
    const t = str(b.text);
    return t ? el("p", "", t) : null;
  }
  function list(b) {
    const items = strs(b.items);
    return items.length ? listOf("ul", items, "plain-list") : null;
  }
  function table(b) {
    const head = arr(b.head).map(str);
    const rows = arr(b.rows).filter(Array.isArray).map((r) => r.map(str));
    if (!head.length && !rows.length) return null;
    const t = el("table");
    if (head.length) {
      const tr = el("tr");
      for (const h of head) {
        const th = el("th", "", h);
        th.scope = "col";
        tr.appendChild(th);
      }
      t.appendChild(el("thead")).appendChild(tr);
    }
    const tb = el("tbody");
    for (const r of rows) {
      const tr = el("tr");
      for (const c of r) tr.appendChild(el("td", "", c));
      tb.appendChild(tr);
    }
    t.appendChild(tb);
    return scrollable(kids(el("div", "tablewrap"), [t]), "Table");
  }
  function code(b) {
    const t = str(b.text);
    if (!t) return null;
    const pre = scrollable(el("pre"), "Code");
    pre.appendChild(el("code", "", t));
    return pre;
  }
  function callout(b) {
    const t = str(b.text);
    if (!t) return null;
    const c = el("div", "callout " + (pick(CALLOUT_TONES, b.tone) || DEFAULT_CALLOUT_TONE));
    c.appendChild(el("p", "", t));
    return c;
  }

  /* ---- v2 kinds ---- */
  function steps(b) {
    const items = objs(b.items).filter((i) => str(i.text));
    if (!items.length) return null;
    const ul = el("ul", "steps");
    for (const i of items) {
      const state = has(STEP_STATES, i.state) ? i.state : DEFAULT_STEP_STATE;
      const li = el("li", "step state-" + state);
      const icon = el("span", "step-icon", STEP_STATES[state].glyph);
      icon.setAttribute("aria-hidden", "true");
      const body = kids(el("div", "step-body"), [srOnly(STEP_STATES[state].label + ": "), el("span", "step-text", str(i.text))]);
      if (str(i.note)) body.appendChild(el("div", "note", str(i.note)));
      ul.appendChild(kids(li, [icon, body]));
    }
    return ul;
  }

  function kv(b) {
    const rows = arr(b.rows).filter((r) => Array.isArray(r) && (str(r[0]) || str(r[1])));
    if (!rows.length) return null;
    const dl = el("dl", "kv");
    for (const r of rows) dl.appendChild(kids(el("div", "kv-row"), [el("dt", "", str(r[0])), el("dd", "", str(r[1]))]));
    return dl;
  }

  function metrics(b) {
    const items = objs(b.items).filter((i) => str(i.label) || str(i.value));
    if (!items.length) return null;
    const ul = el("ul", "metrics");
    for (const i of items) {
      const li = el("li", "metric");
      li.appendChild(el("div", "m-value", str(i.value)));
      li.appendChild(el("div", "m-label", str(i.label)));
      if (str(i.delta)) li.appendChild(el("div", "m-delta " + pick(DELTA_TONES, i.tone), str(i.delta)));
      ul.appendChild(li);
    }
    return ul;
  }

  function progress(b) {
    if (typeof b.value !== "number" || !Number.isFinite(b.value)) return null;
    const pct = Math.round(Math.min(1, Math.max(0, b.value)) * PERCENT);
    const label = str(b.label);
    const w = el("div", "progress");
    w.appendChild(kids(el("div", "progress-row"), [el("span", "", label), el("span", "progress-pct", pct + "%")]));
    const fill = el("div", "fill");
    fill.style.width = "0%";
    const track = kids(el("div", "track"), [fill]);
    track.setAttribute("role", "progressbar");
    track.setAttribute("aria-valuemin", "0");
    track.setAttribute("aria-valuemax", String(PERCENT));
    track.setAttribute("aria-valuenow", String(pct));
    track.setAttribute("aria-label", label || "Progress");
    w.appendChild(track);
    if (str(b.note)) w.appendChild(el("div", "note", str(b.note)));
    afterPaint(() => { fill.style.width = pct + "%"; }); // lets the width transition run
    return w;
  }

  function diffLineClass(line) {
    if (DIFF_META_PREFIXES.some((p) => line.startsWith(p))) return "meta";
    if (line.startsWith(DIFF_HUNK_PREFIX)) return "hunk";
    if (line.startsWith("+")) return "add";
    if (line.startsWith("-")) return "del";
    return "ctx";
  }
  function diff(b) {
    const t = str(b.text);
    if (!t) return null;
    const w = el("div", "diff");
    if (str(b.file)) w.appendChild(el("div", "diff-file", str(b.file)));
    const pre = scrollable(el("pre", "diff-body"), "Diff");
    for (const line of t.split("\n")) pre.appendChild(el("span", "dl " + diffLineClass(line), line || EMPTY_LINE_FILL));
    w.appendChild(pre);
    return w;
  }

  /* Flat paths -> nested nodes, first-seen order; Map keys cannot clash with Object.prototype. */
  function buildTree(items) {
    const root = { children: new Map(), item: null };
    for (const it of items) {
      let node = root;
      for (const seg of str(it.path).split("/").filter(Boolean)) {
        if (!node.children.has(seg)) node.children.set(seg, { name: seg, children: new Map(), item: null });
        node = node.children.get(seg);
      }
      if (node !== root) node.item = it;
    }
    return root;
  }
  function treeLines(node, depth, out) {
    for (const c of node.children.values()) {
      const mark = c.item && has(TREE_MARKS, c.item.mark) ? TREE_MARKS[c.item.mark] : null;
      const isDir = c.children.size > 0;
      const line = el("div", "tree-line");
      line.style.paddingLeft = depth * TREE_INDENT_CH + "ch";
      const m = el("span", "tree-mark" + (mark ? " mark-" + c.item.mark : ""), mark ? mark.glyph : "");
      m.setAttribute("aria-hidden", "true");
      line.appendChild(m);
      if (mark) line.appendChild(srOnly(mark.label + ": "));
      line.appendChild(el("span", "tree-name" + (isDir && !c.item ? " dir" : ""), c.name + (isDir ? "/" : "")));
      if (c.item && str(c.item.note)) line.appendChild(el("span", "tree-note", str(c.item.note)));
      out.push(line);
      treeLines(c, depth + 1, out);
    }
    return out;
  }
  function tree(b) {
    const lines = treeLines(buildTree(objs(b.items)), 0, []);
    return lines.length ? kids(scrollable(el("div", "tree"), "File tree"), lines) : null;
  }

  function bulletList(tag, items, cls) {
    return items.length ? listOf(tag, items, cls) : null;
  }
  function options(b) {
    const items = objs(b.items).filter((i) => str(i.title));
    if (!items.length) return null;
    const wrap = el("div", "options");
    for (const i of items) {
      const card = el("article", "option" + (i.pick === true ? " pick" : ""));
      const head = el("div", "option-head");
      head.appendChild(el("h3", "", str(i.title)));
      if (i.pick === true) head.appendChild(el("span", "badge", "Recommended"));
      card.appendChild(head);
      if (str(i.summary)) card.appendChild(el("p", "summary", str(i.summary)));
      kids(card, [bulletList("ul", strs(i.pros), "pros"), bulletList("ul", strs(i.cons), "cons")]);
      wrap.appendChild(card);
    }
    return wrap;
  }

  function timeline(b) {
    const items = objs(b.items).filter((i) => str(i.text));
    if (!items.length) return null;
    const ol = el("ol", "timeline");
    for (const i of items) {
      const rail = el("span", "rail");
      rail.setAttribute("aria-hidden", "true");
      rail.appendChild(el("span", "tl-dot " + pick(DELTA_TONES, i.tone)));
      ol.appendChild(kids(el("li"), [el("span", "when", str(i.when)), rail, el("span", "tl-text", str(i.text))]));
    }
    return ol;
  }

  function sources(b) {
    const ul = el("ul", "sources");
    for (const i of objs(b.items)) {
      const u = safeUrl(i.url);
      const title = str(i.title) || (u ? u.hostname : "");
      if (!title) continue;
      const li = el("li");
      if (u) {
        const a = el("a", "", title);
        a.href = u.href;
        a.target = LINK_TARGET;
        a.rel = LINK_REL;
        li.appendChild(a);
        li.appendChild(el("span", "host", u.hostname));
      } else {
        li.appendChild(el("span", "", title));
      }
      if (str(i.note)) li.appendChild(el("div", "note", str(i.note)));
      ul.appendChild(li);
    }
    return ul.childNodes.length ? ul : null;
  }

  function bars(b) {
    const items = objs(b.items).filter((i) => str(i.label) && typeof i.value === "number" && Number.isFinite(i.value) && i.value >= 0);
    if (!items.length) return null;
    const max = Math.max(...items.map((i) => i.value));
    const unit = str(b.unit);
    const ul = el("ul", "bars");
    for (const i of items) {
      const fill = el("div", "fill");
      fill.style.width = (max > 0 ? (i.value / max) * PERCENT : 0) + "%";
      const track = kids(el("div", "track"), [fill]);
      track.setAttribute("aria-hidden", "true");
      const shown = Math.round(i.value * BAR_DECIMALS) / BAR_DECIMALS + (unit ? " " + unit : "");
      ul.appendChild(kids(el("li", "bar-row"), [el("span", "bar-label", str(i.label)), track, el("span", "bar-value", shown)]));
    }
    return ul;
  }

  function tags(b) {
    const items = strs(b.items);
    return items.length ? listOf("ul", items, "tags") : null;
  }

  function quote(b) {
    const t = str(b.text);
    if (!t) return null;
    const q = el("blockquote", "quote");
    q.appendChild(el("p", "", t));
    if (str(b.by)) q.appendChild(el("p", "by", "— " + str(b.by)));
    return q;
  }

  const RENDERERS = {
    text, list, table, code, callout,
    steps, kv, metrics, progress, diff, tree, options, timeline, sources, bars, tags, quote,
  };

  /* Wrapper element for one block, or null (unknown kind, empty, or malformed: never throws). */
  function renderBlock(b) {
    try {
      if (!isObj(b) || typeof b.kind !== "string" || !has(RENDERERS, b.kind)) return null;
      const inner = RENDERERS[b.kind](b);
      return inner ? kids(el("div", "block block-" + b.kind), [inner]) : null;
    } catch (e) {
      console.error("panel: skipped malformed block", e);
      return null;
    }
  }

  globalThis.PanelBlocks = { RENDERERS, renderBlock, el, str, kids, icon, iconButton, isTextEntry, within };
})();
