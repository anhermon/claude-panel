# Panel components: the 17 block kinds

A card holds up to 8 blocks; each block is `{ "kind": ..., ... }`. All text is plain: no markdown, no HTML. Over-cap input is truncated and the tool result lists `trimmed:`. Cards are the lightweight option: use them for the header summary and for small structured facts; for anything visual or interactive publish a scene instead. Back to [SKILL.md](../SKILL.md).

## Quick chooser

| Need | Kind |
|---|---|
| A sentence or two of prose | `text` |
| 2-8 loose facts | `list` |
| Compare items on 2+ attributes | `table` |
| A short snippet | `code` |
| A note that must not be missed | `callout` |
| Ordered work with status | `steps` |
| Label: value facts | `kv` |
| 2-4 headline numbers | `metrics` |
| How far along | `progress` |
| A proposed or made change | `diff` |
| Which files are touched | `tree` |
| Pick between alternatives | `options` |
| What happened, in order | `timeline` |
| Where a claim comes from | `sources` |
| Compare magnitudes | `bars` |
| Topics or labels | `tags` |
| A cited statement | `quote` |

Caps below are per block. Terminal pane is about 45 columns: keep lines short.

## text
Prose. Use for one thought; if it is a list, use `list`. Cap 600 chars.
```json
{ "kind": "text", "text": "Retrying non-idempotent uploads can duplicate objects, so confirm content-hash keying first." }
```

## list
Short bullets. Not for ordered or stateful work (use `steps`). Caps: 8 items, 160 chars each.
```json
{ "kind": "list", "items": ["Max 4 attempts, about 4s total wait", "Only 503 is retried"] }
```

## table
Comparison across attributes. Not for one-column data (use `list`). Caps: 8 rows, 5 columns, 60 chars per cell.
```json
{ "kind": "table", "head": ["Option", "Cost", "Risk"],
  "rows": [["Client retry", "S", "Low"], ["Queue", "L", "Medium"]] }
```

## code
A snippet the user needs to see. Not for diffs (use `diff`). Caps: 30 lines, 160 chars per line, `lang` 20 chars.
```json
{ "kind": "code", "lang": "ts", "text": "const MAX_ATTEMPTS = 4\nconst BASE_MS = 250" }
```

## callout
One warning, success or note. Tone `info`, `warn` or `ok` (no `danger`). Do not stack several. Cap 600 chars.
```json
{ "kind": "callout", "tone": "warn", "text": "429 handling is still undecided." }
```

## steps
A plan or checklist with state: `todo`, `doing`, `done`, `failed`, `skipped`. Keep exactly one `doing`. Caps: 12 items, text 120, note 80.
```json
{ "kind": "steps", "items": [
  { "text": "Reproduce the flake", "state": "done" },
  { "text": "Add backoff to upload()", "state": "doing", "note": "max 4 attempts" },
  { "text": "Server-side queue", "state": "failed", "note": "needs infra we do not have" } ] }
```

## kv
Facts as label: value. Not for sentences. Caps: 10 rows, key 30, value 120.
```json
{ "kind": "kv", "rows": [["Path", "POST /v1/objects"], ["Timeout", "30s"]] }
```

## metrics
Headline numbers as big tiles. Values are short strings. Tone `ok`, `warn` or `danger` colours the delta. Caps: 4 items, label 30, value 12, delta 12.
```json
{ "kind": "metrics", "items": [
  { "label": "CI flake rate", "value": "30%", "delta": "flat", "tone": "danger" },
  { "label": "With retry", "value": "0%", "delta": "-9/10", "tone": "ok" } ] }
```

## progress
One overall bar, `value` 0 to 1. Not per-step (use `steps`). Caps: label 60, note 80.
```json
{ "kind": "progress", "label": "Overall", "value": 0.4, "note": "2 of 5 steps" }
```

## diff
A unified diff, lines starting with `+`, `-`, `@@`. Show the essential hunk only. Caps: 40 lines, 160 chars per line.
```json
{ "kind": "diff", "file": "src/net/upload.ts",
  "text": "@@ -12,3 +12,4 @@\n-  return send(body);\n+  const res = await send(body);\n+  return res;" }
```

## tree
Flat paths drawn as a directory tree. `mark`: `added`, `changed`, `removed`, `focus`. Caps: 20 items, path 100, note 60.
```json
{ "kind": "tree", "items": [
  { "path": "src/net/upload.ts", "mark": "changed", "note": "backoff" },
  { "path": "src/net/retry.ts", "mark": "added" } ] }
```

## options
Alternatives with a recommendation: set `pick: true` on exactly one. Not for 2+ attribute grids (use `table`). Caps: 4 items, 3 pros, 3 cons, lines 80, summary 140.
```json
{ "kind": "options", "items": [
  { "title": "Client retry", "summary": "Smallest change.", "pros": ["No new infra"], "cons": ["Adds latency"], "pick": true },
  { "title": "Server queue", "pros": ["Durable"], "cons": ["New infra"] } ] }
```

## timeline
Events in order. `when` is a short label, tone `ok`, `warn` or `danger`. Caps: 8 items, text 120, when 20.
```json
{ "kind": "timeline", "items": [
  { "when": "10:20", "text": "Pattern found: bursts of 503", "tone": "warn" },
  { "when": "10:41", "text": "Stub reproduces 9 of 10", "tone": "ok" } ] }
```

## sources
Links and references. `url` must be http or https, else it is dropped. Caps: 8 items, title 100, url 200, note 80.
```json
{ "kind": "sources", "items": [
  { "title": "Exponential backoff and jitter", "url": "https://aws.amazon.com/builders-library/timeouts-retries-and-backoff-with-jitter/", "note": "why jitter matters" },
  { "title": "Internal runbook: storage 503s" } ] }
```

## bars
Compare magnitudes; scaled to the max. `value` is a number, 0 or more. Caps: 8 items, label 30, unit 10.
```json
{ "kind": "bars", "unit": "runs", "items": [
  { "label": "Pass", "value": 21 }, { "label": "503 flake", "value": 7 } ] }
```

## tags
Topic chips. Decoration: skip unless they help scanning. Caps: 10 items, 30 chars.
```json
{ "kind": "tags", "items": ["retry", "http", "flaky-test"] }
```

## quote
A cited statement; pair with `sources`. Caps: text 300, by 40.
```json
{ "kind": "quote", "text": "Retries are selfish: they trade the caller's latency for the server's load.", "by": "builders library" }
```
