// fit.js - the DOM side of "fill the frame, never overflow it": measure with real layout, let fit-logic.mjs decide.
import { ceilFont, fitFont, spreadGap } from '../fit-logic.mjs';
import { h, watchSize } from './dom.js';

const SLACK_PX = 1; // rounding of the measured heights
const FIT_MARGIN_PX = 2; // content stays this far inside the box (the audit tolerates 2px of text outside it)
const DEFAULT_LEVELS = [{ name: 'roomy' }];
const HEADLINE_FLOOR_TIMES = 1.5; // a headline shrinks to this many times the body-text floor, no further

/** The body-text floor (--fs) in px, read from a probe so it follows the stage size. */
export function textFloorPx(box) {
  const probe = h('i', { style: 'position:absolute;visibility:hidden;font-size:var(--fs)' });
  box.append(probe);
  const px = parseFloat(getComputedStyle(probe).fontSize);
  probe.remove();
  return px;
}

const fitsHeight = (box, content) => content.offsetHeight + FIT_MARGIN_PX <= box.clientHeight;
/** Does any line-clamped or ellipsised element under `box` (matching `selector`) hide text? */
const hidesText = (box, selector) => !!selector && [...box.querySelectorAll(selector)].some((el) => el.scrollHeight > el.clientHeight + SLACK_PX || el.scrollWidth > el.clientWidth + SLACK_PX);

/** The largest font in [floor, ceil] at which `content` fits the height of `box` and no `clamped` element (line-clamped or ellipsised) cuts its text; apply(px) sets it. */
export function fitInto({ box, content, floor, ceil, apply, clamped = '' }) {
  const px = fitFont({ floor, ceil, fits: (v) => { apply(v); return fitsHeight(box, content) && !hidesText(box, clamped); } });
  apply(px); // the search ends on whatever it tried last, not on the answer
  return px;
}

/** A headline (text / now): shrinks from its natural size to HEADLINE_FLOOR_TIMES x the text floor so it never clips. */
export function fitHeadline(box, main) {
  const body = main.parentElement;
  const run = () => {
    main.style.removeProperty('--hl');
    delete main.dataset.shrunk;
    const natural = parseFloat(getComputedStyle(main).fontSize);
    const px = fitInto({ box, content: body, floor: Math.min(natural, textFloorPx(box) * HEADLINE_FLOOR_TIMES), ceil: natural, apply: (v) => main.style.setProperty('--hl', `${v}px`) });
    if (px < natural) main.dataset.shrunk = 'true'; else main.style.removeProperty('--hl');
  };
  return watchSize(box, run);
}

/**
 * A stack of rows (agent rows, checklist): the biggest font that fits (grows with few rows, up to `maxTimes` x the floor
 * and `share` of the width), tighter wording (box.dataset.fit = the next of `levels` ({ name, maxTimes? })) when even the floor does not fit, and the
 * leftover height spread between the rows (--spread) up to `maxSpreadEm`, or (up to `growUpTo` rows) given to the rows themselves
 * (box.dataset.grow, see board.css).
 */
export function fitStack({ box, content, share, maxTimes, maxSpreadEm, rows, clamped, growUpTo = 0, levels = DEFAULT_LEVELS }) {
  const run = () => {
    delete box.dataset.grow; // measured at natural height, then (for few rows) the rows grow to fill the box
    const floor = textFloorPx(box);
    const ceil = ceilFont({ width: box.clientWidth, share, floor, maxTimes });
    const apply = (px) => { box.style.fontSize = `${px}px`; };
    box.style.setProperty('--spread', '0px');
    let px = floor;
    for (const level of levels) { // wording gets tighter (box.dataset.fit) only while even the floor font does not fit
      box.dataset.fit = level.name;
      px = fitInto({ box, content, floor, ceil: level.maxTimes ? Math.min(ceil, floor * level.maxTimes) : ceil, apply, clamped }); // tight wording stays near the floor
      if (fitsHeight(box, content)) break;
    }
    const spare = box.clientHeight - content.offsetHeight - FIT_MARGIN_PX;
    const grow = rows() <= growUpTo;
    if (grow) box.dataset.grow = 'true';
    box.style.setProperty('--spread', `${grow ? 0 : spreadGap({ spare, n: rows(), maxGap: px * maxSpreadEm })}px`);
  };
  return { stop: watchSize(box, run), refit: run };
}
