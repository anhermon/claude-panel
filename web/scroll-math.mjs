// scroll-math.mjs - the pure half of "scroll the hero tile from the terminal pane": the control line
// {"cmd":"scroll","steps":2,"pages":-1,"edge":"top"} -> the wheel movements live.mjs sends over the tile. Shared by
// live.mjs (acts) and tests; hooks/live-proto.ts writes the same line (its tests pin the two together).

export const SCROLL_STEP_PX = 120; // one step (a j / k press): about a mouse-wheel notch and a bit
export const SCROLL_PAGE_FRACTION = 0.85; // one page: this share of the tile's height, so a line of context stays
export const SCROLL_EDGE_PX = 100_000; // "to the top / bottom": a wheel move longer than any page, the browser clamps it
export const SCROLL_COUNT_MAX = 50; // most steps or pages one line may carry
export const SCROLL_EDGES = Object.freeze(['top', 'bottom']);

const isCount = (n) => Number.isInteger(n) && Math.abs(n) <= SCROLL_COUNT_MAX;

/** The scroll part of a control line, normalised ({ edge?, steps, pages }), or null when it is malformed or moves nothing. */
export function parseScroll(v) {
  const steps = v.steps ?? 0;
  const pages = v.pages ?? 0;
  if (!isCount(steps) || !isCount(pages)) return null;
  if (v.edge !== undefined && !SCROLL_EDGES.includes(v.edge)) return null;
  if (v.edge === undefined && steps === 0 && pages === 0) return null;
  return { cmd: 'scroll', ...(v.edge === undefined ? {} : { edge: v.edge }), steps, pages };
}

/** The wheel deltas (px, positive = down), in order, for one scroll command on a tile `tileHeight` px tall: the edge first, then the moves. */
export function wheelDeltas({ edge, steps = 0, pages = 0 }, tileHeight) {
  const out = [];
  if (edge === 'top') out.push(-SCROLL_EDGE_PX);
  if (edge === 'bottom') out.push(SCROLL_EDGE_PX);
  const moved = steps * SCROLL_STEP_PX + pages * Math.round(Math.max(0, tileHeight) * SCROLL_PAGE_FRACTION);
  if (moved !== 0) out.push(moved);
  return out;
}
