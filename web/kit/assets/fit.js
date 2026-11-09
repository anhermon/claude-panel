// fit.js - shared by network/decision/layers: a paint area whose height follows the content. Trees and stacks can need more
// height than the default box; a non-fill stage grows (the wrapper only sets the stage height when the WIDTH changes, so this is
// stable), a fill stage (board frame, fixed box) scales the group down instead.
import { s } from './core.js';

const MAX_GROW_PX = 2400;

/** {g, h}: a <g> in ctx.svg and the height to lay out in (>= ctx.h). `need` = the height the content wants. */
export function paintArea(ctx, need) {
  const g = s('g');
  ctx.svg.append(g);
  const want = Math.round(Math.min(Math.max(need, ctx.h), MAX_GROW_PX));
  if (want === ctx.h) return { g, h: ctx.h };
  if (ctx.fill) {
    const k = ctx.h / want;
    g.setAttribute('transform', `translate(${(ctx.w * (1 - k)) / 2},0) scale(${k})`);
    return { g, h: want };
  }
  ctx.svg.setAttribute('height', want);
  ctx.svg.setAttribute('viewBox', `0 0 ${ctx.w} ${want}`);
  if (ctx.svg.parentElement) ctx.svg.parentElement.style.height = `${want}px`;
  return { g, h: want };
}
