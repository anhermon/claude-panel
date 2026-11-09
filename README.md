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
| `/panel live on\|off\|status` | A live preview of the stage in the terminal pane (needs Chrome, see Platforms). |
| `/panel pulse on\|off\|status` | The ambient pulse of agent activity. `PANEL_PULSE=off` in the environment turns it off. |
| `/panel watch <folder>` | Follow a router-kit run in another folder than the session's. |

The model gets two tools:

- `mcp__panel__panel`: puts one frame or card on the board (text, metric, bars, line, steps, diagram, timeline, compare, ask, viz, ...) or sets the task, status, context, done and next. Agents post a `lane` to show their own progress.
- `mcp__panel__scene`: publishes a sandboxed HTML/JS folder (or inline `html`) as a scene, and takes a headless screenshot of it for the model to check.

The `panel:panel-guide` skill (`skills/panel-guide`) tells the model how to choose a form and write a scene.

## Options (`userConfig`)

All optional; the defaults are in `.claude-plugin/plugin.json`.

| Key | Title | Type | Default | What it does |
| --- | --- | --- | --- | --- |
| `doneRowMinutes` | Finished agent row (minutes) | number | `10` | How long a finished agent keeps its row on the board. |
| `dodFramesMax` | Checklist frames | number | `3` | At most this many agent checklist frames on the board at once. |
| `stripRoutingSuffix` | Strip routing note from agent names | boolean | `true` | Drop a trailing (sonnet/high) style note from an agent's name on the board. |
| `goalLabels` | Goal line labels | string | `goal,objective` | Comma-separated labels of the brief line that states an agent's goal. |
| `ticketLabels` | Ticket line labels | string | `ticket` | Comma-separated labels of the brief line that names an agent's ticket. |
| `insightMinSeconds` | Insight minimum (seconds) | number | `30` | The workflow-insight frames wait for this many seconds of agent time before they say anything. |
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
- Nothing is sent to any remote service by the mod. Scenes are model-written code: they run in a sandboxed iframe with a strict content-security policy, but with the CDN allow-list on (`web/scene-files.mjs`) a scene may load scripts from cdnjs, jsdelivr or unpkg in your browser. Do not put secrets in a scene folder.

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
