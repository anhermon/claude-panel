// <p-chart type="bar|line|area|scatter|pie" data='[{"month":"Jan","a":3}]' | src="data.json" x="month" y="a,b" title="..."> - Chart.js chart, theme-aware.
import { PanelElement, cssVar, reducedMotion, fetchSceneFile, el } from './base.js';
import { normalizeChartData, alpha, parseJson } from './pure.js';

const TYPES = ['bar', 'line', 'area', 'scatter', 'pie'];
const FONT_SCALE = 0.8; // legend/title text relative to the element's own font size (so a chart on a 28px slide stays readable)
const Y_GRACE = '6%'; // headroom above the top value so points are not cut off
const TICK_SCALE = 0.75; // axis tick text relative to FONT_SCALE's size
const ANIMATION_MS = 900;
const SERIES_TOKENS = ['--panel-accent', '--panel-accent-2', '--panel-ok', '--panel-warn', '--panel-danger', '--panel-cyan'];
const SERIES_FALLBACK = ['#7aa2ff', '#c084fc', '#4ade80', '#fbbf24', '#f87171', '#22d3ee'];

export class PChart extends PanelElement {
  static observedAttributes = ['type', 'data', 'src', 'x', 'y', 'title'];

  async setup() {
    const type = (this.getAttribute('type') || 'bar').toLowerCase();
    if (!TYPES.includes(type)) throw new Error(`type "${type}" is not one of ${TYPES.join(', ')}`);
    const raw = await this.until(this.#loadData());
    const { labels, datasets } = normalizeChartData(raw, { type, x: this.getAttribute('x') ?? '', y: this.getAttribute('y') ?? '' });
    const mod = await this.until(import('chart.js/auto'));
    const Chart = mod.Chart ?? mod.default;

    const palette = SERIES_TOKENS.map((t, i) => cssVar(t, SERIES_FALLBACK[i]));
    const fg = cssVar('--panel-fg', '#ecebe8');
    const muted = cssVar('--panel-muted', '#a19d95');
    const line = cssVar('--panel-line', '#2f2d2a');
    const title = this.getAttribute('title') || '';
    const pie = type === 'pie';
    const styled = datasets.map((ds, i) => {
      const color = palette[i % palette.length];
      if (pie) return { backgroundColor: ds.data.map((_, k) => palette[k % palette.length]), borderColor: cssVar('--panel-bg', '#141413'), borderWidth: 3, ...ds };
      if (type === 'bar') return { backgroundColor: alpha(color, 0.9), borderRadius: 6, borderSkipped: false, maxBarThickness: 90, ...ds };
      return {
        borderColor: color, backgroundColor: type === 'area' ? alpha(color, 0.18) : color, fill: type === 'area',
        borderWidth: 3, tension: 0.35, pointRadius: type === 'scatter' ? 5 : 3, pointHoverRadius: 6, clip: false, ...ds,
      };
    });
    const size = Number.parseFloat(getComputedStyle(this).fontSize) * FONT_SCALE;
    const axis = { grid: { color: line }, border: { color: line }, ticks: { color: muted, font: { size: size * TICK_SCALE } } };
    const canvas = el('canvas', { role: 'img' });
    canvas.setAttribute('aria-label', `${title || `${type} chart`}: ${datasets.map((d) => d.label).filter(Boolean).join(', ')}`);
    this.append(el('div', { className: 'p-chart-box' }, canvas));
    const chart = new Chart(canvas, {
      type: type === 'area' ? 'line' : type,
      data: { labels, datasets: styled },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        font: { family: cssVar('--panel-font'), size },
        color: fg,
        animation: reducedMotion() ? false : { duration: ANIMATION_MS, easing: 'easeOutQuart' },
        plugins: {
          legend: { display: datasets.length > 1 || pie, labels: { color: fg, font: { size }, boxWidth: size, boxHeight: size, borderRadius: 4, useBorderRadius: true } },
          title: { display: !!title, text: title, color: fg, font: { size: size * 1.25, weight: '600' }, padding: { bottom: size } },
        },
        scales: pie ? {} : { x: { ...axis, grid: { ...axis.grid, display: type === 'scatter' }, grace: type === 'scatter' ? Y_GRACE : 0 }, y: { ...axis, beginAtZero: type === 'bar', grace: Y_GRACE } },
      },
    });
    this.own(() => chart.destroy());
    this.watchTheme(() => this.restart());
    let first = true;
    this.watchActive((active) => { // replay the entrance animation each time a slide with this chart is shown
      if (!active) return;
      if (first) { first = false; return; }
      chart.reset();
      chart.update();
    });
  }

  async #loadData() {
    const src = this.getAttribute('src');
    if (src) return fetchSceneFile(src, 'json');
    const inline = this.getAttribute('data');
    if (inline === null) throw new Error('give it data="[...]" or src="data.json"');
    const { value, error } = parseJson(inline);
    if (error) throw new Error(`data is not valid JSON (${error})`);
    return value;
  }
}
