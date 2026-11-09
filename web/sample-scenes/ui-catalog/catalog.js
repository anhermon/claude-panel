// panel/ui catalog: every component with live-updating sample data (also the visual test, see scripts/render-ui-catalog.mjs).
// A real scene would call panel.data(cb) and pass the value to el.update(); here a seeded ticker plays that part.
import panel from 'panel';
import { mount, stack, row, grid, card, text, md, callout, badge, metric, gauge, rings, progress, steps, table, form, timeline, kanban, chart } from 'panel/ui';

const TICK_MS = 1500;
const WINDOW = 24;
const SEED = 7;
const SEC = 1000;

function mulberry32(a) {
  return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const rnd = mulberry32(SEED);
const between = (lo, hi) => lo + rnd() * (hi - lo);
const walk = (v, step, lo, hi) => Math.min(hi, Math.max(lo, v + between(-step, step)));
let tick = 0;
const t0 = Date.now();

// ---- state
const req = Array.from({ length: WINDOW }, (_, i) => 900 + 200 * Math.sin(i / 3) + between(-40, 40));
const err = Array.from({ length: WINDOW }, () => between(0.4, 1.2));
const p95 = Array.from({ length: WINDOW }, () => between(120, 190));
const queue = Array.from({ length: WINDOW }, () => between(4, 12));
const xs = Array.from({ length: WINDOW }, (_, i) => new Date(t0 + (i - WINDOW) * SEC * 2));
const WEEK = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const week = WEEK.map(() => between(20, 90));
const AGENTS = ['planner', 'builder', 'tester', 'reviewer', 'deployer', 'scribe'];
const agents = AGENTS.map((name, i) => ({ name, status: ['running', 'idle', 'running', 'failed', 'idle', 'running'][i], tasks: Math.round(between(1, 40)), cpu: between(5, 95), mem: between(100, 900) }));
const HOURS = ['00-04', '04-08', '08-12', '12-16', '16-20', '20-24'];
const heat = WEEK.flatMap((d) => HOURS.map((h) => ({ x: h, y: d, value: Math.round(between(0, 100)) })));
const langs = [{ label: 'TypeScript', value: 48 }, { label: 'Python', value: 31 }, { label: 'Go', value: 17 }, { label: 'Rust', value: 9 }];
const stacks = ['Q1', 'Q2', 'Q3', 'Q4'].map((q) => ({ q, a: between(10, 40), b: between(8, 30), c: between(5, 20) }));
const scatterA = Array.from({ length: 30 }, () => [between(1, 5), between(10, 40)]);
const scatterB = Array.from({ length: 30 }, () => [between(4, 9), between(30, 70)]);
const split = [{ label: 'Free', value: 56 }, { label: 'Pro', value: 29 }, { label: 'Team', value: 12 }, { label: 'Ent', value: 3 }];
const planSteps = ['Fetch', 'Build', 'Test', 'Review', 'Ship'];
const board = { todo: ['Write docs', 'Add retries', 'Fix flaky test'], doing: ['Refactor store'], review: ['Port charts'], done: ['Bootstrap repo'] };
const BOARD_ORDER = ['todo', 'doing', 'review', 'done'];

// ---- components
const kpis = {
  req: metric({ label: 'Requests / s', value: req.at(-1), delta: 4.2, deltaUnit: '%', deltaLabel: 'vs last hour', spark: req, decimals: 0 }),
  err: metric({ label: 'Error rate', value: err.at(-1), unit: '%', delta: -0.3, deltaUnit: ' pt', goodWhen: 'down', spark: err, decimals: 2 }),
  p95: metric({ label: 'p95 latency', value: p95.at(-1), unit: 'ms', delta: 12, deltaUnit: ' ms', goodWhen: 'down', spark: p95, decimals: 0 }),
  q: metric({ label: 'Queue depth', value: queue.at(-1), spark: queue, decimals: 0 }),
};
const cpuGauge = gauge({ value: 62, label: 'CPU', unit: '%', thresholds: [{ upTo: 60, tone: 'ok' }, { upTo: 85, tone: 'warn' }, { tone: 'danger' }] });
const memGauge = gauge({ value: 4.1, min: 0, max: 8, label: 'Memory', unit: 'GB', decimals: 1, thresholds: [{ upTo: 5, tone: 'ok' }, { upTo: 7, tone: 'warn' }, { tone: 'danger' }] });
const ringsEl = rings({ items: [{ label: 'Build', pct: 82 }, { label: 'Tests', pct: 45 }, { label: 'Deploy', pct: 12 }] });
const prog = progress({ label: 'Importing records', value: 0.2, tone: 'info' });
const plan = steps({ items: planSteps.map((t, i) => ({ t, state: i === 0 ? 'doing' : 'todo', note: i === 0 ? 'cloning repository' : undefined })) });
const echo = text({ text: 'Change a field to see the values that form would emit.', size: 's', mono: true });

const lineChart = chart({ type: 'line', title: 'Traffic', height: 240, yLabel: 'req/s', series: [{ name: 'requests', data: [] }] });
const areaChart = chart({ type: 'area', title: 'Queue depth', height: 220, smooth: true, data: [] });
const barChart = chart({ type: 'bar', title: 'Orders by weekday', height: 230, data: [] });
const hbarChart = chart({ type: 'bar', title: 'Language share', height: 200, horizontal: true, unit: '%', data: langs });
const stackChart = chart({ type: 'bar', title: 'Revenue by plan', height: 230, stacked: true, yLabel: 'k$', series: [] });
const scatterChart = chart({ type: 'scatter', title: 'Cost vs duration', height: 240, xLabel: 'minutes', yLabel: 'cost', series: [{ name: 'small', data: scatterA }, { name: 'large', data: scatterB }] });
const donutChart = chart({ type: 'donut', title: 'Users by plan', height: 240, data: split, centerLabel: 'users' });
const heatChart = chart({ type: 'heatmap', title: 'Activity by hour', height: 260, data: heat });

const agentTable = table({
  rowKey: 'name', sort: { key: 'cpu', dir: 'desc' },
  columns: [{ key: 'name', label: 'Agent' }, { key: 'status', label: 'Status', type: 'badge', tones: { running: 'info', idle: 'neutral', failed: 'danger' } },
    { key: 'tasks', label: 'Tasks' }, { key: 'cpu', label: 'CPU %', decimals: 0 }, { key: 'mem', label: 'MB', decimals: 0 }],
  rows: agents,
});
const settings = form({
  id: 'settings',
  fields: [
    { id: 'name', type: 'text', label: 'Service name', value: 'api-gateway', placeholder: 'name' },
    { id: 'replicas', type: 'number', label: 'Replicas', value: 3, min: 1, max: 12 },
    { id: 'env', type: 'select', label: 'Environment', options: ['dev', 'staging', 'prod'], value: 'staging' },
    { id: 'budget', type: 'slider', label: 'Budget', value: 40, min: 0, max: 100, unit: '%' },
    { id: 'auto', type: 'toggle', label: 'Autoscale', value: true },
  ],
  buttons: [{ id: 'reset', label: 'Reset' }, { id: 'apply', label: 'Apply', primary: true }],
  onChange: (v, field) => echo.update({ text: `change ${field}: ${JSON.stringify(v)}` }),
  onSubmit: (v, button) => echo.update({ text: `submit ${button}: ${JSON.stringify(v)}` }),
});
const gantt = timeline({ now: Date.now(), rows: [] });
const kan = kanban({ columns: [] });

function boardColumns() {
  const titles = { todo: 'To do', doing: 'In progress', review: 'Review', done: 'Done' };
  const tones = { todo: 'neutral', doing: 'info', review: 'warn', done: 'ok' };
  return BOARD_ORDER.map((id) => ({ id, title: titles[id], tone: tones[id], limit: id === 'doing' ? 2 : undefined,
    cards: board[id].map((title) => ({ id: title, title, sub: id === 'review' ? 'waiting for a reviewer' : undefined, tags: id === 'doing' ? [{ text: 'live', tone: 'info' }] : undefined })) }));
}
function ganttRows() {
  const now = Date.now();
  const mk = (name, sub, startAgo, endAgo, state) => ({ name, sub, start: now - startAgo * SEC, end: endAgo === null ? undefined : now - endAgo * SEC, state });
  return [mk('planner', 'task breakdown', 300, 240, 'done'), mk('builder', 'api module', 240, null, 'running'), mk('tester', 'unit suite', 150, 60, 'done'),
    mk('reviewer', 'waiting', 90, 20, 'idle'), mk('deployer', 'staging', 40, null, 'running')];
}

// ---- page
mount(document.body,
  row({ justify: 'space-between', gap: 12 },
    stack({ gap: 4 }, text({ text: 'panel/ui catalog', size: 'xl' }), text({ text: 'Every component, fed by live sample data. Hover charts, sort the table, edit the form.', size: 's' })),
    row({ gap: 8 }, badge({ text: 'live', tone: 'ok', live: true }), badge({ text: 'dark + light', tone: 'info' }))),
  callout({ tone: 'info', title: 'Motion explains change', text: 'Numbers count to their new value, bars grow, lines morph, cards slide to the column they moved to. Reduced motion turns all of it off.' }),
  card({ title: 'Metrics' }, grid({ min: 200, gap: 16 }, kpis.req, kpis.err, kpis.p95, kpis.q)),
  grid({ min: 300, gap: 12 },
    card({ title: 'Gauges' }, row({ gap: 12, justify: 'space-around', wrap: false }, cpuGauge, memGauge)),
    card({ title: 'Rings' }, ringsEl),
    card({ title: 'Progress and steps', sub: 'plan' }, prog, plan)),
  grid({ min: 340, gap: 12 }, card({}, lineChart), card({}, areaChart), card({}, barChart), card({}, hbarChart), card({}, stackChart), card({}, scatterChart), card({}, donutChart), card({}, heatChart)),
  card({ title: 'Table', sub: 'click a header to sort' }, agentTable),
  grid({ min: 320, gap: 12 }, card({ title: 'Form' }, settings, echo), card({ title: 'Text and markdown' }, md('## Release notes\nShipped **v2** with `retry` support.\n\n- faster *startup*\n- new [docs](https://example.com)\n\n> Charts name their series on the chart.'), callout({ tone: 'warn', text: 'Quota at 90%' }), callout({ tone: 'danger', title: 'Build failed', text: '3 tests broke' }), row({ gap: 8 }, badge('plain'), badge({ text: 'ok', tone: 'ok', dot: true }), badge({ text: 'warn', tone: 'warn' }), badge({ text: 'failed', tone: 'danger' })))),
  card({ title: 'Timeline', sub: 'who ran when' }, gantt),
  card({ title: 'Kanban' }, kan),
);

// ---- live updates (a real scene: panel.data((d) => comp.update(d)))
function pushWindow(a, v) { a.push(v); a.shift(); }
function step() {
  tick += 1;
  pushWindow(req, walk(req.at(-1), 90, 700, 1300));
  pushWindow(err, walk(err.at(-1), 0.25, 0.1, 2.2));
  pushWindow(p95, walk(p95.at(-1), 14, 90, 260));
  pushWindow(queue, walk(queue.at(-1), 3, 0, 30));
  pushWindow(xs, new Date(xs.at(-1).getTime() + SEC * 2));
  const dReq = ((req.at(-1) - req.at(-2)) / req.at(-2)) * 100;
  kpis.req.update({ value: req.at(-1), spark: [...req], delta: Math.round(dReq * 10) / 10 });
  kpis.err.update({ value: err.at(-1), spark: [...err], delta: Math.round((err.at(-1) - err.at(-2)) * 100) / 100 });
  kpis.p95.update({ value: p95.at(-1), spark: [...p95], delta: Math.round(p95.at(-1) - p95.at(-2)) });
  kpis.q.update({ value: queue.at(-1), spark: [...queue] });
  cpuGauge.update({ value: walk(cpuGauge.opts().value, 14, 8, 98) });
  memGauge.update({ value: walk(memGauge.opts().value, 0.6, 0.5, 7.8) });
  ringsEl.update({ items: ringsEl.opts().items.map((it) => ({ ...it, pct: walk(it.pct, 14, 3, 100) })) });
  prog.update({ value: Math.min(1, prog.opts().value + 0.07 > 1 ? 0.05 : prog.opts().value + 0.07) });
  const done = tick % (planSteps.length + 2);
  plan.update({ items: planSteps.map((t, i) => ({ t, state: i < done ? 'done' : i === done ? 'doing' : 'todo', note: i === done ? 'in progress' : undefined })) });
  lineChart.update({ series: [{ name: 'requests', data: xs.map((x, i) => ({ x, y: req[i] })) }, { name: 'errors x100', data: xs.map((x, i) => ({ x, y: err[i] * 100 })) }, { name: 'p95 ms', data: xs.map((x, i) => ({ x, y: p95[i] * 3 })) }] });
  areaChart.update({ data: queue.map((y, i) => ({ x: i, y })) });
  barChart.update({ data: WEEK.map((d, i) => ({ label: d, value: (week[i] = walk(week[i], 12, 5, 100)) })) });
  hbarChart.update({ data: langs.map((l) => ({ ...l, value: Math.round(walk(l.value, 4, 2, 60)) })) });
  const rev = stacks.map((s) => ({ q: s.q, a: (s.a = walk(s.a, 4, 4, 50)), b: (s.b = walk(s.b, 3, 4, 40)), c: (s.c = walk(s.c, 2, 2, 25)) }));
  stackChart.update({ series: ['a', 'b', 'c'].map((k, i) => ({ name: ['Free', 'Pro', 'Team'][i], data: rev.map((s) => ({ x: s.q, y: Math.round(s[k]) })) })) });
  scatterChart.update({ series: [{ name: 'small', data: scatterA.map(([x, y]) => [walk(x, 0.25, 0.5, 6), walk(y, 2, 5, 45)]) }, { name: 'large', data: scatterB.map(([x, y]) => [walk(x, 0.25, 3, 10), walk(y, 2, 25, 80)]) }] });
  donutChart.update({ data: split.map((s) => ({ ...s, value: Math.round(walk(s.value, 3, 2, 70)) })) });
  heatChart.update({ data: heat.map((c) => ({ ...c, value: Math.round(walk(c.value, 14, 0, 100)) })) });
  for (const a of agents) { a.cpu = walk(a.cpu, 12, 3, 99); a.tasks += rnd() < 0.5 ? 1 : 0; a.mem = walk(a.mem, 40, 80, 950); }
  if (tick % 4 === 0) agents[1].status = agents[1].status === 'running' ? 'idle' : 'running';
  agentTable.update({ rows: agents.map((a) => ({ ...a })) });
  gantt.update({ now: Date.now(), rows: ganttRows() });
  if (tick % 3 === 0) {
    const from = BOARD_ORDER.slice(0, -1).find((id) => board[id].length && rnd() < 0.7) ?? 'todo';
    board[BOARD_ORDER[BOARD_ORDER.indexOf(from) + 1]].push(board[from].shift());
  }
  kan.update({ columns: boardColumns() });
}
step();
setInterval(step, TICK_MS);
panel.ready().then(() => panel.fit());
