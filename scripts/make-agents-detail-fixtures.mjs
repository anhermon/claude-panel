#!/usr/bin/env node
// Builds detail fixtures from synthetic Acme Notes Claude transcripts and Codex rollouts for scripts/render-agents-info.mjs:
//   node scripts/make-agents-detail-fixtures.mjs
// It compiles the mod's own detail logic (hooks/agent-detail.ts) to a temp folder, runs buildDetail on each tests/fixtures/transcripts/*.jsonl
// as a finished agent, and writes web/builtin/agents-info/fixtures/detail-real-<name>.json with every absolute time turned into "ago"
// (the render script stamps them fresh). The pulse record is rebuilt from the transcript, because a transcript alone has none.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = join(ROOT, 'web/builtin/agents-info/fixtures');
const TRANSCRIPTS = join(ROOT, 'tests/fixtures/transcripts');
const CODEX_FIXTURES = join(ROOT, 'tests/fixtures/codex');
const CODEX_OUTPUT = 'codex-detail.json';
const CODEX_SCENARIOS = [
  { id: 'run-codex-smoke', ledger: 'delegations-smoke.jsonl', rollout: 'rollout-smoke.jsonl', name: 'builder' },
  { id: 'run-run-aaa111', ledger: 'delegations.jsonl', rollout: 'rollout-finished.jsonl', name: 'reviewer' },
];
const FIRST_SCENARIO_INDEX = 0;
const DEFAULT_PAGES = 1;
const TSC = process.env.TSC ?? 'tsc'; // tsc from PATH (npm i -g typescript), or set TSC
const FINISHED_AGO_MS = 90_000;
const SECONDS = 1000;
const START_PADDING_SECONDS = 5;
const FILE_LIMIT = 8;
const SUBJECT_ID = 't40';
const DONE = 'done';
const SYNTHETIC = [
  { file: 'agents-tile-drilldown.jsonl', out: 'detail-real-tile', name: 'builder' },
  { file: 'metrics-struggles-redesign.jsonl', out: 'detail-real-metrics', name: 'reviewer' },
];
const SPAN_KIND = { read: 'reading', edit: 'logic', tests: 'tests', run: 'working', delegate: 'delegating', ask: 'working', other: 'working' };
const ABSOLUTE = new Set(['t', 'lastT', 'a', 'b', 'sayT', 'fromT', 'toT', 'updatedAt', 'coveredFromT']);

const build = mkdtempSync(join(tmpdir(), 'detail-fixtures-'));
try {
  try { execFileSync(TSC, ['--ignoreConfig', '--module', 'commonjs', '--target', 'es2022', '--skipLibCheck', '--outDir', build, join(ROOT, 'hooks/agent-detail.ts'), join(ROOT, 'hooks/transcript-parse.ts'), join(ROOT, 'hooks/agent-progress.ts'), join(ROOT, 'hooks/agent-detail-external.ts'), join(ROOT, 'hooks/run-records.ts'), join(ROOT, 'hooks/harness-adapters/codex.ts')], { stdio: 'ignore' }); } catch { /* a deprecation notice makes tsc exit 1 but it still emits */ }
  writeFileSync(join(build, 'package.json'), '{"type":"commonjs"}');
  const require = createRequire(join(build, 'x.js'));
  const { buildDetail } = require('./agent-detail.js');
  const { parseTranscript } = require('./transcript-parse.js');
  const { buildExternalDetail } = require('./agent-detail-external.js');
  const { foldDelegations } = require('./run-records.js');
  const existing = JSON.parse(readFileSync(join(FIXTURES, 'detail.json'), 'utf8'));

  const ago = (v, now) => {
    if (Array.isArray(v)) return v.map((x) => ago(x, now));
    if (v === null || typeof v !== 'object') return v;
    return Object.fromEntries(Object.entries(v).flatMap(([k, x]) => {
      if (k === 'startedAt') return [['startedAgoMs', now - x]];
      if (k === 'endedAt') return [['endedAgoMs', x === null ? null : now - x]];
      if (k === 'updatedAt') return [];
      if (ABSOLUTE.has(k) && typeof x === 'number') return [[k === 't' ? 'agoMs' : `${k}AgoMs`, now - x]];
      if (k === 'series') return [[k, x.map((p) => [Math.round((now - p.t) / SECONDS), p.tokens])]];
      return [[k, ago(x, now)]];
    }));
  };
  for (const r of SYNTHETIC) {
    const text = readFileSync(join(TRANSCRIPTS, r.file), 'utf8');
    const parsed = parseTranscript(text, true);
    const tools = parsed.entries.filter((e) => e.kind === 'tool');
    const last = parsed.entries.at(-1).t;
    const now = last + FINISHED_AGO_MS;
    const startedAt = parsed.entries[0].t - START_PADDING_SECONDS * SECONDS;
    const counts = {};
    const tally = {};
    for (const e of tools) {
      counts[e.tool] = (counts[e.tool] ?? 0) + 1;
      if (e.path) { const key = `${e.act === 'read' ? 'read' : 'edit'}:${e.path.split('/').pop()}`; tally[key] ??= { n: 0, err: 0, retry: 0, ms: 0 }; tally[key].n++; tally[key].ms += e.ms ?? 0; if (e.error) tally[key].err++; }
    }
    const subject = { id: SUBJECT_ID, name: r.name, isMain: false, state: DONE, startedAt, endedAt: last };
    const read = { parsed, head: parsed.brief, headFull: parsed.briefFull, isWhole: true, fileBytes: text.length, readBytes: text.length };
    const progress = buildDetail({ subject, loop: undefined, events: [], read, unavailable: '', pages: DEFAULT_PAGES, now }).progress;
    const loop = {
      id: SUBJECT_ID, label: r.name, kind: 'subagent', status: DONE, lastTool: '', lastTarget: '', calls: tools.length, busy: 0, counts, tally,
      files: [...new Set(tools.filter((e) => e.path).map((e) => e.path.split('/').pop()))].slice(0, FILE_LIMIT), startedAt, lastAt: last,
      spans: progress.phases.map((p) => ({ k: SPAN_KIND[p.kind], t: p.a, e: p.b, n: p.n })),
    };
    const detail = buildDetail({ subject, loop, events: [], read, unavailable: '', pages: DEFAULT_PAGES, now });
    const out = { [SUBJECT_ID]: ago(detail, now), main: existing.main };
    if (r === SYNTHETIC[FIRST_SCENARIO_INDEX]) writeFileSync(join(FIXTURES, 'detail.json'), `${JSON.stringify(out)}\n`);
    writeFileSync(join(FIXTURES, `${r.out}.json`), `${JSON.stringify(out)}\n`);
    process.stdout.write(`${r.out}: ${tools.length} calls, ${detail.progress.phases.length} phases, ${detail.struggles.items.length} struggles\n`);
  }
  const codexDetails = {};
  for (const scenario of CODEX_SCENARIOS) {
    const text = readFileSync(join(CODEX_FIXTURES, scenario.rollout), 'utf8');
    const ledger = readFileSync(join(CODEX_FIXTURES, scenario.ledger), 'utf8').trim().split('\n');
    const sessionId = JSON.parse(ledger[FIRST_SCENARIO_INDEX]).sessionId;
    const record = foldDelegations(ledger, sessionId)[FIRST_SCENARIO_INDEX];
    const startedAt = Date.parse(record.startedAt);
    const endedAt = Date.parse(record.endedAt);
    const now = endedAt + FINISHED_AGO_MS;
    const subject = { id: scenario.id, name: scenario.name, isMain: false, state: DONE, startedAt, endedAt };
    const rollout = { text, headText: '', isWhole: true, size: text.length, readBytes: text.length };
    const detail = buildExternalDetail({ subject, loop: undefined, record, events: [], rollout, unavailable: '', pages: DEFAULT_PAGES, now });
    codexDetails[scenario.id] = ago(detail, now);
  }
  writeFileSync(join(FIXTURES, CODEX_OUTPUT), `${JSON.stringify(codexDetails)}\n`);

} finally {
  rmSync(build, { recursive: true, force: true });
}
