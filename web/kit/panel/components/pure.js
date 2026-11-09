// pure.js - DOM-free helpers shared by the house elements (and unit-tested under node).

export const WAVE_BUCKETS = 160;

/** Strips leading/trailing blank lines and the common indentation of a block of text written inside an HTML tag. */
export function dedent(text) {
  const lines = String(text ?? '').replace(/\t/g, '  ').split('\n');
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines.at(-1).trim()) lines.pop();
  const indent = Math.min(...lines.filter((l) => l.trim()).map((l) => l.match(/^ */)[0].length));
  return lines.map((l) => l.slice(Number.isFinite(indent) ? indent : 0).replace(/\s+$/, '')).join('\n');
}

/** Parses a JSON attribute. Returns {value} or {error: message}. */
export function parseJson(text) {
  try { return { value: JSON.parse(text) }; } catch (err) { return { error: err.message }; }
}

/** Boolean attribute: present and not "false"/"0"/"off". */
export const flag = (value) => value !== null && value !== undefined && !/^(false|0|off|no)$/i.test(String(value).trim());

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * Turns the many shapes of `data` into Chart.js' {labels, datasets}:
 *  - {labels, datasets}              passed through (native Chart.js data)
 *  - [1, 2, 3]                       one series, labels 1..n
 *  - [{month:'Jan', a:1, b:2}, ...]  x = the `x` key (default: first string key), series = `y` keys (comma list; default: all numeric keys)
 *  - scatter: x and y are both numeric keys; every y key becomes a series of {x, y} points
 */
export function normalizeChartData(raw, { x = '', y = '', type = 'bar' } = {}) {
  if (raw && !Array.isArray(raw) && Array.isArray(raw.datasets)) return { labels: raw.labels ?? [], datasets: raw.datasets };
  if (!Array.isArray(raw)) throw new Error('data must be an array of numbers, an array of objects, or {labels, datasets}');
  if (raw.length === 0) return { labels: [], datasets: [] };
  if (raw.every(isNum)) return { labels: raw.map((_, i) => String(i + 1)), datasets: [{ label: y || 'value', data: raw }] };
  if (!raw.every((r) => r && typeof r === 'object' && !Array.isArray(r))) throw new Error('data rows must all be numbers or all be objects');
  const keys = Object.keys(raw[0]);
  const wantY = y ? y.split(',').map((k) => k.trim()).filter(Boolean) : [];
  const xKey = x || keys.find((k) => (type === 'scatter' ? isNum(raw[0][k]) : typeof raw[0][k] === 'string')) || keys[0];
  const yKeys = wantY.length ? wantY : keys.filter((k) => k !== xKey && isNum(raw[0][k]));
  if (!yKeys.length) throw new Error(`no numeric series found next to "${xKey}"; name them with the y attribute`);
  const missing = [xKey, ...yKeys].filter((k) => !keys.includes(k));
  if (missing.length) throw new Error(`data has no key "${missing[0]}" (keys: ${keys.join(', ')})`);
  if (type === 'scatter') return { labels: [], datasets: yKeys.map((k) => ({ label: k, data: raw.map((r) => ({ x: Number(r[xKey]), y: Number(r[k]) })) })) };
  return { labels: raw.map((r) => String(r[xKey])), datasets: yKeys.map((k) => ({ label: k, data: raw.map((r) => r[k]) })) };
}

/** '#rrggbb' | '#rgb' | 'rgb(...)' -> 'rgba(r,g,b,a)'. Anything else is returned unchanged. */
export function alpha(color, a) {
  const c = String(color).trim();
  let m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c);
  if (m) {
    const hex = m[1].length === 3 ? [...m[1]].map((d) => d + d).join('') : m[1];
    const n = Number.parseInt(hex, 16);
    return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
  }
  m = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/i.exec(c);
  return m ? `rgba(${m[1]}, ${m[2]}, ${m[3]}, ${a})` : c;
}

/** Max-abs peaks of a sample array in `buckets` buckets, scaled so the loudest is 1. */
export function peaks(samples, buckets = WAVE_BUCKETS) {
  const out = new Array(buckets).fill(0);
  if (!samples || !samples.length) return out;
  const size = samples.length / buckets;
  for (let b = 0; b < buckets; b++) {
    const from = Math.floor(b * size);
    const to = Math.max(from + 1, Math.floor((b + 1) * size));
    let max = 0;
    for (let i = from; i < to && i < samples.length; i++) max = Math.max(max, Math.abs(samples[i]));
    out[b] = max;
  }
  const top = Math.max(...out);
  return top > 0 ? out.map((p) => p / top) : out;
}

export function formatTime(seconds) {
  const s = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/** Greedy word wrap on spaces; words longer than `max` stay whole. */
export function wrapText(text, max) {
  const lines = [];
  let line = '';
  for (const word of String(text).split(/\s+/).filter(Boolean)) {
    if (line && line.length + 1 + word.length > max) { lines.push(line); line = word; } else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}
