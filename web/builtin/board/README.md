# Board scene

A calm, dark, full-bleed board. It draws the frames listed in `live/data.json` and nothing else. No CDN, no network:
plain ES modules, the local panel kit only.

    index.html  board.css  board.js          page, styles, the loop (panel.data, change queue, FLIP, retire/mount)
    board-logic.mjs  grid-plan.mjs           pure: data normalising + change queue; the aspect-aware grid planner (tested in Node)
    diagram-layout.mjs  sanitize.mjs         pure: diagram auto layout, the `html` frame's sanitiser
    frames/*.js                              one module per frame type; frames/index.js is the registry
    fixtures/{busy,sparse,empty,agents,agents-solo,texts,...}.json    sample data;  seed-board.mjs copies the board + a fixture into a scene dir

## Data contract (`live/data.json`)

    { frames: [{ id: [a-z0-9-]{1,24}, type, title (<=40), size: s|m|l|xl, ... }],
      lanes: [{ id, label, state, pct, step, note, goal?, dod?: [{ t, state }], at?, calls?, startedAt, updatedAt }], now: { title, status }, pulse?, updatedAt }

Per type (extra fields; every text is capped, bad values are dropped, nothing throws):

    text      text, sub?                          now      text?, status?  (falls back to data.now)
    metric    value ("1,840 ms"), label?, delta?, tone?, spark?: number[]
    rings     items: [{ label, pct, color? }]       bars     items: [{ label, value, color? }], unit?
    line      series: [{ label, points: number[], color? }]
    steps     items: [{ t, state: todo|doing|done|failed }]
    diagram   nodes: [{ id, label, tone? }], edges: [{ from, to, label? }]   (auto layout, cycles ok)
    timeline  items: [{ when?, text, tone? }]      compare  left: { title, items }, right: { title, items }
    avatar    mood: idle|thinking|working|happy|alert|sleepy, say?
    ask       q, options: [string]    (a click emits board.answer {frame, option})
    lanes     shows data.lanes: one card per agent (goal else label up to 2 lines, step up to 2 lines, bar + pct, state pill,
              "3 min" running time, a small muted "12 calls"); order working, testing, blocked, waiting, done
    doing     (no payload) shows data.lanes as one line per agent: colored kind glyph, short name, the KIND of work (UI, Logic, Tests,
              Visual, Docs, Research, Reading, Delegating, Thinking), up to 2 file basenames; running first; a one-line legend of the kinds shown
    swimlane  items: [{ label, state: working|waiting|done, from, to, segs: [{ k: kind, a, b }] }]  (seconds from the session start):
              one lane per agent, bars colored by kind, "26 min 4 s" per lane, a legend of the kinds present (no call counts)
    tickets   summary: { total, verified, unverified, blocked, inflight }, items: [{ id, title, stage: draft|ready|building|verifying|fixing|done|
              unverified|blocked, agent?, checks?: { pass, total }, round?, maxRounds?, verdict?: PASS|FAIL|null, note?, dependsOn?: [id] }] (max 12):
              the router's tickets, one row each: stage chip, role chip, check meter, "round 1/2", "after 01". Header: "3 of 5 verified".
              Only `done` + verdict PASS is a green tick ("Verified"); `unverified` (or a done without a verdict) is amber "Claimed done, not
              verified", `blocked` is red, so a claim never looks like a check (router-frames-logic.mjs; auto frame from the router state)
    checks    result: PASS|FAIL|null, round, maxRounds, items: [{ item, pass: true|false|null, evidence? }]: one ticket's checklist: a ✓ / ✕ / ○
              per check, its evidence line under it (2 lines, full text in the title), a result badge and "fix round 1 of 2"
    pulse     shows data.pulse (agent graph), idle after 30s
    kindstack caption, items: [{ label, total, tokens?, segs: [{ k: kind, s: seconds, text: "1 min 10 s" }] }]: one stacked bar per agent,
              the biggest slices carry their kind word, three detail lines under it, one shared legend (auto frame `time-by-kind`)
    sinks     caption, items: [{ k: kind, pct, text }], notes?: kinds ranked by share of all agent time, then the longest stretches as sentences
              (auto frame `time-sinks`; tokens in `text` are estimates: split by time share)
    repeats   caption, cols: [agent names], rows: [{ label: file, cells: [n per column], note? }], notes?: a heat matrix (numbered columns
              with a key below) and sentences about commands re-run, retries, same-kind tasks (auto frame `repeats`)
    hints     caption, items: [{ text, evidence, rule }]: up to 4 cards, each with the number behind it and the setting that fired it (auto frame `improve`)
    image     src (scene-relative path or data:image), caption?      html   html (sanitised: text, basic tags, inline svg, https links)

Unknown type: a quiet "unsupported" tile.

## Behaviour

- The grid follows the window aspect (re-planned on resize, debounced): portrait (< 0.8, a tall pane) 1-2 columns up
  to 6 rows, frames stack, up to 10 visible; square-ish (0.8-1.3) 3 x 4; landscape 4 x 3 (8 visible). `planGrid`
  packs first-fit, grows frames into holes and keeps the grid with the best frame shapes and no holes. 1 frame fills the
  board. A frame never gets less room than its content needs (`minSizeFor`); past the cap: "+N more" (frames still
  queued to appear are not counted).
- Portrait: diagrams lay out top to bottom, timelines in a tall cell run vertically, type is sized from 1.8% of the width.
- Rows, checklists and bars are top-aligned and fitted to their frame (frames/fit.js, fit-logic.mjs): the font is the biggest
  that fits (larger with few items), the spare height is spread between the items, long items wrap to 2 lines, and agent
  rows tighten (1-line wording, then one line each with a thin bar) before they would overflow. A `text`/`now` headline
  shrinks (to 1.5x the text floor) so it and its `sub` stay visible. The mod's "Tool calls per agent" `bars` frame
  (unit `calls`) is never counted in "+N more": the agent rows already carry the numbers.
- Never scrolls or overflows. Type is at least 14px at 960 wide (13px in a portrait pane up to 720 wide), headlines 28px,
  and it grows with the stage.
- Nothing cycles. A frame changes only when its data changes (0.6s cross-fade, or an in-place morph for metric, rings,
  bars, lanes, avatar). At most one frame changes per 600ms; the rest queue. Enter = fade/slide in, leave = fade
  out (400ms) then removed, reorders animate (FLIP). Reduced motion turns all of it into plain swaps.
- A frame that throws shows the unsupported tile; the rest keep going. A faint dot marks a frame unchanged for 90s.
- Empty `frames`: a calm "Nothing on the board yet" state.

## Try it

    node web/builtin/board/seed-board.mjs <sceneDir> busy        # install + seed a fixture, then open the scene
    node scripts/render-board.mjs [fixture...|--all] --out DIR   # 720x1600, 600x1300, 960x540, 1920x1080: PNGs + audits
    node --test web/builtin/board/*.test.mjs

html frames may hold `<a href="https://...">`. The sanitiser keeps only an absolute http(s) href (relative, `//host`, javascript:, data:, mailto: and the like drop the tag and keep the text), forces `target="_blank" rel="noopener noreferrer"` and ignores any author target/rel. The board iframe stays `sandbox="allow-scripts"`, so it cannot open a tab itself: a click is posted to the page as `{type:"panel-open", url}`, and the page (events-client.js) opens it in a new tab, for the board only.
