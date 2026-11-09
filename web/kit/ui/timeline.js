// timeline.js - timeline / gantt: swimlanes over time. Bars sit on a shared axis; running bars grow with `now`.
import { h, build, addCss, flash } from './core.js';
import { normalizeTimeline, timeTicks, barBox, formatDuration, isNum, MS, EPOCH_MS_MIN } from './pure.js';

const MIN_BAR_PCT = 0.8;
const AXIS_TICKS = 5;
const TICK_SPACING_PX = 96; // minimum room per axis label
const EDGE_PCT = 8; // ticks closer than this to either end align their label inside the axis
const STATES = Object.freeze({ running: 'var(--ui-acc)', done: 'var(--ui-ok)', idle: 'var(--ui-dim)', failed: 'var(--ui-danger)', warn: 'var(--ui-warn)', milestone: 'var(--ui-violet)' });

addCss(`
.ui-timeline { container-type: inline-size; display: flex; flex-direction: column; gap: 8px; }
.ui-tl-row { display: grid; grid-template-columns: minmax(110px, 30%) 1fr 84px; gap: 12px; align-items: center; }
.ui-tl-name { font-weight: 600; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ui-tl-name small { display: block; color: var(--ui-mut); font-weight: 400; font-size: var(--ui-fs-s); overflow: hidden; text-overflow: ellipsis; }
.ui-tl-track { position: relative; height: 26px; background: var(--ui-card); border: 1px solid var(--ui-line); border-radius: var(--ui-r-s); }
.ui-tl-bar { position: absolute; top: 3px; bottom: 3px; border-radius: 6px; background: var(--c); min-width: 6px; transition: left .5s var(--ui-ease), width .5s var(--ui-ease); display: flex; align-items: center; overflow: hidden; }
.ui-tl-bar[data-open]::after { content: ""; position: absolute; right: 0; top: 0; bottom: 0; width: 8px; background: #fff; opacity: .8; border-radius: 6px; animation: ui-tl-pulse 1.3s ease-in-out infinite; }
@keyframes ui-tl-pulse { 50% { opacity: .2; } }
.ui-tl-bar span { font-size: var(--ui-fs-s); font-weight: 600; padding: 0 8px; color: #0b0c10; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ui-tl-bar[data-milestone] { min-width: 0; width: 14px !important; height: 14px; top: 50%; margin-top: -7px; bottom: auto; border-radius: 3px; transform: rotate(45deg); }
.ui-tl-now { position: absolute; top: -3px; bottom: -3px; width: 2px; background: var(--ui-fg); opacity: .55; border-radius: 2px; transition: left .5s var(--ui-ease); }
.ui-tl-dur { font-size: var(--ui-fs-s); color: var(--ui-mut); text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
.ui-tl-axis { position: relative; height: 20px; margin: 0 96px 0 calc(30% + 12px); }
.ui-tl-tick { position: absolute; top: 0; transform: translateX(-50%); font-size: var(--ui-fs-s); color: var(--ui-mut); white-space: nowrap; font-variant-numeric: tabular-nums; }
.ui-tl-tick[data-edge="start"] { transform: none; } .ui-tl-tick[data-edge="end"] { transform: translateX(-100%); }
.ui-tl-empty { color: var(--ui-mut); padding: 12px; text-align: center; }
@container (max-width: 520px) {
  .ui-tl-row { grid-template-columns: 1fr 84px; row-gap: 4px; }
  .ui-tl-name { grid-column: 1 / 3; } .ui-tl-name small { display: inline; margin-left: 8px; }
  .ui-tl-track { grid-column: 1; }
  .ui-tl-axis { margin: 0 96px 0 0; }
}
`);

const pad2 = (n) => String(n).padStart(2, '0');
function tickLabel(t, o, from, to) {
  if (o.format) return o.format(t);
  if (t > EPOCH_MS_MIN) {
    if (o.axis === 'clock') { const d = new Date(t); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; }
    const ago = (o.nowT ?? to) - t;
    return Math.abs(ago) < MS.second ? 'now' : `${ago > 0 ? '-' : '+'}${formatDuration(Math.abs(ago)).replace(/ (\d+ s)$/, '')}`;
  }
  return String(Math.round(t * 100) / 100);
}

/**
 * timeline({lanes: [{id, label, sub}], items: [{lane, start, end?, label, state: 'running'|'done'|'idle'|'failed'|'warn'|'milestone', color?}], now, axis: 'relative'|'clock'})
 * Also takes the agent-gantt shape: timeline({now, rows: [{name, sub, start, end?, state}]}). Times: epoch ms, Date, ISO string or plain numbers.
 * An item without `end` is still running and stretches to `now`. e.g. timeline({now: Date.now(), rows: [{name: 'build', start: Date.now() - 60000, state: 'running'}]})
 */
export function timeline(opts = {}) {
  const rowsBox = h('div.ui-tl-rows');
  const axis = h('div.ui-tl-axis');
  const el = h('div', null, rowsBox, axis);
  const lanes = new Map(); // lane id -> { row, name, sub, track, dur, bars: Map(index -> {bar,label}), now }
  return build(el, 'timeline', opts, (o) => {
    const model = normalizeTimeline(o);
    const live = new Set(model.lanes.map((l) => l.id));
    for (const [id, e] of lanes) if (!live.has(id)) { e.row.remove(); lanes.delete(id); }
    model.lanes.forEach((lane, li) => {
      let e = lanes.get(lane.id);
      if (!e) {
        const name = h('div.ui-tl-name');
        const track = h('div.ui-tl-track');
        const dur = h('div.ui-tl-dur');
        e = { row: h('div.ui-tl-row', null, name, track, dur), name, track, dur, bars: [], now: h('div.ui-tl-now') };
        lanes.set(lane.id, e);
      }
      e.name.textContent = lane.label;
      if (lane.sub) e.name.append(h('small', null, lane.sub));
      while (e.bars.length < lane.items.length) { const label = h('span'); const bar = h('div.ui-tl-bar', null, label); e.track.append(bar); e.bars.push({ bar, label }); }
      while (e.bars.length > lane.items.length) e.bars.pop().bar.remove();
      lane.items.forEach((it, i) => {
        const b = e.bars[i];
        const box = barBox(it.start, it.end, model.from, model.to, MIN_BAR_PCT);
        b.bar.style.left = `${box.left}%`;
        b.bar.style.width = `${box.width}%`;
        b.bar.style.setProperty('--c', it.color ?? STATES[it.state] ?? STATES.idle);
        b.bar.toggleAttribute('data-open', it.open && it.state === 'running');
        b.bar.toggleAttribute('data-milestone', it.milestone);
        const text = it.milestone ? '' : it.label ?? '';
        if (b.label.textContent !== text) b.label.textContent = text;
        b.bar.title = `${it.label ?? lane.label}: ${formatDuration(it.end - it.start)}`;
        if (b.state && b.state !== it.state) flash(b.bar);
        b.state = it.state;
      });
      const total = lane.items.filter((x) => !x.milestone).reduce((s, x) => s + (x.end - x.start), 0);
      e.dur.textContent = total ? (model.to > EPOCH_MS_MIN ? formatDuration(total) : String(Math.round(total * 100) / 100)) : '';
      if (isNum(model.now) && model.now >= model.from && model.now <= model.to) {
        e.now.style.left = `${barBox(model.now, model.now, model.from, model.to, 0).left}%`;
        if (!e.now.isConnected) e.track.append(e.now);
      } else e.now.remove();
      if (rowsBox.childNodes[li] !== e.row) rowsBox.insertBefore(e.row, rowsBox.childNodes[li] ?? null);
    });
    if (!model.lanes.length) rowsBox.replaceChildren(h('div.ui-tl-empty', null, o.empty ?? 'Nothing on the timeline yet'));
    else rowsBox.querySelector('.ui-tl-empty')?.remove();
    const room = axis.clientWidth || el.clientWidth;
    const ticks = timeTicks(model.from, model.to, room ? Math.max(2, Math.min(AXIS_TICKS, Math.floor(room / TICK_SPACING_PX))) : AXIS_TICKS);
    axis.replaceChildren(...ticks.map((t) => {
      const left = barBox(t, t, model.from, model.to, 0).left;
      return h('span.ui-tl-tick', { style: { left: `${left}%` }, 'data-edge': left < EDGE_PCT ? 'start' : left > 100 - EDGE_PCT ? 'end' : null }, tickLabel(t, { ...o, nowT: model.now }, model.from, model.to));
    }));
  });
}
