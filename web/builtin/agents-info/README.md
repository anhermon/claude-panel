# Agents scene (`agents-info`)

The state of the team on one tile, and the ONLY place agent state is shown: ONE family of characters everywhere (a compact hero for the
team, a card per agent under it with a callout on hover or click, a face on every list row and ticker line), plus a ticker of live status
changes and a list with progress for every agent, the main session first as "Me". Click a row and its detail opens in the tile (see Drill-down).

**One component, no duplicates.** While this tile is registered the board does not draw its own agent rows (`lanes`), `now-doing`,
`bars`, `pipeline` or `activity-timeline` frames (`BoardInput.hasAgentsTile`, set by `agentsInfoLive()`; the list below IS that timeline); its checklist (`dod-*`) frames,
`delegation`, the insight frames and everything the model posts stay. No tile (no source folder, removed by the model, a plain chat):
the board shows its agent rows again, so agents are always visible somewhere. That is the single rule.

It is **not a command**. The mod registers it by itself the first time an agent exists (a lane an agent posted, or a sub-agent
loop) and writes its data; a plain chat never has it. The model can take it away with `scene {remove: "agents-info"}` (the mod then
keeps it away for the session). It is a builtin stage scene, so the workspace shows it as a tile beside the board.

## Data: `live/data.json` (written by `hooks/agents-info-host.ts`, derived by `hooks/agents-info-data.ts`)

```
{ overall: working|waiting|blocked|done, mainKind: string|null, updatedAt,
  agents: [{ id, isMain, loop, name, short, state: working|testing|waiting|blocked|done, pct: 0..100|null, startedAt, endedAt|null, tokens|null,
             kind, kindLabel, kindColor "#rrggbb", kindGlyph, headline, files: [basename...],
             role?: router|worker|verifier|codex-worker|watchdog|qa|merger|null, ticket?: { id, stage, text "verified 4/4", title?, harness? }|null,
             proof?: { eval, what, result: pass|fail|none }|null,   // a delegated ticket's eval (proof-logic.mjs); null = not a ticket, never flagged
             agentType?: string|null,   // the subagent type EXACTLY as the engine names it, namespace kept: "savvy-flow:savvy-careful", "general-purpose", "Explore"; null = unknown (the main session)
             calls?, harness?, model?, effort?,
             notStarted?: true, note? }],   // notStarted: a codex attempt that never ran (deferred by the load governor, refused): state waiting, hollow bar, never "done"; note = "Not started: machine busy (load governor)" (+ "retried N times")   // model / effort: what it was started with (its meta file next to the transcript; an inherited effort is "high*"); absent = unknown, never invented
  events: [{ id, t, agent, from, to, kind: spawn|handoff|state|work|progress, text }] }   // the newest 20, ids only grow
```

`isMain` is the session itself ("Me": first row, no satellite, left out of the counts and the ticker); `loop` is the pulse's id of the
agent (the transcript file name). Nothing beyond what the board shows (a state, a percentage, a kind of work, a headline, file basenames, numbers). `events` come from
the pure `diffAgents(prev, next)`: a new agent gives `main -> X` and `X started`; a state flip `X testing` / `X done · 26 min`; a
kind change `X · Tests`; progress every 5 points. The first look after a mod load announces nothing.

## Behaviour

- Characters: one per HARNESS (`avatar-harness.mjs`, the only registry): claude = the Claude Code mascot (12x8 body, two arm stubs, four
  legs, 1x2 eyes, #D97757), codex = a small blue robot (#5B7BE8: cloud head, dark visor, cyan eyes that close to arcs when sleepy, round body with a ">_" on the chest), agy = a wide block with ears (#7C6CF2), anything else = a neutral
  cube in a hue hashed from the harness name (no code change needed for a new harness). The harness comes from an explicit `harness` field
  (agent, else its router ticket), else the model id (claude/sonnet/haiku/opus, gpt/codex/o-series, gemini/agy), else the worker role
  (`codex-worker`, `agy-worker`), else claude. Same proportions everywhere. The body colour is the harness's and NEVER changes with state;
  state shows in the face (blink, `> <` squint, wide eyes, `x`), the limbs (legs step while working, arms up when done), an accessory
  badge (dots, list, zzz, check, "!"), a thin progress ring and a chip (colour AND word).
- Rendering: ONE shared WebGL renderer (`avatar3d.js`, a detached canvas) paints a snapshot into every avatar's own 2D canvas; the hero
  repaints every frame, small ones at a low rate. Without WebGL (or after a context loss) the same character is drawn flat (`mini-face.js`).
  Reduced motion: still poses, no one-shot animations. Rendering pauses while the document is hidden.
- New events (id above the last seen; a reload replays nothing) play ONE-SHOT animations (`event-fx.mjs`, `fx-layer.js`): spawn pop and
  sparkle, a beam from the hero to the worker on a handoff, error shake + flash + "!", done check burst, blocked amber pulse; a ticker line
  (with the task TITLE, never an id) fades after 9 s. A failure has no host event: the page notices a figure turning "failed".
- Cards: a grid of up to ~6 labelled cards, the rest collapse into "+N". Hover or click opens a callout (title, state, step, time, tool
  calls, tokens, harness line "Codex - gpt-6.1-sol - high", role, last three events, Open); click again, leave or Escape closes it.
  Titles come from `title-of.mjs` (ticket title, else the plain label, else the role); an id appears only in a tooltip.
- Rows: click / Enter opens the detail (not for "Me"). **The list is a gantt** (`gantt-logic.mjs` pure, `gantt-view.js` DOM, `gantt.css`): each row is
  [avatar, title, step, state chip, kind | a track] on ONE shared time axis. The bar runs from the agent's start to its end (to now while it runs: a
  pulsing dashed head; a check or cross at the end of a done / failed one; waiting and blocked get an amber / red outline), split by kind of work
  with the same kind colours as the board (data: `agents[].segs` `[{k,a,b}]` ms, from `segmentsOfLoop`, and `kinds` `{k:{label,color,glyph}}` from KIND_META). The
  window comes from the SUBAGENTS (earliest start, small padding, to now; at most 6 h; 30 min with none), never from the session: the main row is
  clipped to it and shows a left chevron "started 24 h 37 min ago" (so does any agent older than the cap). A toggle "Fit agents | Last hour | Whole session"
  (page memory only) changes it. A bar is at least `MIN_BAR_PX` wide and starts with a dot. Ticks are clock times above 1 h, "-N min" below. Hover (`title`)
  says "started 12:31 · ended 12:48 · 17 min · Tests 40%, Logic 35%". The list part of the row is ~38% and the track the rest from 600 px of list width
  (container query); below that the track sits under the text, full width. Hover highlights the row. A bar is at least 12 px; one narrower than 64 px has its duration written beside it. When every subagent has finished, "Fit agents" ends at the last end (not now) and the axis ends in a clock time.
  **Every row, tile, callout and bar tooltip names the agent**: its TYPE verbatim (`ident-logic.mjs`: a name too long for the place is cut in the middle, the full one is in the tooltip) and `model:effort` next to it (`ident-view.js`); a part nobody knows is left out.
- Wide pane: hero + cards left, list right; otherwise stacked. Hero 150px (96px under 420px). The legend names only the kinds present.

## Drill-down (`live/detail.json`, `hooks/agent-detail*.ts`, `detail-*.js`)

Opening a row shows, inside the tile, Back + tabs (Escape also goes back); the list is hidden meanwhile and the avatar shrinks to a strip
in a narrow pane. The page cannot write files, so it asks the mod with events: `panel.emit('agent', {id, pages})` when opening, again
every 15 s while open (a request counts for 45 s) and when "Show earlier entries" raises `pages`; `panel.emit('agent-close', {})` on
Back / Escape. These two events are for the mod: they are not delivered to the model. The mod then reads the END of the agent's
transcript (`tail -c`, 512 KiB per page up to 4 MiB; `<session>.jsonl` for "Me", `<session>/subagents/agent-<id>.jsonl` otherwise),
builds the detail (`agent-detail.ts`) and writes `live/detail.json` (only while a request is fresh; otherwise it holds a stub
`{"v":1}`), which the page polls once a second. `live/data.json` stays small.

**In the terminal pane** (a screencast Image: no mouse reaches the page) the pane draws a Button row under the picture instead
(`hooks/agent-controls.ts`, `agentsInfoControls()`): one button per agent that has a row (label = its short name, at most 12 cells, the main session first, at most 6 with a dim `+N` for
the rest; hotkeys 1-6) and, while a detail is open, `Progress` `Transcript` `Metrics` `Struggles` `Back` (hotkeys p t m s x; the open agent and tab carry a `▸`).
A press becomes a control line `{cmd:'host', scene:'agents-info', name, data}` for `web/live.mjs`, which calls `PanelWorkspace.hostCommand(scene, name, data)` in the
workspace page (`web/builtin/workspace/workspace.js`), which posts a `panel-host` message to the tile's iframe. This page listens with `panel.on`:
`open-agent {id}` (same as a click on the row), `tab {name}` (ignored for a tab that is not there) and `close` (same as Back). They then take the usual path:
`panel.emit('agent', ...)` goes through the workspace page's forward to `POST /event`, and the mod writes `live/detail.json`. No row, no tile, or no live picture: no buttons.
`scripts/render-pane-agents.mjs` drives the workspace page with those three messages (and the browser page with a real click) and writes screenshots.

- **Transcript**: the brief the agent was given (for "Me", the latest message to it), then entries oldest to newest: what it said,
  each tool call with a short label (file basename, program, first line of a command) and how long it took, errors in red with the first
  line of the message. Capped at 40 entries per page. Everything is scrubbed first (`transcript-redact.ts`: secrets, tokens, URL
  passwords, home folders, control characters, long blobs); thinking is never read, and a tool's output is reduced in the mod to a few scrubbed
  lines (exit code, first and last lines) that only the progress logic uses: they never reach the page.
- **Progress** (opens first; a red dot on the tab while something is open): what the agent is doing NOW (the latest sentence it said, the call in flight
  and how long, or "no activity for 4 min, last: ran tests"); its phases as labelled segments over its real time (`read files 2:10`,
  `edit crew-view.js 3:40`, `tests 1:05`; narrow panes show the times in the bar and the names in the list under it; no tool calls: it says why, no
  ticks); the checklist (the dod the agent POSTED, else the numbered items of its brief with marks that are evidence only: done when a named
  file was written or a named command exited 0, "in progress" when one of the last calls touched it, otherwise "not shown yet"); what is done
  (files by folder, the LAST result of each check, images read); up to 5 decisions in the agent's own words ("extracted from the agent's own
  text"); issues (failed commands with the first meaningful error line and open/resolved, a question waiting, an edit to a file the brief
  forbids). Logic: `hooks/agent-progress.ts` + `agent-plan.ts` + `agent-evidence.ts` (harness-neutral: `act`, `path`, `cmd`, `exit`, `out` of the
  neutral entry, `transcript-parse.ts`), page: `detail-progress.js` + `detail-progress-logic.mjs`.
- **Metrics**: run time, tool calls, tokens, failed calls; the same phase bar under "Run" with where the run stands (step, checklist count,
  decisions, issues, struggles); active vs idle; the token curve; the tool mix; files read/edited with counts. Each has a plain caption and unit.
- **Struggles** (`hooks/agent-struggles.ts`): what went wrong with the evidence, not counts: failing loops (the same command failing again, with the
  first meaningful error line), edit-test cycles ("list-view.js edited 11 times while `node --test agents-info` failed 4 times: expected T43,
  got Fix lanes"), slow calls (>= 1 min, a parallel batch is one), idle gaps (>= 2 min), wrong turns (a refused tool, a rewrite, work thrown
  away). Each row: title, one quote, when, count, outcome chip (resolved / still open), a next step only when the evidence gives one. Edits with no
  failure are NOT a struggle: a muted "Not a problem" line ("Iterating on list-view.js (11 edits, no failures)"). The tab badge counts only open or
  recent real problems; the headline is one sentence ("1 test failure still open, 2 resolved; 3 slow calls").

What is NOT measured, and says so: a number the data does not hold is `null` ("not measured"). The transcript view covers only the part
read (the latest, bigger on "Show earlier"); the token curve covers that part; kinds, tool mix, files, errors and retries cover the run
since the mod loaded. If the transcript file is not found (it is located with `find` under `~/.claude/projects`), the tab says so and
Metrics still work. Scrubbing is pattern matching, best effort.

## Files

`index.html`, `agents-info.css`, `agents-info.js` (main) / `agents-info-logic.mjs` (data, formatting) / `avatar-model.mjs` (states, poses,
crew grid) / `avatar-harness.mjs` (harness registry) / `mascot-grid.mjs` (character tables) / `avatar-clay.js` (3D character) /
`avatar3d.js` (the shared renderer) / `mini-face.js` (flat twin) / `avatar-set.js` (one avatar view) / `avatar-props.js` (state badges) /
`event-fx.mjs` + `fx-layer.js` (one-shot animations, beam) / `title-of.mjs` (plain titles) / `crew-view.js` (cards, callout) /
`list-view.js` / `ident-logic.mjs` + `ident-view.js` (type and model:effort labels) / `gantt-logic.mjs` + `gantt-view.js` + `gantt.css` (the list's time axis and bars) / `ticker.js` / `dom.js`; the drill-down: `detail-view.js` (header, tabs, polling, requests) / `detail-transcript.js` /
`detail-metrics.js` / `detail-progress.js` / `detail-struggles.js` / `detail-progress-logic.mjs` (normalize, phase segments, groups) / `detail-logic.mjs` (normalize, formatting, curve) / `detail-run-logic.mjs` + `detail-run.js` (a codex run's detail without a transcript: `live/detail.json` `run`, from `hooks/agent-detail-run.ts`) / `detail.css` + `detail-progress.css`; `fixtures/detail-real-*.json` are built from two real finished sub-agent transcripts (`tests/fixtures/transcripts`) by `node scripts/make-agents-detail-fixtures.mjs`; `host-messages.test.mjs` pins the host message names to `hooks/agent-controls.ts`; `fixtures/*.json` and the `*.test.mjs` are for development and are not copied to the pane.

## Check it

`node --test --test-concurrency=1 web/builtin/agents-info/*.test.mjs` (pure logic; the glob, not the directory), `claude plugin test .` (transcript parse/redact, detail, host flow,
the board rule) and
`node scripts/render-agents-info.mjs [--fixture crew] [--out DIR]`: renders at 1280x900, 720x1280 and 360x730 (`--sizes` to change; `--fixture harness` also writes `-showcase.png`, every character big) with software GL and
with WebGL off, counts console errors, checks the rows, satellites, ticker and selection, then opens a detail (`fixtures/detail.json`),
captures every tab, checks nothing overflows or scrolls the page, and that Back, Escape, "Show earlier entries" and the heartbeat emit
what the mod expects; look at the PNGs it prints.
