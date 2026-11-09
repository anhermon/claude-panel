# panel/ui - component kit for scenes

`import { mount, stack, card, metric, chart } from 'panel/ui'` in a scene's `<script type="module">`. Offline, no build step, vendored d3 only.
Every component is `name(opts) -> HTMLElement` with `el.update(patch)` (shallow-merges `patch` into the options and re-renders **in place**: numbers
count to the new value, bars grow, lines morph, rows and cards slide) and `el.opts()`. Feed live data with `panel.data((d) => comp.update(d))`.
Containers take `(opts?, ...children)`. Motion only explains change; `prefers-reduced-motion` turns it all off. Theme: dark by default, light under
`prefers-color-scheme` or the host's theme message, CSS variables `--ui-*` (`--ui-acc`, `--ui-ok`, `--ui-warn`, `--ui-danger`, `--ui-c1..c6` series colours).
Runnable showcase with live data: `web/sample-scenes/ui-catalog/` (render it with `node scripts/render-ui-catalog.mjs`).

```js
import panel from 'panel';
import { mount, grid, card, metric, chart } from 'panel/ui';
const m = metric({ label: 'Requests', value: 0, spark: [] });
const c = chart({ type: 'line', yLabel: 'req/s', data: [] });
mount(document.body, grid({ min: 280 }, card({ title: 'Load' }, m), card({}, c)));
panel.data((d) => { m.update({ value: d.rps, spark: d.history }); c.update({ data: d.history }); });
```

## Core
- `mount(root?, ...components)` - appends into `root` (element, selector, default `document.body`), injects the stylesheet + theme, keeps `panel.fit()` in sync.
- `h(tag, props, ...children)` - DOM helper: `h('div.card#id', {onclick, style: {gap: '8px'}}, 'text', child)`. Text is never parsed as HTML. SVG tags are namespaced automatically.
- `tween(from, to, onFrame, ms)`, `counter(node, format)`, `flash(el)`, `flip(root, mutate)`, `reducedMotion()` - the animation primitives the components use.
- `build`, `addCss`, `setChildren`, `ensureStyle` - for writing your own components in the same style.
- `pure` - the DOM-free helpers (`formatNumber`, `sortRows`, `normalizeSeries`, `timeTicks`, ...).

## Layout and text
- `stack({gap, align}, ...kids)` - vertical flow.
- `row({gap, align, justify, wrap}, ...kids)` - horizontal flow that wraps.
- `grid({cols, min, gap}, ...kids)` - responsive columns, at most `cols`, each at least `min` px.
- `card({title, sub, tone}, ...kids)` - framed group; `tone` neutral|info|ok|warn|danger paints the left rule and title.
- `text('str' | {text, size: 'xl'|'l'|'m'|'s', tone, bold, mono, align})` - styled paragraph.
- `md('# Title\n- **bold** item')` - markdown-lite (h1-h3, bold, italic, `code`, http(s) links, lists, quotes, fences), built from DOM nodes.
- `callout({tone, title, text})` - highlighted note.
- `badge('x' | {text, tone, dot, live})` / `pill` - status pill; `live` pulses the dot.

## Numbers and progress
- `metric({label, value, unit, delta, deltaUnit, deltaLabel, goodWhen: 'up'|'down', spark: [..], decimals, compact, prefix, suffix})` - big number that counts up, delta coloured by `goodWhen`, optional sparkline.
- `sparkline({values, tone})` - tiny trend line with an end dot.
- `gauge({value, min, max, label, unit, decimals, thresholds: [{upTo, tone}]})` - value on a 240-degree arc, coloured by threshold.
- `rings({items: [{label, pct, color?}]})` - up to 6 concentric completion rings, values listed beside them.
- `progress({value, max, label, text, tone})` - one bar (value 0..1, or value/max).
- `steps({items: [{t, state: 'todo'|'doing'|'done'|'failed', note}], horizontal})` - ordered plan progress.

## Data
- `table({columns: [{key, label, type: 'num'|'text'|'badge', tones, format, decimals, align}], rows, rowKey, sort: {key, dir}, sortable, empty})` - sortable (click header); keyed rows, changed cells flash, re-sorted rows slide.
- `chart({type, data | series, height, title, xLabel, yLabel, format, unit, ...})` - types `bar` (horizontal, stacked), `line` / `area` (smooth, yMin, yMax), `scatter` (r, labels), `donut` (center, centerLabel), `heatmap` (data `[{x, y, value}]`, color). Data: `[1,2]`, `[[x,y]]`, `[{x,y}]`, `[{label,value}]`; many series: `series: [{name, data, color?}]`. Axes, hover tooltips, series named on the chart (no legend). Shorthands `bar line area scatter donut heatmap`.
- `timeline({lanes, items: [{lane, start, end?, label, state}], now, axis})` - swimlanes over time; also takes the agent-gantt shape `{now, rows: [{name, sub, start, end?, state}]}`. Items without `end` run until `now`. States running|done|idle|failed|warn|milestone.
- `kanban({columns: [{id, title, tone, limit, cards: [{id, title, sub, tags, meta}]}]})` - columns of cards; a card with the same `id` that changes column slides there. Flat form: `columns: ['todo'], cards: [{id, column, title}]`.

## Input
- `form({id, fields: [{id, type: 'text'|'number'|'select'|'slider'|'toggle', label, value, options, min, max, step, unit, hint}], buttons: [{id, label, primary}], onChange(values, fieldId), onSubmit(values, buttonId)})` -
  emits `panel.emit('form', {id, values, on: 'change'|'submit', field?, button?})` on change/submit (sliders on release); `el.values()` reads them. `update({fields})` never overwrites a field being edited.
