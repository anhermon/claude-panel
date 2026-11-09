// Pure helpers for "make the content fill its frame": find the biggest font that still fits, and how much room is left.
// The DOM side (frames/fit.js) supplies the measuring; everything that decides lives here so Node can test it.

/**
 * The largest font (floor itself or a whole px) in [floor, ceil] for which fits(px) is true. fits must be monotone (a smaller font fits
 * whenever a bigger one does). Returns floor when even floor does not fit: the caller can do no better than the floor.
 */
export function fitFont({ floor, ceil, fits }) {
  let lo = floor; // may be fractional (the floor follows the stage size); the answer is the floor itself or a whole px above it
  let hi = Math.max(lo, Math.floor(ceil));
  if (fits(hi)) return hi;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (mid <= lo) break; // cannot happen while hi - lo > 1; never spin if it did
    if (fits(mid)) lo = mid; else hi = mid;
  }
  return lo;
}

/** The extra gap between `n` stacked items so they use the spare height, but never more than `maxGap` each. */
export const spreadGap = ({ spare, n, maxGap }) => (n > 1 ? Math.max(0, Math.min(maxGap, spare / (n - 1))) : 0);

/** How far a font may grow: a share of the box width, between the floor and `maxTimes` x the floor. */
export const ceilFont = ({ width, share, floor, maxTimes }) => Math.max(floor, Math.min(width * share, floor * maxTimes));
