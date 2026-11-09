// The event ticker: one line per status change ("Work-kind classifier testing", "Deep per-agent insight done · 26 min"), newest on top, each fading out after a while.
// Only events the page has not shown yet get here (agents-info-logic.mjs newEvents), so a reload shows nothing. Reduced motion:
// the lines appear and leave without a fade.
import { createAvatarView } from './avatar-set.js';

const TTL_MS = 9000;
const MAX_LINES = 4;

export function createTicker(listEl, hooks) {
  const live = [];
  function drop(item) {
    clearTimeout(item.timer);
    item.avatar?.dispose();
    item.node.remove();
    const i = live.indexOf(item);
    if (i >= 0) live.splice(i, 1);
  }
  return {
    push(events) {
      for (const e of events) {
        const node = document.createElement('li');
        node.className = `tick tick-${e.kind}`;
        node.style.setProperty('--c', hooks.colorOf(e.agent));
        const avatar = hooks.stateOf ? createAvatarView({ key: e.agent }) : null;
        avatar?.set(hooks.stateOf(e.agent), null, hooks.harnessOf?.(e.agent));
        const dot = avatar ? avatar.el : document.createElement('i');
        const text = document.createElement('span');
        text.textContent = hooks.textOf ? hooks.textOf(e) : e.text;
        node.append(dot, text);
        listEl.prepend(node);
        const item = { node, avatar, timer: setTimeout(() => drop(item), TTL_MS) };
        live.unshift(item);
        while (live.length > MAX_LINES) drop(live[live.length - 1]);
      }
    },
    count: () => live.length,
    dispose() { for (const i of [...live]) drop(i); },
  };
}
export const TICKER = Object.freeze({ ttlMs: TTL_MS, maxLines: MAX_LINES });
