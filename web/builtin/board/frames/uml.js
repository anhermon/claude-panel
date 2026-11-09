// uml: Mermaid text drawn by the kit's diagram engine (sequence, flowchart, state, class, ER, ... see kit/diagrams/diagram.js).
// Fields: code (<= UML_CODE_MAX chars), highlight {nodeId: 'active'|'done'|'blocked'|'todo'}. The engine and Mermaid load on first
// use (a dynamic import, so a missing kit file shows a message in this frame and never blanks the board); a new code re-renders
// without flicker and keeps the previous drawing when the text is invalid; a click on a node posts panel.emit('diagram', {id, frame}).
import { h } from './dom.js';

const UML_CODE_MAX = 4096; // keep in step with FRAME_CAPS.UML_CODE_CHARS (hooks/board-frames.ts)
const ENGINE = 'panel/diagrams';
const LOAD_FAILED = 'diagram engine unavailable';
const states = new WeakMap(); // layer element -> { handle, latest }

const codeOf = (f) => (typeof f.code === 'string' ? f.code.slice(0, UML_CODE_MAX) : '');

export function render(el, f, ctx) {
  const host = h('div', { style: 'position:absolute;inset:0' });
  el.append(host);
  const state = { handle: null, latest: f, dead: false };
  states.set(el, state);
  ctx.onDispose(() => { state.dead = true; state.handle?.destroy(); states.delete(el); });
  import(ENGINE).then(({ renderDiagram }) => {
    if (state.dead) return;
    state.handle = renderDiagram(host, {
      code: codeOf(state.latest), highlight: state.latest.highlight,
      emit: (name, data) => ctx.emit(name, { ...data, frame: ctx.frameId }),
    });
  }).catch(() => { if (!state.dead) host.append(h('p', { class: 'uml-err', style: 'position:static;padding:4px 8px;font-size:14px;color:var(--danger)', text: LOAD_FAILED })); });
}

export function update(el, f) {
  const state = states.get(el);
  if (!state) return false;
  state.latest = f;
  state.handle?.update(codeOf(f), f.highlight);
  return true;
}
