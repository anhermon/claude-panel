// The Metrics tab: a stat grid, the run as labelled phases over its real time with where it stands (step, checklist, decisions, issues,
// struggles), then top tools and files.
// A number the data does not hold says why in a few words; a section with no data is one muted line.
import { h, svg } from './dom.js';
import { activitySplit, callBuckets, currentStep, failureTone, longestGap, tokenReason, seriesPath, clockShort } from './detail-logic.mjs';
import { renderExternal, tokenBar } from './detail-external.js';
import { phaseBar } from './detail-progress.js';
import { planCount } from './detail-progress-logic.mjs';
import { formatDuration, formatTokens } from './agents-info-logic.mjs';

const RING = Object.freeze({ size: 44, r: 18, stroke: 6 });
const SPARK = Object.freeze({ w: 96, h: 28, pad: 2 });
const TOP_N = 5;
const CURVE = Object.freeze({ w: 320, h: 90, pad: 6 });
const TOKEN_CURVE_LABEL = 'Cumulative fresh input and output tokens';
const TONE_WORD = Object.freeze({ ok: 'none failed', warn: 'some failed', bad: 'many failed', none: '' });

function stat(label, value, sub, extra) {
  const d = h('div', 'm-stat');
  const text = h('div', 'm-stat-text');
  text.append(h('span', 'm-stat-label', label), h('b', 'm-stat-val', value));
  if (sub) text.append(h('small', 'm-stat-sub', sub));
  d.append(text);
  if (extra) d.append(extra);
  return d;
}

function ring(pct) {
  const c = 2 * Math.PI * RING.r;
  const s = svg('svg', { viewBox: `0 0 ${RING.size} ${RING.size}`, class: 'm-ring', role: 'img', 'aria-label': `${pct}% active` });
  const mid = RING.size / 2;
  s.append(
    svg('circle', { cx: mid, cy: mid, r: RING.r, class: 'm-ring-track', 'stroke-width': RING.stroke }),
    svg('circle', { cx: mid, cy: mid, r: RING.r, class: 'm-ring-arc', 'stroke-width': RING.stroke, 'stroke-dasharray': `${(c * pct) / 100} ${c}`, transform: `rotate(-90 ${mid} ${mid})` }),
  );
  return s;
}

function spark(counts) {
  const max = Math.max(1, ...counts);
  const step = (SPARK.w - 2 * SPARK.pad) / (counts.length - 1);
  const pts = counts.map((n, i) => `${Math.round((SPARK.pad + i * step) * 10) / 10},${Math.round((SPARK.h - SPARK.pad - (n / max) * (SPARK.h - 2 * SPARK.pad)) * 10) / 10}`);
  const s = svg('svg', { viewBox: `0 0 ${SPARK.w} ${SPARK.h}`, class: 'm-spark', role: 'img', 'aria-label': 'Tool calls over the run' });
  s.append(svg('polyline', { points: pts.join(' '), class: 'm-spark-line' }));
  return s;
}

/** Where the run stands, in the agent's own evidence: step, checklist count, decisions, issues, struggles (each line one concrete fact). */
function standing(d) {
  const p = d.progress;
  const count = planCount(p.plan);
  const lines = [
    ['Step', p.now.laneStep || (p.now.call ? p.now.call.text : currentStep(d)) || 'none yet'],
    ['Checklist', count.text ? `${count.text} (${p.plan.label})` : 'none: the agent posted no checklist and its brief has no steps'],
    ['Decisions', p.decisions.length > 0 ? `${p.decisions.length}, latest: "${p.decisions[0].quote}"` : 'none stated'],
    ['Issues', p.issues.summary || 'No failures so far.'],
    ['Struggles', d.struggles.headline || 'none'],
  ];
  const dl = h('dl', 'm-standing');
  for (const [k, v] of lines) dl.append(h('dt', '', k), h('dd', '', v));
  return dl;
}

function runSection(d, m) {
  const sec = h('section', 'm-sec');
  const head = h('h3', 'm-head', 'Run');
  if (m.elapsedMs > 0) head.append(h('small', '', `${formatDuration(m.elapsedMs)} in ${d.progress.phases.length || 'no'} phase${d.progress.phases.length === 1 ? '' : 's'}`));
  sec.append(head, phaseBar(d.progress), standing(d));
  return sec;
}

function bars(rows) {
  const max = Math.max(1, ...rows.map((r) => r.n));
  const ul = h('ul', 'm-bars');
  for (const r of rows) {
    const li = h('li');
    const fill = h('i');
    fill.style.width = `${Math.max(2, Math.round((r.n / max) * 100))}%`;
    const track = h('span', 'm-bar');
    track.append(fill);
    li.append(h('span', 'm-bar-name', r.name), track, h('b', 'm-bar-n', String(r.n)));
    ul.append(li);
  }
  return ul;
}

function listSection(title, emptyText, content) {
  const sec = h('section', 'm-sec');
  sec.append(h('h3', 'm-head', title));
  sec.append(content ?? h('p', 'm-empty', emptyText));
  return sec;
}

function filesList(files) {
  const ul = h('ul', 'm-files');
  for (const f of files) {
    const li = h('li');
    li.append(h('span', 'm-file', f.name), h('span', 'm-rw', `${f.reads} read${f.reads === 1 ? '' : 's'}`), h('span', f.edits > 0 ? 'm-rw edit' : 'm-rw', `${f.edits} edit${f.edits === 1 ? '' : 's'}`));
    ul.append(li);
  }
  return ul;
}

function claudeTokens(m) {
  const sec = h('section', 'm-sec');
  sec.append(h('h3', 'm-head', 'Token usage'));
  sec.append(tokenBar(m.tokens));
  const curve = seriesPath(m.tokens.series, CURVE.w, CURVE.h, CURVE.pad);
  if (curve) {
    const wrap = h('div', 'curve');
    const chart = svg('svg', { viewBox: `0 0 ${CURVE.w} ${CURVE.h}`, role: 'img', 'aria-label': TOKEN_CURVE_LABEL });
    chart.append(svg('path', { d: curve.area, class: 'curve-area' }), svg('path', { d: curve.line, class: 'curve-line' }));
    const axis = h('div', 'curve-axis');
    axis.append(h('span', '', clockShort(curve.from)), h('span', '', `${formatTokens(curve.max)} fresh + output`), h('span', '', clockShort(curve.to)));
    wrap.append(chart, axis);
    sec.append(wrap);
  } else sec.append(h('p', 'm-empty', 'Not enough model requests for a token curve.'));
  return sec;
}

export function renderMetrics(root, detail) {
  root.replaceChildren();
  const m = detail.metrics;
  const split = activitySplit(m);
  const grid = h('div', 'm-grid');
  const tone = failureTone(m.errors, m.calls);
  const gap = longestGap(detail);
  const counts = callBuckets(detail);
  const step = currentStep(detail);
  const fail = stat('Failed calls', m.errors === null ? 'n/a' : `${m.errors} / ${m.calls}`, m.errors === null ? 'not measured' : [TONE_WORD[tone], m.apiErrors ? `${m.apiErrors} API errors` : '', m.retries ? `${m.retries} retried` : ''].filter(Boolean).join(' · '));
  fail.dataset.tone = tone;
  const stepStat = stat('Latest step', step || 'none', detail.endedAt === null ? 'running' : 'finished');
  stepStat.classList.add('m-stat-wide');
  grid.append(
    stat('Run time', formatDuration(m.elapsedMs) || '0 s', `${split.activePct}% active · ${formatDuration(m.activeMs) || '0 s'}`, m.elapsedMs > 0 ? ring(split.activePct) : null),
    stat('Tool calls', String(m.calls), detail.endedAt === null ? 'so far' : 'in the run', counts.length > 0 ? spark(counts) : null),
    stat('Tokens', m.tokens.total === null ? 'n/a' : formatTokens(m.tokens.total), m.tokens.total === null ? tokenReason(detail) : 'fresh input + output'),
    fail,
    stat('Turns', m.turns ? String(m.turns.count) : 'n/a', m.turns?.count ? `average ${formatDuration(m.turns.avgMs) || '<1 s'} · longest ${formatDuration(m.turns.maxMs) || '<1 s'}` : 'no turn durations recorded'),
    stat('Longest silence', gap ? formatDuration(gap.ms) || '<1 s' : 'n/a', gap ? 'no entry in between' : 'no transcript entries'),
    stepStat,
  );
  root.append(grid);
  if (detail.external) root.append(renderExternal(detail.external, detail.updatedAt));
  else if (m.tokens.steps > 0) root.append(claudeTokens(m));
  root.append(runSection(detail, m));

  const two = h('div', 'm-two');
  const topTools = m.tools.slice(0, TOP_N);
  const topFiles = m.files.slice(0, TOP_N);
  two.append(
    listSection('Top tools', 'No tool calls counted', topTools.length > 0 ? bars(topTools.map((t) => ({ name: t.tool, n: t.n }))) : null),
    listSection('Files touched', 'No file reads or edits counted', topFiles.length > 0 ? filesList(topFiles.map((f) => ({ ...f, name: f.name }))) : null),
  );
  root.append(two);
}
