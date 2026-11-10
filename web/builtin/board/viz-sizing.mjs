// Measured natural viz heights include the frame's heading, padding and borders.
// Keep this independent of asset kind: size hints cannot predict arbitrary HTML.
import { MODE_SCROLL } from './scroll-logic.mjs';

const ROUNDING_SLACK_PX = 1;

export function sizeVizPlan(plan, heights, { height, gap = 0 }) {
  if (plan.mode === MODE_SCROLL) {
    return { ...plan, cells: plan.cells.map((cell) => {
      const need = heights.get(cell.id) ?? 0;
      return plan.narrow
        ? { ...cell, px: Math.max(cell.px, need) }
        : { ...cell, h: Math.max(cell.h, Math.ceil((need + gap) / (plan.rowPx + gap))) };
    }) };
  }
  const room = Math.max(0, height - gap * (plan.rows - 1));
  const totalWeight = plan.weights?.reduce((sum, weight) => sum + weight, 0);
  const clipped = plan.cells.filter((cell) => {
    const share = totalWeight ? plan.weights[cell.row] / totalWeight : cell.h / plan.rows;
    const available = room * share + gap * (cell.h - 1);
    return (heights.get(cell.id) ?? 0) > available + ROUNDING_SLACK_PX;
  }).length;
  return { ...plan, hidden: plan.hidden + clipped };
}
