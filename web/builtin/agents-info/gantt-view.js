// The gantt of the agent list (DOM): a toggle and a time axis above the rows, and one track per row on that shared axis. The
// numbers come from gantt-logic.mjs; this file only draws them. Bars are updated in place (about once a second), never rebuilt.
// The mode ("Fit agents" / "Last hour" / "Whole session") lives in this module only, not in any file.
import { formatDuration } from './agents-info-logic.mjs';
import { DEFAULT_MODE, LABEL_FIT_PX, MODES, barOf, chevronLabel, endMarkOf, labelSideOf, placeBar, segmentsIn, ticksOf, tooltipOf, windowOf } from './gantt-logic.mjs';
import { h } from './dom.js';

const END_GLYPH = Object.freeze({ check: '✓', cross: '✕' });
const CHEVRON = '‹';
const DOT_PX = 10;
const END_MARK_PX = 16;
const END_GAP_PX = 3;
const PERCENT = 100;
const TOGGLE_LABEL = 'Time range';
const NOT_STARTED_TAG = 'not started';
const TAG_PX = 84;

/** Make `parent` hold exactly `n` children made by `make`, and return them. */
function pool(parent, n, make) {
  while (parent.children.length < n) parent.append(make());
  while (parent.children.length > n) parent.lastElementChild.remove();
  return [...parent.children];
}

/** The toggle and the axis. `onChange` runs when the mode changes; `update` returns the scale the tracks draw with. */
export function createGantt(headEl, listEl, onChange) {
  let mode = DEFAULT_MODE;
  let trackPx = 0;
  const toggle = h('div', 'g-toggle');
  toggle.setAttribute('role', 'group');
  toggle.setAttribute('aria-label', TOGGLE_LABEL);
  const buttons = MODES.map((m) => {
    const b = h('button', 'g-mode', m.label);
    b.type = 'button';
    b.addEventListener('click', () => { mode = m.id; paintToggle(); onChange(); });
    toggle.append(b);
    return b;
  });
  const axis = h('div', 'g-axis');
  headEl.append(toggle, axis);
  const paintToggle = () => buttons.forEach((b, i) => b.setAttribute('aria-pressed', String(MODES[i].id === mode)));
  paintToggle();
  new ResizeObserver(() => { const w = axis.clientWidth; if (w > 0 && w !== trackPx) { trackPx = w; onChange(); } }).observe(axis);

  return {
    /** Fit the window to the agents, draw the axis, and return `{ win, ticks, trackPx, now }` for the tracks. */
    update(agents, now) {
      const win = windowOf(agents, now, mode);
      const ticks = ticksOf(win, trackPx);
      headEl.hidden = agents.length === 0;
      headEl.style.setProperty('--g-gutter', `${Math.max(0, listEl.offsetWidth - listEl.clientWidth)}px`); // the list's scrollbar, so the axis lines up with the tracks
      const els = pool(axis, ticks.length, () => h('span', 'g-tick'));
      ticks.forEach((t, i) => {
        const el = els[i];
        el.style.left = `${t.frac * PERCENT}%`;
        el.dataset.anchor = t.anchor;
        el.textContent = t.label;
      });
      return { win, ticks, trackPx, now };
    },
  };
}

/** The track of one row: grid lines, the bar with its kind segments, a start dot, an end mark and the chevron of a clipped start. */
export function createTrack() {
  const el = h('span', 'g-track');
  const grid = h('span', 'g-grid');
  const bar = h('span', 'g-bar');
  const dot = h('i', 'g-dot');
  const end = h('b', 'g-end');
  const chev = h('span', 'g-chev');
  const lab = h('span', 'g-lab');
  const tag = h('span', 'g-tag', NOT_STARTED_TAG);
  el.append(grid, bar, dot, end, chev, lab, tag);
  el.setAttribute('role', 'img');

  return {
    el,
    set(a, scale, kinds) {
      const { win, ticks, now } = scale;
      const px = scale.trackPx > 0 ? scale.trackPx : el.clientWidth;
      const place = barOf(a, win, now);
      const text = tooltipOf(a, now, kinds);
      el.title = text;
      el.setAttribute('aria-label', text);
      el.dataset.state = a.state;
      pool(grid, ticks.length, () => h('i')).forEach((g, i) => { g.style.left = `${ticks[i].frac * PERCENT}%`; });
      bar.hidden = place.outside;
      dot.hidden = place.outside || place.clipped;
      end.hidden = place.outside || endMarkOf(a) === null;
      chev.hidden = !place.clipped;
      lab.hidden = true;
      tag.hidden = true;
      if (place.clipped) chev.textContent = `${CHEVRON} ${chevronLabel(a, now)}`;
      if (place.outside) return;
      const { left, width } = placeBar(place, px);
      bar.style.left = `${left}px`;
      bar.style.width = `${width}px`;
      bar.dataset.running = String(place.running && (a.state === 'working' || a.state === 'testing'));
      bar.dataset.clipped = String(place.clipped);
      bar.dataset.notStarted = String(a.notStarted);
      if (a.notStarted) {
        tag.hidden = false;
        const isRoom = left + width + END_GAP_PX * 2 + TAG_PX <= px;
        tag.dataset.side = isRoom ? 'right' : 'left';
        tag.style.left = `${isRoom ? left + width + END_GAP_PX * 2 : Math.max(0, left - TAG_PX - END_GAP_PX)}px`;
        return;
      }
      const segs = segmentsIn(a, win, now, kinds);
      pool(bar, segs.length, () => h('i', 'g-seg')).forEach((s, i) => {
        s.style.left = `${segs[i].l * PERCENT}%`;
        s.style.width = `${segs[i].w * PERCENT}%`;
        s.style.background = segs[i].color;
        s.dataset.k = segs[i].k;
      });
      dot.style.left = `${Math.max(0, left - DOT_PX / 2)}px`;
      const mark = endMarkOf(a);
      if (mark !== null) {
        end.textContent = END_GLYPH[mark];
        end.dataset.mark = mark;
        const right = left + width + END_GAP_PX;
        end.style.left = `${Math.min(right, px - END_MARK_PX)}px`;
      }
      const side = labelSideOf({ left, width }, px, mark === null ? 0 : END_MARK_PX + END_GAP_PX);
      if (side !== null) {
        lab.hidden = false;
        lab.textContent = formatDuration((a.endedAt ?? now) - a.startedAt);
        lab.dataset.side = side;
        lab.style.left = side === 'right' ? `${left + width + (mark === null ? 0 : END_MARK_PX + END_GAP_PX) + END_GAP_PX}px` : `${Math.max(0, left - LABEL_FIT_PX - END_GAP_PX)}px`;
      }
    },
  };
}
