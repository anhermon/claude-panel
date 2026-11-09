// router-dom.js - what the two router frames (tickets, checks) share: their stylesheet and the little pieces they both draw.
import { h } from './dom.js';
import { loadCssOnce } from './css.js';

await loadCssOnce(new URL('./router-frames.css', import.meta.url).href, 'router-frames');

/** A pass / fail / pending mark: ✓ ✕ ○ (the glyph plus the class, so colour is never the only cue). */
export const markEl = (state, glyphs) => h('i', { class: `rt-mark rt-${state}`, 'aria-hidden': 'true', text: glyphs[state] });
