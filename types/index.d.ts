/**
 * The panel's state contract, v4 (v2 cards/blocks + scenes + stage layout + ask choices). `PanelState` is also the JSON file the mod
 * mirrors to disk and the browser view reads; `PanelRuntime` is the mod's own
 * bookkeeping and never reaches that file. This file is the single source of
 * truth for shapes: the validator, both renderers, the skill examples and the
 * fixture (`web/sample-state.json`) must all agree with it.
 * Text everywhere is plain: no markdown, no HTML.
 */
export type PanelStatus = 'working' | 'waiting' | 'blocked' | 'done'

/** Tone of a callout, a card accent, or a delta/timeline marker. */
export type PanelTone = 'info' | 'warn' | 'ok' | 'danger'

export type StepState = 'todo' | 'doing' | 'done' | 'failed' | 'skipped'
export type TreeMark = 'added' | 'changed' | 'removed' | 'focus'

export type PanelBlock =
  | { kind: 'text'; text: string }
  | { kind: 'list'; items: string[] }
  | { kind: 'table'; head: string[]; rows: string[][] }
  | { kind: 'code'; text: string; lang?: string }
  | { kind: 'callout'; tone: Exclude<PanelTone, 'danger'>; text: string }
  | { kind: 'steps'; items: { text: string; state: StepState; note?: string }[] }
  | { kind: 'kv'; rows: [string, string][] }
  | {
      kind: 'metrics'
      items: { label: string; value: string; delta?: string; tone?: Exclude<PanelTone, 'info'> }[]
    }
  | { kind: 'progress'; value: number; label?: string; note?: string }
  | { kind: 'diff'; text: string; file?: string }
  | { kind: 'tree'; items: { path: string; mark?: TreeMark; note?: string }[] }
  | {
      kind: 'options'
      items: { title: string; summary?: string; pros?: string[]; cons?: string[]; pick?: boolean }[]
    }
  | {
      kind: 'timeline'
      items: { when?: string; text: string; tone?: Exclude<PanelTone, 'info'> }[]
    }
  | { kind: 'sources'; items: { title: string; url?: string; note?: string }[] }
  | { kind: 'bars'; items: { label: string; value: number }[]; unit?: string }
  | { kind: 'tags'; items: string[] }
  | { kind: 'quote'; text: string; by?: string }

export type PanelBlockKind = PanelBlock['kind']

export type PanelCard = {
  /** `[a-z0-9-]{1,24}`: stable key, so one card can be upserted or removed. */
  id: string
  title?: string
  /** Width in the web grid's 3 columns (default 3). The terminal ignores it. */
  span?: 1 | 2 | 3
  /** Render above the core columns, directly under the ask. */
  pin?: boolean
  /** Left accent border on the card. */
  tone?: PanelTone
  blocks: PanelBlock[]
}

/**
 * A sandbox scene: a FOLDER of web files the model writes with its normal file
 * tools; the browser view renders its entry page in a sandboxed iframe and
 * reloads it when a file changes (see the spec's v3 section for the server
 * rules). Nothing but this small record lives in the state file.
 */
export type PanelScene = {
  /** `[a-z0-9-]{1,24}`; its own namespace, not shared with card ids. */
  id: string
  title?: string
  /**
   * Absolute path of the scene folder; it must lie inside the session cwd, an OS
   * temp dir (/tmp, /private/tmp, /var/folders, ...) or ~/.claude. (The shipped
   * fixture uses a path relative to the state file; the server resolves it.)
   */
  dir: string
  /** The page inside `dir` (default `index.html`). A fragment is wrapped by the server. */
  entry?: string
  /** Width in the web grid's 3 columns (default 3). */
  span?: 1 | 2 | 3
  /** Frame height in px, 120..1200 (default 420). */
  height?: number
  /** Render above the other scenes, below pinned cards. */
  pin?: boolean
  /**
   * `card` (default): a framed card in the summary page. `stage`: the scene OWNS the browser
   * viewport (full-bleed under a thin rail; everything else moves into a drawer). A deck is a stage scene.
   */
  layout?: 'card' | 'stage'
  /**
   * Where the scene sits when several main frames share the pane and the stage (the workspace): `big` first (the big tile),
   * `side` last, `auto` (default) in publish order after the board. The scene the person picks in the pane is the big tile.
   */
  slot?: 'big' | 'side' | 'auto'
  /**
   * A scene the mod itself publishes (the `board`): not counted against the scene or stage caps, not removable by the
   * `scene` tool, listed FIRST, the terminal's default hero picture, and always a tile of the workspace.
   */
  builtin?: boolean
  /** What the scene shows, plain text, at most 300 chars. The terminal face and the a11y label. */
  alt: string
  /** Terminal faces: a plain-text art block and/or a PNG file (<= 2 MiB). */
  term?: { art?: string[]; image?: string }
  /** Bumps on every `scene` call for this id; the page also reloads when a file in `dir` changes. */
  rev: number
}

export type PanelTask = { title: string; why: string }

/** Heading overrides for the three core lists (each at most 24 chars). */
export type PanelLabels = { context?: string; done?: string; next?: string }

export type PanelChoice = { id: string; label: string }

export type PanelState = {
  v: 4
  rev: number
  updatedAt: number
  /** `http://127.0.0.1:<port>/<token>/` once the web server is up. */
  url: string | null
  status: PanelStatus
  task: PanelTask | null
  ask: string | null
  /** Clickable answers for `ask` (max 6, label <= 40 chars); a click is delivered to Claude as a panel event. */
  choices: PanelChoice[]
  labels: PanelLabels
  context: string[]
  done: string[]
  next: string[]
  cards: PanelCard[]
  scenes: PanelScene[]
}

/**
 * What the `panel` tool accepts. Each given key replaces its section; `card`
 * upserts one card by id, `card_remove` deletes by id. `canvas` is the
 * deprecated alias of `cards`.
 */
export type PanelInput = {
  task?: { title: string; why?: string }
  status?: PanelStatus
  ask?: string
  /** Buttons shown with the ask; replaced together with it, cleared when ask is cleared. */
  choices?: PanelChoice[]
  labels?: { context?: string; done?: string; next?: string }
  context?: string[]
  done?: string[]
  done_add?: string[]
  next?: string[]
  cards?: PanelCard[]
  card?: PanelCard
  card_remove?: string | string[]
  /**
   * One agent lane: UPSERT-ONLY (replaces nothing else, so workers can call it), keyed by `id` (`[a-z0-9-]{1,24}`).
   * Fields left out keep the lane's value. Lives in the mod's memory (max 12) and in the pulse scene's live/pulse.json.
   */
  lane?: { id: string; label?: string; state?: 'working' | 'testing' | 'waiting' | 'blocked' | 'done'; pct?: number; step?: string; note?: string }
  /** Remove the lane with this id. */
  lane_remove?: string
  canvas?: { id?: string; title?: string; blocks: PanelBlock[] }[]
  /**
   * Put something on the board: UPSERT-ONLY like `lane` (workers may call it). One frame by id, keeping its place
   * (a new id is appended). At most 12 model frames live in the mod's memory (never in PanelState); see `BoardData`.
   */
  frame?: BoardFrameInput
  /** Remove the frame(s) with this id (a removed AUTO frame stays away until `frames_clear`). */
  frame_remove?: string | string[]
  /** Drop every model frame and bring the removed auto frames back. */
  frames_clear?: boolean
  clear?: boolean
}

// ---- the board: the contract between the mod (hooks/board-model.ts) and web/builtin/board -----------------------------

export type BoardSize = 's' | 'm' | 'l' | 'xl'
export type BoardMood = 'idle' | 'thinking' | 'working' | 'happy' | 'alert' | 'sleepy'
export type BoardTone = PanelTone

/** Fields every frame has. `id` is `[a-z0-9-]{1,24}`; `title` at most 40 chars. */
export type BoardBase = { id: string; title?: string; size?: BoardSize }

/** How a node of a `uml` frame is drawn: active pulses (and the edges leaving it flow), done is green, blocked red, todo dashed. */
export type UmlState = 'active' | 'done' | 'blocked' | 'todo'

/** One agent's lane in a `swimlane` frame: its run from `from` to `to` (seconds) cut into stretches of one kind of work. */
export type SwimlaneItem = { label: string; state: 'working' | 'waiting' | 'done'; from: number; to: number; segs: { k: InsightKind; a: number; b: number }[] }

/** One agent's row in a `kindstack` frame: its time split by kind of work. `s` is the slice in seconds (it sets the width), `text` the same time in words. */
export type KindStackItem = { label: string; total: string; tokens?: string; segs: { k: InsightKind; s: number; text: string }[] }
/** One kind of work in a `sinks` frame: its share of all agent time (`pct`) and a plain line saying how long and how many agents. */
export type SinkItem = { k: InsightKind; pct: number; text: string; time?: string; meta?: string }
/** One file in the `repeats` matrix: `cells[i]` is how many times the agent `cols[i]` touched it; `note` says reads and edits in words. */
export type RepeatRow = { label: string; cells: number[]; note?: string }
/** One suggestion in a `hints` frame: what to change, the number that backs it, and the rule that fired. */
export type HintItem = { text: string; evidence: string; rule: string }

/** Where a ticket of a router-kit run is. `unverified`: the worker claims it is done but no verifier PASS backs the claim (never counted as verified). An unknown status of the files is shown as `draft`. */
export type TicketStage = 'ready' | 'building' | 'verifying' | 'fixing' | 'done' | 'unproven' | 'unverified' | 'blocked' | 'draft'
/** The proof of a ticket: `present` when it has a non-empty eval.md; `what` its first criterion; `result` is `pass` only for a current verifier PASS; `evidence` one line of the verdict. A `done` ticket without a passed eval is `unproven`. */
export type TicketEval = { present: boolean; what?: string; result: 'pass' | 'fail' | 'none'; evidence?: string }
/** One ticket in a `tickets` frame. `checks` counts the verdict's checks; `round` / `maxRounds` are the fix rounds used and allowed; `note` says in a line why it is where it is. */
export type TicketItem = {
  id: string
  title: string
  stage: TicketStage
  agent?: string
  checks?: { pass: number; total: number }
  round?: number
  maxRounds?: number
  verdict?: 'PASS' | 'FAIL' | null
  eval?: TicketEval
  note?: string
  dependsOn?: string[]
}
/** The tally of a `tickets` frame: the stages are disjoint (`done` + `unproven` + `unverified` + `blocked` + `inflight` + the queue = `total`). */
export type TicketSummary = { total: number; verified: number; unverified: number; blocked: number; inflight: number; unproven?: number }
/** One check of a `checks` frame: `pass` is null while it has not been run (an eval checklist before the verifier). */
export type CheckItem = { item: string; pass: boolean | null; evidence?: string }

export type BoardFrame = BoardBase &
  (
    | { type: 'text'; text: string; sub?: string }
    /** `text` is the headline (the concrete activity, else the task title). The auto frame adds, all optional: `sub` the task title, `who` the agents' tally, `for` how long the focus agent has been at it, `last` the last thing finished. */
    | { type: 'now'; text?: string; status?: PanelStatus; sub?: string; who?: string; for?: string; last?: string }
    | { type: 'metric'; value: string | number; label?: string; delta?: string; tone?: BoardTone; spark?: number[] }
    | { type: 'rings'; items: { label: string; pct: number; color?: string }[] }
    | { type: 'bars'; items: { label: string; value: number; color?: string }[]; unit?: string }
    | { type: 'line'; series: { label: string; points: number[] }[] }
    /** The checklist frame of a lane adds, optional: `owner` the plain title of the work (shown under the item in progress) and `since` how long the agent has been at it. */
    | { type: 'steps'; items: { t: string; state: 'todo' | 'doing' | 'done' | 'failed' }[]; owner?: string; since?: string }
    | {
        type: 'diagram'
        nodes: { id: string; label: string; tone?: BoardTone }[]
        edges: { from: string; to: string; label?: string }[]
      }
    | { type: 'timeline'; items: { when?: string; text: string; tone?: BoardTone }[] }
    | { type: 'compare'; left: { title: string; items: string[] }; right: { title: string; items: string[] } }
    | { type: 'avatar'; mood: BoardMood; say?: string }
    | { type: 'ask'; q: string; options: string[] }
    | { type: 'lanes' }
    | { type: 'pulse' }
    | { type: 'image'; src: string; caption?: string }
    | { type: 'html'; html: string }
    | { type: 'uml'; code: string; highlight?: Record<string, UmlState> }
    /** What every agent is doing right now (kind of work, files): drawn from `data.lanes`, no payload of its own. */
    | { type: 'doing' }
    /** One lane per agent over the session, bars colored by kind of work; times are seconds from the session's first start. */
    | { type: 'swimlane'; items: SwimlaneItem[] }
    /** Time per agent as one stacked bar split by kind of work (auto id `time-by-kind`). `caption` says in plain words what the bars mean. */
    | { type: 'kindstack'; caption?: string; foot?: string; items: KindStackItem[] }
    /** Where the time went across agents, ranked by kind, plus the longest stretches in sentences (auto id `time-sinks`). */
    | { type: 'sinks'; caption?: string; foot?: string; items: SinkItem[]; notes?: string[] }
    /** Repeated work: a file x agent matrix of touches plus sentences about commands, retries and repeated tasks (auto id `repeats`). */
    | { type: 'repeats'; caption?: string; foot?: string; cols: string[]; rows: RepeatRow[]; notes?: string[] }
    /** Evidence-backed suggestions, each with its number and the rule that fired (auto id `improve`). */
    | { type: 'hints'; caption?: string; foot?: string; items: HintItem[] }
    /** The tickets of a router-kit run read from `.router/` (auto id `tickets`, only with 2+ tickets): stage, checks, fix rounds, verdict; most relevant first. */
    | { type: 'tickets'; summary: TicketSummary; items: TicketItem[] }
    /** The verdict checks of the single ticket of a router-kit run (auto id `checks`): pass / fail / not run, with evidence. */
    | { type: 'checks'; result: 'PASS' | 'FAIL' | null; round: number; maxRounds: number; items: CheckItem[] }
    /** A freeform visual asset chosen by information shape (sankey, treemap, network, radar, ...): `kind` + that asset's own `data` (see skills/panel-guide/references/assets.md). */
    | { type: 'viz'; kind: string; data: Record<string, unknown>; caption?: string }
  )

export type BoardFrameType = BoardFrame['type']
/** What the model sends: the same shape (the validator refuses unknown keys, naming the field). */
export type BoardFrameInput = BoardFrame

/** What KIND of work an agent does (hooks/work-kinds.ts): from the tool and the redacted target, never a content. `thinking`: a running agent with no call for a while; `waiting` / `done`: its status. Unknown work is `working`. */
export type InsightKind = 'ui' | 'logic' | 'tests' | 'visual' | 'docs' | 'research' | 'reading' | 'delegating' | 'working' | 'thinking' | 'waiting' | 'done'

/**
 * What the board shows of one agent besides its name and step, computed by the mod from the pulse (tool names and short
 * redacted targets only; no command, no output). The page recomputes `thinking` from `lastCallAt` between two writes.
 */
export type AgentInsight = {
  kind: InsightKind
  /** The sentence of the row: "Writing UI · board.css, lanes.js", "Running tests", "Checking visually · reading screenshot". */
  headline: string
  /** One letter per time bucket, oldest first, a kind's letter (KIND_META) or `.` for nothing. */
  strip: string
  /** What share of its last minutes went to which kind, largest first; the percentages add up to 100 (empty while it has done nothing). */
  mix: { kind: InsightKind; pct: number }[]
  /** Basenames the agent touched, newest first (at most 3). */
  files: string[]
  /** Its last actions as plain phrases ("read 4 files", "edited board.js", "ran tests"), newest first (at most 3). */
  feed: string[]
  /** Tokens its model requests used (fresh input + cache writes + output; cache reads not counted); null while unknown. */
  tokens: number | null
  /** When its last tool call started (epoch ms). */
  lastCallAt: number
  /** A tool call is in flight. */
  isBusy: boolean
  /** The main loop (the session), not a subagent. */
  isMain: boolean
}

/** One agent lane as the board gets it (the Pulse lane plus the node it belongs to, `loop`). */
export type BoardLane = {
  id: string
  label: string
  state: 'working' | 'testing' | 'waiting' | 'blocked' | 'done'
  pct: number | null
  step: string
  note: string
  /** What the agent is after ('' when it never said). */
  goal: string
  /** The agent's checklist (definition of done); [] when none. A lane with one also gets a `steps` frame titled with the goal. */
  dod: { t: string; state: 'todo' | 'doing' | 'done' | 'failed' }[]
  /** Index into `dod` of the item in progress, or null. */
  at: number | null
  /** The Claude Code session this lane stands for: its row opens that session's transcript. */
  session?: string
  startedAt: number
  updatedAt: number
  by: string
  loop?: string | null
  /** Tool calls the agent made so far (agent rows only): a small count, never a command. */
  calls?: number
  /** What the agent is doing (agent rows only), see AgentInsight. */
  insight?: AgentInsight
}

/**
 * `live/data.json` of the builtin `board` scene, written by the mod (atomically, at most 2 a second, only when it
 * changed). `frames` is the final order: `ask` first when a question is pending, then the model's frames in their order,
 * then the other auto frames (`now`, `lanes`, `pulse`). `pulse` is what `live/pulse.json` holds (absent while the pulse
 * feed is off); `lanes` the agent lanes; `now` the task title and status (title '' while there is no task).
 */
export type BoardData = {
  frames: BoardFrame[]
  pulse?: unknown
  lanes: BoardLane[]
  now: { title: string; status: PanelStatus }
  updatedAt: number
}

/**
 * What the `scene` tool accepts: upsert one scene (re-sending it re-publishes
 * the folder), remove one, or clear all.
 */
export type SceneInput =
  | (Omit<PanelScene, 'rev' | 'dir'> & {
      /** Exactly one of `dir`, `html` (a page or fragment, <= 256 KB: the fastest way) or `files` ({path: text}, <= 24 files / 1 MB, text types only). */
      dir?: string
      html?: string
      files?: Record<string, string>
      /** Any JSON (<= 64 KB serialized) written to `live/data.json` before the screenshot; the page reads it with `panel.data(cb)`. */
      data?: unknown
      /** Take a headless-Chrome screenshot after publishing (default true when Chrome exists); the PNG path and console errors come back in the tool result. */
      shot?: boolean
      /** Location hash to open for the shot, e.g. `#/3` for slide 3 of a deck. */
      shot_at?: string
      remove?: undefined
      clear?: undefined
    })
  /** `{ id, data }` alone: rewrite `live/data.json` of a published scene; no new revision, no reload. */
  | { id: string; data: unknown; remove?: undefined; clear?: undefined }
  | { remove: string; clear?: undefined }
  | { clear: true; remove?: undefined }

export type PanelRuntime = {
  /** Absolute path of the mirrored state file, once the session has named it. */
  stateFile: string | null
  /** True once the pane was opened by the first tool call (never reopened). */
  isPaneOpened: boolean
  /** Unguessable URL token, minted once per session so an open browser tab survives mod reloads. */
  token: string | null
  /** Last port the web server bound; passed back as `--port` after a reload. */
  lastPort: number | null
  /** Highest event n already delivered to Claude. */
  eventCursor: number
  /** Clock reading at which the live module instance started the Agents tile's drill-down loop; an older instance's loop stops when it differs. */
  detailOwner?: number
  /** The model removed the `agents-info` scene this session: the mod does not put it back. */
  isCrewOff?: boolean
  /** `/panel live off` for this session; absent (or false): the live terminal view is on. */
  isLiveOff?: boolean
  /** `/panel pulse on|off` for this session (true: off); absent: never said, the `PANEL_PULSE` env decides (default on). */
  isPulseOff?: boolean
  /** The scene the person picked with the terminal pane's switcher as the hero picture; absent: the default hero. */
  heroId?: string
}

/** What the model posted to the board (frames, removed auto frames, agent lanes); kept in the session state so a mod reload keeps it. Stored values are re-validated on load. */
export type PanelBoardKeep = {
  frames: unknown[]
  removedAuto: string[]
  lanes: unknown[]
  /** The forms of the last panel updates (anti-repetition, ./hooks/variety.ts); absent in a value stored before it existed. */
  recent?: string[]
}

declare module 'claude-code' {
  interface PluginState {
    panel: {
      state: Shaped<PanelState>
      runtime: Shaped<PanelRuntime>
      board: Shaped<PanelBoardKeep>
    }
  }
}
