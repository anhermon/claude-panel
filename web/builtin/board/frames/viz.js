// viz: a freeform visual asset chosen by information shape. Fields: kind (sankey, treemap, network, radar, ... see kit/assets), data (that
// asset's own schema), caption. The library loads on first use (a dynamic import, so a missing kit file shows a message here and never blanks
// the board); bad data or an unknown kind draws an error panel that names the field / lists the valid kinds. New data of the same kind
// redraws in place; a new kind re-renders the frame.
import { h, uiScale } from './dom.js';

const ENGINE = 'panel/assets';
const LOAD_FAILED = 'visual asset library unavailable';
const FONT_BASE_PX = 14; // the board's text floor, scaled like the html frames
const FONT_MAX_PX = 22;
const states = new WeakMap(); // layer element -> { handle, latest, dead }

// The kit's asset tokens are dark by default but follow prefers-color-scheme; the board is always dark.
const pinDark = () => { document.documentElement.dataset.theme ||= 'dark'; };
const optionsOf = (f) => ({ fill: true, caption: f.caption, fs: Math.min(FONT_MAX_PX, FONT_BASE_PX * uiScale()), minPx: FONT_BASE_PX * uiScale() });

export function render(el, f, ctx) {
  pinDark();
  const state = { handle: null, latest: f, dead: false, kind: f.kind };
  states.set(el, state);
  import(ENGINE).then(({ render: draw }) => {
    if (state.dead) return;
    state.handle = draw(state.latest.kind, state.latest.data, optionsOf(state.latest));
    el.append(state.handle);
  }).catch(() => { if (!state.dead) el.append(h('p', { style: 'padding:4px 8px;font-size:14px;color:var(--danger)', text: LOAD_FAILED })); });
  ctx.onDispose(() => { state.dead = true; state.handle?.destroy?.(); states.delete(el); });
}

export function update(el, f) {
  const state = states.get(el);
  if (!state || f.kind !== state.kind) return false;
  state.latest = f;
  if (!state.handle?.update) return state.handle === null; // still loading: the load picks up `latest`
  state.handle.update(f.data, { caption: f.caption });
  return true;
}
