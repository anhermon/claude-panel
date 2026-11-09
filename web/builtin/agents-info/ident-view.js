// The two identity labels of an agent (its type verbatim, then model:effort) as one small element, used by list rows and crew tiles.
// The element is hidden when neither is known; the full type is always in the tooltip, the visible one is cut in the middle (CSS: the head part takes an ellipsis, the tail stays) if it must be.
import { h } from './dom.js';
import { identLine, modelEffortOf, splitType, typeOf } from './ident-logic.mjs';

export function createIdent() {
  const el = h('span', 'ident');
  const type = h('span', 'ident-type');
  const head = h('span', 'ident-head');
  const tail = h('span', 'ident-tail');
  type.append(head, tail);
  const model = h('span', 'ident-model');
  el.append(type, model);
  return {
    el,
    set(agent) {
      const parts = splitType(typeOf(agent));
      head.textContent = parts.head;
      tail.textContent = parts.tail;
      type.hidden = typeOf(agent) === '';
      model.textContent = modelEffortOf(agent);
      model.hidden = model.textContent === '';
      el.hidden = type.hidden && model.hidden;
      el.title = identLine(agent);
    },
  };
}
