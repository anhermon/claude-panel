// components.js - the house custom elements. `import 'panel/components'` registers them all; each loads its library
// (chart.js, three, highlight.js ...) lazily when it first appears, and renders an inline error instead of throwing.
//   <p-chart>    Chart.js chart from inline JSON or a file       <p-3d>        three.js viewer (primitive shape or .glb)
//   <p-audio>    player with level bars / waveform               <p-code>      highlighted code (highlight.js)
//   <p-md>       sanitised Markdown (marked)                      <p-math>      KaTeX
//   <p-compare>  before/after image slider                        <p-timeline>  animated vertical timeline
//   <p-diagram>  auto-laid-out node-link diagram (SVG)
import { PChart } from './components/p-chart.js';
import { P3d } from './components/p-3d.js';
import { PAudio } from './components/p-audio.js';
import { PCode } from './components/p-code.js';
import { PMd } from './components/p-md.js';
import { PMath } from './components/p-math.js';
import { PCompare } from './components/p-compare.js';
import { PTimeline } from './components/p-timeline.js';
import { PDiagram } from './components/p-diagram.js';
import { sanitizeHtml } from './components/sanitize.js';

export const ELEMENTS = {
  'p-chart': PChart, 'p-3d': P3d, 'p-audio': PAudio, 'p-code': PCode, 'p-md': PMd,
  'p-math': PMath, 'p-compare': PCompare, 'p-timeline': PTimeline, 'p-diagram': PDiagram,
};

/** Defines every element that is not defined yet (safe to call twice). */
export function register() {
  for (const [tag, ctor] of Object.entries(ELEMENTS)) if (!customElements.get(tag)) customElements.define(tag, ctor);
}

register();
export { PChart, P3d, PAudio, PCode, PMd, PMath, PCompare, PTimeline, PDiagram, sanitizeHtml };
