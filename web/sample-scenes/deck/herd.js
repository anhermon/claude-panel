// herd.js - the thundering-herd simulation behind the deck: pure maths (seeded, so a run is repeatable) plus one canvas painter.
// Model: CLIENTS clients all fail at t=0 and retry RETRIES times; the wait before retry k is BASE_S * 2^k, shaped by a jitter strategy.
export const CLIENTS = 60;
export const RETRIES = 4;
export const BASE_S = 0.5;
export const BUCKET_S = 0.1; // the server's view: requests arriving in each 100 ms
export const SPAN_S = 8; // seconds shown on the canvas
export const RUNS = 500; // simulations averaged for the published "peak load" numbers
const SEED = 1; // the displayed run (seed 1) happens to sit exactly on the averaged peaks, so lanes and chart agree
const SEED_STEP = 7919;
const UINT32 = 2 ** 32;

/** Wait before retry k (0-based): ceiling = BASE_S * 2^k; `rand` is a function returning [0, 1). */
export const STRATEGIES = {
  fixed: { label: 'Fixed 500 ms', wait: () => BASE_S },
  exponential: { label: 'Exponential', wait: (k) => BASE_S * 2 ** k },
  equal: { label: 'Equal jitter', wait: (k, rand) => (BASE_S * 2 ** k) / 2 * (1 + rand()) },
  full: { label: 'Full jitter', wait: (k, rand) => BASE_S * 2 ** k * rand() },
};

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / UINT32;
  };
}

/** One client's retry arrival times in seconds. */
export function retryTimes(strategy, rand) {
  const { wait } = STRATEGIES[strategy];
  let t = 0;
  return Array.from({ length: RETRIES }, (_, k) => (t += wait(k, rand)));
}

/** Every client's retries: [{client, times: [...]}] . */
export function simulate(strategy, seed = SEED, clients = CLIENTS) {
  const rand = mulberry32(seed);
  return Array.from({ length: clients }, (_, client) => ({ client, times: retryTimes(strategy, rand) }));
}

/** Requests per BUCKET_S bucket over SPAN_S. */
export function histogram(run) {
  const bins = new Array(Math.ceil(SPAN_S / BUCKET_S)).fill(0);
  for (const { times } of run) for (const t of times) if (t < SPAN_S) bins[Math.floor(t / BUCKET_S)]++;
  return bins;
}

/** Busiest bucket, averaged over `runs` seeds (rounded to a whole request). */
export function meanPeak(strategy, runs = RUNS) {
  let sum = 0;
  for (let i = 0; i < runs; i++) sum += Math.max(...histogram(simulate(strategy, SEED + i * SEED_STEP)));
  return Math.round(sum / runs);
}

// ---------------------------------------------------------------- painter (browser only)
const DOT_RADIUS = 3;
const DOT_ROWS = 6;
const DOT_ROW_GAP = 5;
const PAD = { left: 16, right: 16, top: 12, bottom: 26 };
const STRIP_H = DOT_ROWS * DOT_ROW_GAP + DOT_RADIUS * 2 + 4; // the band of dots under the bars
const BAR_GAP = 1.5;
const BAR_ALPHA_LIVE = 0.9;
const BAR_ALPHA_GHOST = 0.2;
const LOOP_S = SPAN_S + 1.5; // the playhead rests a moment at the end
const COLOR_TOKENS = { fg: '--deck-fg', muted: '--deck-muted', line: '--deck-line', surface: '--deck-surface', danger: '--deck-danger', ok: '--deck-ok' };

const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Paints the lane for `strategy` into `canvas`. Returns {start, stop, destroy}; the loop only runs between start() and stop(). */
export function mountHerd(canvas, { strategy, tone = 'danger', onPeak = () => {} }) {
  const run = simulate(strategy);
  const bins = histogram(run);
  const peak = Math.max(...bins);
  const ctx = canvas.getContext('2d');
  let colors = {};
  let w = 0;
  let h = 0;
  let raf = 0;
  let began = 0;
  let running = false;

  const readColors = () => {
    const cs = getComputedStyle(document.documentElement);
    colors = Object.fromEntries(Object.entries(COLOR_TOKENS).map(([key, token]) => [key, cs.getPropertyValue(token).trim() || '#888']));
  };
  const resize = () => {
    const deck = canvas.closest('main.deck');
    const zoom = Math.max(1, Number.parseFloat(deck ? getComputedStyle(deck).getPropertyValue('--deck-scale') : '1') || 1);
    const ratio = (window.devicePixelRatio || 1) * zoom;
    w = canvas.clientWidth;
    h = canvas.clientHeight;
    canvas.width = Math.round(w * ratio);
    canvas.height = Math.round(h * ratio);
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    draw(playhead());
  };
  const playhead = () => (running && !reducedMotion() ? Math.min(SPAN_S, ((performance.now() - began) / 1000) % LOOP_S) : SPAN_S); // idle = the finished picture

  const draw = (now) => {
    const plotW = w - PAD.left - PAD.right;
    const base = h - PAD.bottom;
    const barBase = base - STRIP_H;
    const barMax = barBase - PAD.top;
    const x = (t) => PAD.left + (t / SPAN_S) * plotW;
    const accent = colors[tone];
    ctx.clearRect(0, 0, w, h);
    ctx.font = '500 12px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let s = 0; s <= SPAN_S; s++) { // time axis
      ctx.fillStyle = colors.muted;
      ctx.fillText(`${s}s`, x(s), base + 8);
      ctx.fillStyle = colors.line;
      ctx.fillRect(x(s) - 0.5, base, 1, 4);
    }
    ctx.fillStyle = colors.line;
    ctx.fillRect(PAD.left, base, plotW, 1);

    const barW = (plotW / bins.length) - BAR_GAP;
    let seen = 0;
    bins.forEach((count, i) => { // server load per 100 ms: faint = still to come, solid = already happened
      const live = (i + 1) * BUCKET_S <= now;
      if (live) seen = Math.max(seen, count);
      ctx.globalAlpha = live ? BAR_ALPHA_LIVE : BAR_ALPHA_GHOST;
      ctx.fillStyle = accent;
      const bar = (count / CLIENTS) * barMax;
      ctx.fillRect(x(i * BUCKET_S) + BAR_GAP / 2, barBase - bar, barW, bar);
    });
    ctx.globalAlpha = 1;

    run.forEach(({ client, times }) => { // one dot per retry, stacked in rows so a spike reads as a column
      for (const t of times) {
        if (t >= SPAN_S) continue;
        ctx.fillStyle = t <= now ? colors.fg : colors.muted;
        ctx.globalAlpha = t <= now ? 0.9 : 0.45;
        ctx.beginPath();
        ctx.arc(x(t), base - DOT_RADIUS - 3 - (client % DOT_ROWS) * DOT_ROW_GAP, DOT_RADIUS, 0, Math.PI * 2);
        ctx.fill();
      }
    });
    ctx.globalAlpha = 1;
    ctx.fillStyle = colors.fg;
    ctx.fillRect(x(now) - 1, PAD.top, 2, base - PAD.top);
    onPeak(now >= SPAN_S ? peak : seen);
  };

  const frame = () => {
    draw(playhead());
    raf = requestAnimationFrame(frame);
  };
  const theme = () => { readColors(); draw(playhead()); };
  const mq = matchMedia('(prefers-color-scheme: dark)');
  const mo = new MutationObserver(theme);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  mq.addEventListener('change', theme);
  const ro = new ResizeObserver(resize);
  ro.observe(canvas);
  window.addEventListener('resize', resize);
  readColors();
  resize();

  return {
    start() {
      readColors();
      began = performance.now();
      running = true;
      cancelAnimationFrame(raf);
      if (reducedMotion()) draw(SPAN_S); else raf = requestAnimationFrame(frame);
    },
    stop() { cancelAnimationFrame(raf); raf = 0; running = false; draw(SPAN_S); },
    destroy() { cancelAnimationFrame(raf); ro.disconnect(); mo.disconnect(); mq.removeEventListener('change', theme); window.removeEventListener('resize', resize); },
  };
}
