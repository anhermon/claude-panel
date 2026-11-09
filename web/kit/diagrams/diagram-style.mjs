// The diagram engine's stylesheet (one <style> element per page). Colours come from custom properties that diagram.js sets on
// the root from the host's tokens; nothing here is a fixed colour except the last-resort fallbacks. Motion exists only for
// an `active` node (soft pulse) and the edges leaving it (dashes flowing toward the arrowhead), and never under reduced motion.
export const STYLE_ID = 'panel-uml-style';
export const PULSE_S = 1.8;
export const FLOW_S = 0.9;
export const FLOW_DASH = '8 6';
export const FLOW_OFFSET = -14;
export const GLOW_PX = 5;
export const BUTTON_PX = 30;
export const CUE_FADE_PX = 28;

export const UML_CSS = `
.uml { position: relative; width: 100%; height: 100%; overflow: hidden; touch-action: pan-y; user-select: none; -webkit-user-select: none; cursor: grab;
  color: var(--uml-fg); font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
.uml.dragging { cursor: grabbing; }
.uml-pan { position: absolute; left: 0; top: 0; transform-origin: 0 0; }
.uml-pan svg { display: block; max-width: none; overflow: visible; }
.uml-fit { position: absolute; right: 6px; top: 6px; width: ${BUTTON_PX}px; height: ${BUTTON_PX}px; padding: 0; display: grid; place-items: center; border-radius: 8px;
  border: 1px solid var(--uml-line); background: color-mix(in srgb, var(--uml-bg) 88%, transparent); color: var(--uml-mut); cursor: pointer; opacity: 0; transition: opacity .2s; }
.uml:hover .uml-fit, .uml-fit:focus-visible { opacity: .9; }
.uml-fit:hover { color: var(--uml-fg); }
@media (hover: none) { .uml-fit { opacity: .6; } }
.uml-fit svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
.uml-cue { position: absolute; right: 8px; bottom: 6px; margin: 0; padding: 1px 9px; border-radius: 999px; font-size: 12px; line-height: 1.4; pointer-events: none;
  color: var(--uml-fg); background: color-mix(in srgb, var(--uml-bg) 82%, transparent); border: 1px solid var(--uml-line); }
.uml-cue[hidden] { display: none; }
.uml[data-crop="x"]::after, .uml[data-crop="xy"]::after { content: ""; position: absolute; top: 0; right: 0; bottom: 0; width: ${CUE_FADE_PX}px; pointer-events: none;
  background: linear-gradient(to right, transparent, var(--uml-bg)); }
.uml[data-crop="y"]::after, .uml[data-crop="xy"]::before { content: ""; position: absolute; left: 0; right: 0; bottom: 0; height: ${CUE_FADE_PX}px; pointer-events: none;
  background: linear-gradient(to bottom, transparent, var(--uml-bg)); }
.uml-fit, .uml-cue, .uml-err { z-index: 1; }
.uml-err { position: absolute; left: 6px; right: 44px; bottom: 4px; margin: 0; padding: 2px 8px; border-radius: 6px; font-size: 14px; line-height: 1.3; white-space: pre-wrap;
  max-height: 30%; overflow: auto; color: var(--uml-danger); background: color-mix(in srgb, var(--uml-bg) 92%, transparent); border: 1px solid color-mix(in srgb, var(--uml-danger) 45%, transparent); }
.uml-err[hidden] { display: none; }
.uml g.node, .uml g.cluster, .uml rect.actor, .uml g.classGroup, .uml g.statediagram-state { cursor: pointer; }
.uml [data-hl="active"] { --hl: var(--uml-active); }
.uml [data-hl="done"] { --hl: var(--uml-done); }
.uml [data-hl="blocked"] { --hl: var(--uml-blocked); }
.uml [data-hl="todo"] { --hl: var(--uml-todo); }
.uml [data-hl] :is(rect, path, polygon, circle, ellipse):not(.actor-line), .uml rect[data-hl] {
  stroke: var(--hl) !important; stroke-width: 2.5px !important; fill: color-mix(in srgb, var(--hl) 16%, var(--uml-bg)) !important; }
.uml [data-hl="todo"] :is(rect, path, polygon, circle, ellipse):not(.actor-line), .uml rect[data-hl="todo"] { stroke-dasharray: 5 4; fill: var(--uml-bg) !important; }
.uml [data-hl="todo"] { opacity: .75; }
.uml [data-flow] { stroke: var(--uml-active) !important; stroke-width: 2.5px !important; }
.uml[data-animate="on"] [data-hl="active"] { animation: uml-pulse ${PULSE_S}s ease-in-out infinite; }
.uml[data-animate="on"] [data-flow] { stroke-dasharray: ${FLOW_DASH} !important; animation: uml-flow ${FLOW_S}s linear infinite; }
@keyframes uml-pulse { 50% { filter: drop-shadow(0 0 ${GLOW_PX}px var(--hl)); } }
@keyframes uml-flow { to { stroke-dashoffset: ${FLOW_OFFSET}; } }
@media (prefers-reduced-motion: reduce) { .uml [data-hl], .uml [data-flow] { animation: none !important; } }
`;
