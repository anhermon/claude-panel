// text: one big sentence (and an optional smaller line under it). The headline shrinks (to a floor) so both always fit.
import { CAPS, capLines, capText, capTitle } from '../board-logic.mjs';
import { h } from './dom.js';
import { headlineFloorTimes } from '../fit-logic.mjs';
import { fitHeadline } from './fit.js';

const SHORT_MAX = 32;
const MID_MAX = 60;
const ANSWER_LINES = 8;

export function render(el, f, ctx) {
  const isAnswer = f.id === 'last-answer'; // the mod's own frame carries a paragraph, or short lines (bullets) that keep their breaks
  const lines = isAnswer ? capLines(f.text, CAPS.answer, ANSWER_LINES) : [];
  if (lines.length > 1) {
    const main = h('div', { class: 'text-main text-lines' }, lines.map((line) => h('p', { class: 'text-line', text: line })));
    el.append(h('div', { class: 'text', 'data-len': 'long' }, h('div', { class: 'text-body' }, main)));
    ctx.onDispose(fitHeadline(el.lastElementChild, main, headlineFloorTimes(lines.length)));
    return;
  }
  const text = isAnswer ? capText(f.text, CAPS.answer) : capTitle(f.text, CAPS.text);
  const sub = capTitle(f.sub, CAPS.sub);
  const bucket = text.length <= SHORT_MAX ? 'short' : text.length <= MID_MAX ? 'mid' : 'long';
  const main = h('p', { class: 'text-main', text });
  const root = h('div', { class: 'text', 'data-len': bucket }, h('div', { class: 'text-body' }, main, sub && h('p', { class: 'text-sub', text: sub })));
  el.append(root);
  ctx.onDispose(fitHeadline(root, main));
}
