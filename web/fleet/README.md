# Fleet control plane

One always-on local process that shows **every Claude Code session on this machine** (running now, idle, earlier today)
and can send one text message to a running session. Read-only apart from that: no stop, no permission answers.
Zero dependencies, Node 22, offline. Not tied to any session's pane.

## Run it

```
/fleet                       in Claude Code: starts it when needed and answers with the URL (shown to you only)
node scripts/fleet.mjs start [--print-url] | stop | status | url
```

`start` refuses to run twice (pid file + a check that the pid really is `fleet/server.mjs`). `status` never prints the
token or the URL; `url` and `start --print-url` do, for a person at a terminal. Do not run those through a model.

## What it shows

| Section | Means |
| --- | --- |
| Running now | live process and a transcript written in the last 30 s, or the registry says `busy` |
| Idle | live process, quiet |
| Earlier today | no live process, transcript touched inside the window (24 h) |

Per session: title, project and branch, model, output tokens, tool calls by name and by kind of work, tool errors, last prompt,
current tool, turn durations, subagents, age of the last write. A session whose last tool call has had no answer for 20 s
and is quiet shows **may be waiting**: a heuristic, not a fact (a long tool also looks like that). Click a row for the drill-down
(tokens over time, tool mix, kind of work, turns, a transcript timeline with "show older events") and the compose box.
`#s=<session id>` deep-links a session. Numbers marked with a dagger cover only the tail of a huge transcript.

## Where the data comes from

- `~/.claude/sessions/<pid>.json` (live registry) cross-checked with `ps`: a registry entry counts only when the pid exists and its
  start time matches `procStart` (`procStart` is UTC, `ps` prints local time: both readings are compared within 2 s). Claude
  processes with no registry file (`claude --resume <sid>`) are found through `ps`. The `*.key` peer tokens in that folder are
  never opened.
- `~/.claude/projects/<slug>/<sid>.jsonl`: only mtimes are statted; the last 512 KiB of a transcript is read, incrementally after
  that. Subagent transcripts count for their parent. Unknown row types are counted and shown as "unparsed rows", never fatal.

`feed.mjs` polls every 2 s (gated on mtime and size) and writes `$TMPDIR/claude-panel/fleet/state.json` atomically
(`schema: 1`), rewriting it only when something changed or every 10 s. That file is the interface for a future global publisher.

## Security

- Binds `127.0.0.1` only. Every route starts with a random token path segment (compared in constant time); a wrong `Host` is 421.
- The token lives in `<state>/token` (0600) and is never on a command line. pid, port and state files are 0600.
- The page builds DOM from text nodes only, and a CSP forbids inline script, so transcript text cannot run as code.
- Secrets are masked before anything is stored or shown: API keys and token shapes, `password=`-style assignments, bearer and
  `Authorization:` headers, URL credentials, private-key blocks, long mixed blobs (`redact.mjs`).
- Text on the page comes from other sessions: it is untrusted and is never fed to a model automatically.

## Send a message

The page POSTs `{sessionId, text}` (JSON only, same origin, 8 KiB body, 2000 characters). The server checks it against the live state and
writes `commands/<id>.json`. The **hub** (the panel mod, `hooks/fleet-hub.ts`) polls that folder every 2 s and, per command:

1. claims it with an atomic `mkdir` (two sessions with the mod never both send);
2. re-validates (`hooks/fleet-validate.ts`): origin, id, text, age <= 120 s, the pid's registry file names that session, its
   `procStart` matches, `ps` agrees, no more than 5 messages a minute to one session, and never to the session the hub runs in
   (loops) unless `hub-config.json` has `{"allowSelf": true}`;
3. sends `$.session.send({to:{sessionId}, text})` with `[sent from fleet control panel by the user]` in front;
4. appends a masked 80-character preview to `audit.jsonl` and writes `results/<id>.json` (`queued`, `refused` or `failed`, with a reason).

The page shows that result under the box. With no fresh `hub.json` (older than 15 s) sending is disabled. Claims, results and commands older
than an hour are pruned. A command whose hub died after claiming it stays unanswered until then.

## Files and settings

State folder: `$CLAUDE_FLEET_DIR`, default `$TMPDIR/claude-panel/fleet` (`state.json`, `token`, `server.pid`, `server.json`, `server.log`,
`commands/`, `results/`, `claims/`, `audit.jsonl`, `hub.json`). Tunables in `config.mjs`, each overridable as `CLAUDE_FLEET_*`
(`POLL_MS`, `WINDOW_HOURS`, `TAIL_KIB`, `PORT`, ...). `hooks/fleet-contract.ts` holds the numbers both sides share;
`contract.test.mjs` fails when they differ.

## Tests

```
node --test web/fleet/*.test.mjs        feed, parsing, masking, server security, page model, contract
claude plugin test .                    includes tests/fleet-validate.test.ts and tests/fleet-hub.test.ts
```
