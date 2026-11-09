#!/usr/bin/env node
// Builds the detail fixtures of the REAL (trimmed, scrubbed) sub-agent transcripts for scripts/render-agents-info.mjs:
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
const TSC = process.env.TSC ?? 'tsc'; // tsc from PATH (npm i -g typescript), or set TSC
const FINISHED_AGO_MS = 90_000;
const SECONDS = 1000;
const REAL = [
  { file: 'agents-tile-drilldown.jsonl', out: 'detail-real-tile', name: 'Agents tile drill-down' },
  { file: 'metrics-struggles-redesign.jsonl', out: 'detail-real-metrics', name: 'Metrics and Struggles redesign' },
];
const SPAN_KIND = { read: 'reading', edit: 'logic', tests: 'tests', run: 'working', delegate: 'delegating', ask: 'working', other: 'working' };
const ABSOLUTE = new Set(['t', 'lastT', 'a', 'b', 'sayT', 'fromT', 'toT', 'updatedAt', 'coveredFromT']);

const build = mkdtempSync(join(tmpdir(), 'detail-fixtures-'));
try {
  try { execFileSync(TSC, ['--ignoreConfig', '--module', 'commonjs', '--target', 'es2022', '--skipLibCheck', '--outDir', build, join(ROOT, 'hooks/agent-detail.ts'), join(ROOT, 'hooks/transcript-parse.ts'), join(ROOT, 'hooks/agent-progress.ts')], { stdio: 'ignore' }); } catch { /* a deprecation notice makes tsc exit 1 but it still emits */ }
  writeFileSync(join(build, 'package.json'), '{"type":"commonjs"}');
  const require = createRequire(join(build, 'x.js'));
  const { buildDetail } = require('./agent-detail.js');
  const { parseTranscript } = require('./transcript-parse.js');
  const existing = JSON.parse(readFileSync(join(FIXTURES, 'detail.json'), 'utf8'));

  for (const r of REAL) {
    const text = readFileSync(join(TRANSCRIPTS, r.file), 'utf8');
    const parsed = parseTranscript(text, true);
    const tools = parsed.entries.filter((e) => e.kind === 'tool');
    const last = parsed.entries.at(-1).t;
    const now = last + FINISHED_AGO_MS;
    const startedAt = parsed.entries[0].t - 5 * SECONDS;
    const counts = {};
    const tally = {};
    for (const e of tools) {
      counts[e.tool] = (counts[e.tool] ?? 0) + 1;
      if (e.path) { const key = `${e.act === 'read' ? 'read' : 'edit'}:${e.path.split('/').pop()}`; tally[key] ??= { n: 0, err: 0, retry: 0, ms: 0 }; tally[key].n++; tally[key].ms += e.ms ?? 0; if (e.error) tally[key].err++; }
    }
    const subject = { id: 't40', name: r.name, isMain: false, state: 'done', startedAt, endedAt: last };
    const read = { parsed, head: parsed.brief, headFull: parsed.briefFull, isWhole: true, fileBytes: text.length, readBytes: text.length };
    const progress = buildDetail({ subject, loop: undefined, events: [], read, unavailable: '', pages: 1, now }).progress;
    const loop = {
      id: 't40', label: r.name, kind: 'subagent', status: 'done', lastTool: '', lastTarget: '', calls: tools.length, busy: 0, counts, tally,
      files: [...new Set(tools.filter((e) => e.path).map((e) => e.path.split('/').pop()))].slice(0, 8), startedAt, lastAt: last,
      spans: progress.phases.map((p) => ({ k: SPAN_KIND[p.kind], t: p.a, e: p.b, n: p.n })),
    };
    const detail = buildDetail({ subject, loop, events: [], read, unavailable: '', pages: 1, now });
    const ago = (v) => {
      if (Array.isArray(v)) return v.map((x) => ago(x));
      if (v === null || typeof v !== 'object') return v;
      return Object.fromEntries(Object.entries(v).flatMap(([k, x]) => {
        if (k === 'startedAt') return [['startedAgoMs', now - x]];
        if (k === 'endedAt') return [['endedAgoMs', x === null ? null : now - x]];
        if (k === 'updatedAt') return [];
        if (ABSOLUTE.has(k) && typeof x === 'number') return [[k === 't' ? 'agoMs' : `${k}AgoMs`, now - x]];
        if (k === 'series') return [[k, x.map((p) => [Math.round((now - p.t) / SECONDS), p.tokens])]];
        return [[k, ago(x)]];
      }));
    };
    const out = { t40: ago(detail), main: existing.main };
    writeFileSync(join(FIXTURES, `${r.out}.json`), `${JSON.stringify(out)}\n`);
    process.stdout.write(`${r.out}: ${tools.length} calls, ${detail.progress.phases.length} phases, ${detail.struggles.items.length} struggles\n`);
  }
} finally {
  rmSync(build, { recursive: true, force: true });
}
