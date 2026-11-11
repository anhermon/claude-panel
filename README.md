# panel

A Claude Code mod that keeps a live panel beside the chat. The model (or you) puts things on it: what the task is and why,
context, what is done and next, cards, charts, diagrams, and small sandboxed HTML/JS "scenes". While subagents run, the
panel also draws a board of them (who does what, how long, what went wrong). Everything is mirrored to a browser view on
your own machine.

## Install

At the prompt of a terminal Claude Code session:

```
/plugin install panel --marketplace anhermon/claude-panel
```

Answer `y` to "Add marketplace?", choose a scope, and set the options below if you want to change a default. From a shell:

```
claude plugin install panel --marketplace anhermon/claude-panel
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with
`anhermon/claude-panel`, then Add plugin.

Requirements: Node.js 22 or newer on `PATH` (the browser view is a small Node server the mod starts with `node`). Nothing
is installed from npm; the page libraries (three, d3, mermaid, chart.js, ...) are vendored under `web/kit` with their
licenses (`web/kit/LICENSES.md`).

## Use it

| Command | Does |
| --- | --- |
| `/panel` | Shows the pane and prints the browser URL. |
| `/panel open [scene-id]` | Opens the browser view (or one scene) in your browser. |
| `/panel global` | Opens the [global view](#global-view): every Claude Code session of the last 48 hours on one read-only page. |
| `/panel live on\|off\|status` | A live preview of the stage in the terminal pane (needs Chrome, see Platforms). |
| `/panel pulse on\|off\|status` | The ambient pulse of agent activity. `PANEL_PULSE=off` in the environment turns it off. |
| `/panel watch <folder>` | Follow a router-kit run in another folder than the session's. |

The model gets two tools:

- `mcp__panel__panel`: puts one frame or card on the board (text, metric, bars, line, steps, diagram, timeline, compare, ask, viz, ...) or sets the task, status, context, done and next. Agents post a `lane` to show their own progress; a lane for another Claude Code session can pass `session: <id>` so its row opens that session's transcript.
- `mcp__panel__scene`: publishes a sandboxed HTML/JS folder (or inline `html`) as a scene, and takes a headless screenshot of it for the model to check.

The `panel:panel-guide` skill (`skills/panel-guide`) tells the model how to choose a form and write a scene.

With the mod active, Claude uses the panel on its own for work that needs more than a few tool calls: task + why first,
then forms that fit the work and measured evidence. Short questions and acknowledgements stay in chat. Prompt context
suggests forms from the current job and generic project markers. A local history of the last eight sessions helps avoid
forms used in at least three of the last five sessions; among equally fitting forms, the suggestions rotate by session. Builds and operations
can use test results, debugging hypotheses, research sources, decisions a decision matrix, reviews a risk grid, and long
sessions measured limits. If Claude has not posted a task after six non-panel tool calls (task bookkeeping such as ToolSearch or TodoWrite does not count), the mod fills the empty task from
the first sentence of the request, with private text scrubbed. Claude can replace that starting point at any time.

The board adds a small **Limits** frame (id `limits`, viz kind `limits`) whenever readings exist. It groups Claude, Codex, AGY Gemini shared and the AGY Claude/GPT pool with 5-hour and weekly
windows, reset countdowns and freshness, followed by context fill and formatted cost. Live Claude usage takes precedence.
Optional local delegation-kit quotas refresh in the background every 120 seconds; missing tools or failed reads stay quiet.
Snapshots older than 30 minutes are marked stale. Bars turn amber at 60% and red at 85%. Without readings it draws nothing.
Replace it with a frame of the same id, or hide it with `frame_remove: "limits"`; `frames_clear` restores it.

## Global view

`/panel global` prints and opens `http://127.0.0.1:<port>/<token>/global/`, a second, read-only page beside the per-session panel (which is unchanged). It covers every Claude Code session on this machine that wrote in the last 48 hours, ended ones included:

- **Needs you** at the top: one item per decision or question across all sessions, with a bold title, one line on why, and a link to its source when there is one. Items the session board itself lists (its `needs-you`/decision html frames, its `ask`) are certain; items the page infers are labelled **May**: an `AskUserQuestion` with no answer, a tool call with no answer for 20 s, a last reply that ends with a question, an API error, a session registered busy but quiet for 5 minutes. Inferred items come from live sessions only.
- **Jira**: sessions grouped by ticket key, taken from the git branch (`feature/<KEY>-...`) and the prompts. Only project prefixes seen in real `atlassian.net/browse/` links count (DEV, CHR, RH, INC, plus any a transcript shows); links use `https://dealhub.atlassian.net/browse/<KEY>`. `INT-*` keys are internal and get no link. Nothing calls the Jira API.
- **Sessions**: a card each (at most 40, waiting first, then busy, then the most recent): title, project and branch, state (busy, may be waiting, idle, ended), last activity, the current task and its progress (the last `TodoWrite`, `TaskCreate`/`TaskUpdate` or checklist state, else the board's steps), the subagents and what each is doing, and the latest PR, Jira and artifact links. A card expands for the last prompt and the details.

How it works: the server computes the answer only when the page asks (every 4 s, cached for about 2 s). It lists `~/.claude/projects/*/*.jsonl` with `readdir` + `stat`, reads the last 512 KiB of each transcript (then only appended bytes), checks liveness with the `~/.claude/sessions/<pid>.json` registry and `ps` (never the `*.key` files), and reads each session's board from `$TMPDIR/claude-panel/` while that file is within the window. Every text is masked for secrets, cut, never sent to a model, and drawn as plain text; links are shown only as absolute `http(s)` URLs that carry no secret. The route is under the same token and `Host` check as the rest of the server, with its own content-security policy (no inline script). It is not a daemon: with no panel server running there is no global view.

## Options (`userConfig`)

All optional; the defaults are in `.claude-plugin/plugin.json`.

| Key | Title | Type | Default | What it does |
| --- | --- | --- | --- | --- |
| `proactive` | Use the panel proactively | boolean | `true` | Enable automatic panel guidance, contextual form suggestions (and, after a task-only panel call, one nudge to add a form that fits), history recording and the task safety net. `false` leaves panel use on request. |
| `autoTaskAfterCalls` | Calls before starting the task | number | `6` | Fill an empty task after this many non-panel tool calls following a work prompt. `0` disables this safety net. |
| `doneRowMinutes` | Finished agent row (minutes) | number | `10` | How long a finished agent keeps its row on the board. |
| `limitsShowPct` | Show limits from (%) | number | `0` | Show measured limits when any quota window or context fill reaches this percentage. `0` always shows available readings; `101` never shows the frame. |
| `quotaEveryS` | Quota refresh (seconds) | number | `120` | Interval for local provider quota reads; `0` disables them. |
| `dodFramesMax` | Checklist frames | number | `3` | At most this many agent checklist frames on the board at once. |
| `stripRoutingSuffix` | Strip routing note from agent names | boolean | `true` | Drop a trailing (sonnet/high) style note from an agent's name on the board. |
| `goalLabels` | Goal line labels | string | `goal,objective` | Comma-separated labels of the brief line that states an agent's goal. |
| `ticketLabels` | Ticket line labels | string | `ticket` | Comma-separated labels of the brief line that names an agent's ticket. |
| `insightMinSeconds` | Insight minimum (seconds) | number | `30` | The workflow-insight frames wait for this many seconds of agent time before they say anything. |
| `sessionsFrame` | Other sessions frame | boolean | `true` | Draw a frame listing the other Claude Code sessions running on this machine (name, state, project, current task). |
| `repeatMin` | Repeat: times | number | `4` | The same file touched or command run this many times is shown as repeated work. |
| `retryMin` | Retry: times | number | `2` | A command run again right after failing this many times is shown as a retry. |
| `similarMin` | Same task: agents | number | `3` | This many agents started with the same kind of task are shown as repeated work. |
| `hintTestsPct` | Hint: tests share (%) | number | `35` | Suggest running fewer tests when tests and checks take at least this share of agent time. |
| `hintReadingPct` | Hint: reading share (%) | number | `30` | Suggest a file map when agents spend at least this share of their time reading before their first edit. |
| `hintSharedFiles` | Hint: shared files | number | `3` | Suggest putting files in the brief when at least this many files were each read by several agents. |
| `hintSharedAgents` | Hint: agents per shared file | number | `3` | How many agents must read the same file for it to count as shared. |
| `hintRetries` | Hint: retries | number | `3` | Suggest checking the cause when commands were re-run right after failing this many times in all. |

## Optional integrations

None is required; a missing one simply shows nothing.

- **delegation-kit** (codex/agy runs started by another plugin): the panel reads `<session cwd>/.router/runs/*.json`, else delegation-kit's ledger under `$DELEGATION_KIT_CACHE_DIR` (older name `$DELEGATION_KIT_CACHE`, default `~/.cache/delegation-kit`), and Codex rollouts under `$CODEX_HOME` (default `~/.codex`). Those runs then appear as agents. Without them there is nothing to read and no error.
- **router-kit**: a `.router/` folder (`tickets/*/ticket.json`, `events.jsonl`) in the session's working directory is drawn as ticket and check frames.

## Platforms

- **macOS**: developed and tested here.
- **Linux**: supported by reading the code, not run by the author: the browser opens with `xdg-open`, Chrome is found on `PATH` (`google-chrome`, `google-chrome-stable`, `chromium`, `chromium-browser`, `chrome`), and the process helpers (`ps -o lstart=`, `mv`, `openssl`, POSIX process groups) are standard on Linux.
- **Windows**: not supported (the mod relies on POSIX tools and process groups). WSL is untested.
- **Chrome** is only needed for scene screenshots and `/panel live`. Set `CHROME=/path/to/chrome` if it is not found. Without Chrome the panel, the browser view and every other feature still work; a screenshot reports "chrome not found".
- If no browser can be opened (no `open`/`xdg-open`), `/panel open` prints the URL with "could not open a browser".

Other environment variables: `CLAUDE_PANEL_PORT` (first port to try, default 4717), `TMPDIR` (where state goes, default `/tmp`).

## Privacy

- The browser view is a Node server bound to `127.0.0.1` only. Every route sits under a random 128-bit token (`http://127.0.0.1:<port>/<token>/`), anything else is a 404, and a `Host` header other than `127.0.0.1:<port>` or `localhost:<port>` is refused (DNS rebinding). The token is kept in Claude Code's per-project store so the same project reopens the same link. The server only reads; the one write path is the page's `POST /event`, which sends a click back to the model.
- State is written under `$TMPDIR/claude-panel/` (default `/tmp/claude-panel/`): per-session state files, board, pulse, live-frame and inline-scene folders, and screenshots. The OS cleans temp folders; nothing is written to your project or home folder by the panel itself.
- Transcript text shown on the board (agent details) is passed through a redaction step first (home folders, key/token shapes, passwords in URLs), but treat the board as showing your session's work.
- Form history uses one per-project store key (`panel.history`): generic jobs, form names, timestamps and opaque session keys only. Prompts, directory paths and branch names are not saved in that history.
- Nothing is sent to any remote service by the mod. Scenes are model-written code: they run in a sandboxed iframe with a strict content-security policy, but with the CDN allow-list on (`web/scene-files.mjs`) a scene may load scripts from cdnjs, jsdelivr or unpkg in your browser. Do not put secrets in a scene folder.
- The global view (`/panel global`) reads every session's transcript tail (512 KiB), subagent transcripts and board files, with the same masking and no write path; see [Global view](#global-view).
- The board's `Other sessions` frame (`sessionsFrame` option, on by default) is drawn from the `~/.claude/sessions` registry and `ps`, plus the last 128 KiB of each such session's transcript (title, branch, and what it is doing now: the tool call in flight, else the first sentence of its latest reply, else its last prompt; redacted and cut to 80 characters). Sessions that may be waiting for you come first, and clicking a card opens that session's transcript in the Agents tile. It is not sent to the model; turn it off with `sessionsFrame: false`.

## Develop and test

```
node --test web/builtin/imports.test.mjs web/builtin/agents-info/*.test.mjs web/builtin/board/*.test.mjs
node --test web/                  # page and server tests (some skip without Chrome)
claude plugin test .              # hooks tests (tests/*.test.ts)
claude plugin validate .
```

`claude plugin eval` runs the model-behaviour cases in `evals/*/case.yaml` (their outputs go to `evals/results/`, which is not committed).
`.claude-plugin/types/` is written by the Claude Code engine when the mod loads and is not committed.
`scripts/sync-sessions.sh` is the author's private helper and is not part of the repository.

Code rules: at most 800 lines per code file (generated fixtures excepted), no magic numbers or strings (named constants, or an
option/env var), tests beside the code. Tests that need secret-shaped strings build them from fragments at run time so
scanners do not flag the repository.

## License

MIT, see [LICENSE](LICENSE).
