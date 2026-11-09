// Pure formatters of the fleet page (no DOM): ages, durations, counts, token amounts, model names. Every number the page shows
// goes through these, so units are consistent and tested in Node (web/fleet/page.test.mjs).
const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const KILO = 1000;
const MEGA = 1000 * KILO;
const FRESH_MS = 1500; // below this an age reads "just now"

/** "just now", "12 s", "3 min", "2 h", "1 d": an age in ms as a short phrase (no "ago"; the caller adds the unit sentence). */
export function age(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return 'unknown';
  if (ms < FRESH_MS) return 'just now';
  if (ms < MIN) return `${Math.round(ms / SEC)} s`;
  if (ms < HOUR) return `${Math.round(ms / MIN)} min`;
  if (ms < DAY) return `${Math.round(ms / HOUR)} h`;
  return `${Math.round(ms / DAY)} d`;
}

/** "12 s ago", "just now". */
export const ago = (ms) => { const a = age(ms); return a === 'just now' || a === 'unknown' ? a : `${a} ago`; };

/** A duration: "33 s", "2 min 5 s", "1 h 3 min". */
export function duration(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return 'n/a';
  if (ms < MIN) return `${Math.round(ms / SEC)} s`;
  if (ms < HOUR) { const m = Math.floor(ms / MIN); const s = Math.round((ms % MIN) / SEC); return s === 0 ? `${m} min` : `${m} min ${s} s`; }
  const h = Math.floor(ms / HOUR);
  return `${h} h ${Math.round((ms % HOUR) / MIN)} min`;
}

/** 1234 -> "1.2k", 3400000 -> "3.4M"; small numbers as is. */
export function count(n) {
  if (!Number.isFinite(n)) return '0';
  if (n < KILO) return String(Math.round(n));
  if (n < MEGA) return `${(n / KILO).toFixed(n < 10 * KILO ? 1 : 0).replace(/\.0$/, '')}k`;
  return `${(n / MEGA).toFixed(n < 10 * MEGA ? 1 : 0).replace(/\.0$/, '')}M`;
}

/** Bytes as KB / MB / GB. */
export function bytes(n) {
  if (!Number.isFinite(n)) return 'n/a';
  if (n < KILO) return `${n} B`;
  if (n < MEGA) return `${Math.round(n / KILO)} KB`;
  if (n < MEGA * KILO) return `${(n / MEGA).toFixed(1)} MB`;
  return `${(n / (MEGA * KILO)).toFixed(1)} GB`;
}

/** "claude-sonnet-5-5" -> "sonnet 5.5"; unknown shapes are returned shortened but intact. */
export function modelName(model) {
  if (typeof model !== 'string' || model === '') return 'unknown model';
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(model);
  return m === null ? model.replace(/^claude-/, '') : `${m[1]} ${m[2]}${m[3] ? `.${m[3]}` : ''}`;
}

/** The entrypoint as the badge text. */
export function entrypointLabel(entrypoint) {
  const map = { cli: 'CLI', 'claude-desktop': 'Desktop', 'sdk-cli': 'SDK', 'sdk-ts': 'SDK', 'sdk-py': 'SDK' };
  return entrypoint === null || entrypoint === undefined ? 'unknown' : (map[entrypoint] ?? entrypoint);
}

/** Percent (0..100, one decimal at most) of part in whole; 0 when the whole is 0. */
export const pct = (part, whole) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0);

/** The age of `at` against the server clock reconstructed from the last state: `serverNow` = generatedAt + time since receipt. */
export const ageAt = (at, serverNow) => (at === null || at === undefined ? null : Math.max(0, serverNow - at));
