# panel kit (v4): SDK, deck engine, house elements

House code for panel scenes. A scene is a folder with an `index.html`; the panel server serves it in
`<iframe sandbox="allow-scripts">` (opaque origin: no storage, no cookies) and injects the pieces below, so a scene needs
no boilerplate:

| Injected for you | What it is |
|---|---|
| `<link rel=stylesheet href=".../kit/panel/panel.css">` | tokens, reset, utility classes (opt out: `<meta name="panel-css" content="off">`) |
| `<script src=".../kit/panel/panel.js">` | classic SDK, defines `window.panel` |
| `<script type="importmap">` | `panel`, `panel/deck`, `panel/components`, plus the vendored libraries (`three`, `three/addons/`, `d3`, `@observablehq/plot`, `chart.js`, `chart.js/auto`, `roughjs`, `matter-js`, `katex`, `highlight.js`, `marked`) |

Files a scene folder may contain are limited by the server's extension allow-list (`html css js mjs json csv txt png jpg jpeg gif
webp avif svg ico mp3 wav ogg oga m4a aac flac mp4 webm glb gltf bin obj stl hdr ktx2 woff2`). So Markdown for `<p-md src>` goes in a
`.txt` file, and `<p-code src>` can point at any listed text file.

```html
<script type="module">
  import 'panel/deck';        // starts the first <main class="deck">
  import 'panel/components';  // registers <p-chart> <p-3d> ... (optional, only what you use is loaded)
</script>
```

Files: `panel.js` `panel.mjs` `panel.css` | `deck.js` `deck-logic.js` `deck.css` | `components.js` `components/*.js`. Pure logic has
`*.test.mjs` files next to it: `node --test web/kit/panel/*.test.mjs`. A working example is `web/sample-scenes/deck/`.

---

## 1. SDK: `window.panel` / `import panel from 'panel'`

| Member | Description |
|---|---|
| `panel.fit(height?)` | Tell the host how tall the scene is, in CSS px, clamped to 120..1200. Without an argument it measures the document. |
| `panel.emit(name, data?)` | Send a message to Claude/the host. `name` must match `/^[a-z0-9._-]{1,40}$/`; `data` must be JSON-serialisable and is clipped to 2048 bytes (an oversize value arrives as `{clipped:true, bytes, json:"<prefix>"}`). Returns `true` if sent, `false` (plus a `console.error`) on a bad name or unserialisable data. Names starting with `deck.` are host commands and are not forwarded to Claude. |
| `panel.canEmit()` | `false` once a host says it has no return channel (host message `channel {emit:false}`), else `true`. The panel's own hosts (the browser page and the terminal pane's workspace page, which forwards `panel.emit` to the server) both have one, so today it stays `true`; it is there for a host that does not. |
| `panel.on(name, fn)` | Listen to a host message `{type:'panel-host', name, data}`. Only messages from the parent window are accepted. Returns an unsubscribe function. |
| `panel.ready()` | Promise: DOM parsed and fonts loaded; reports the height once. |
| `panel.data(cb, opts?)` | Poll `live/data.json` (relative to the scene document; the `scene` tool writes it when called with `{id, data}`). `cb(value)` runs as soon as the first read succeeds, then only when the JSON text changed. `opts.every` is the poll period in ms (default 1000, clamped to 250..10000). A 404, a network error or invalid JSON silently keeps the last value. Polling pauses while the document is hidden and resumes with an immediate read. Returns `stop()`. `panel.data.last()` is the last value read (or `undefined`). |

Host messages (host to scene): `key {key, shift?, ctrl?, meta?, alt?}`, `visible {visible}`, `theme {dark}`, `channel {emit}`. `theme` also sets
`data-theme="dark|light"` on `<html>` (panel.css tokens follow it). The ES-module face (`import panel, {fit, emit, on, ready, data} from 'panel'`)
is the same object; calling either twice is safe.

Live data: a top-level `live/` folder of the scene is served like any file but never reloads the frame, so `scene {id, data}` can rewrite
`live/data.json` while the page keeps running: `panel.data(d => { gauge.textContent = d.cpu + '%'; });`.

Wire format: scene to host `{type:'panel-emit', name, data}`, `{type:'panel-fit', height}`, `{type:'panel-deck', h, v, f, count, title, notes}`.

## 2. `panel.css`

Tokens (dark by default; light under `prefers-color-scheme: light` or `data-theme="light"`; `data-theme="dark"` forces dark):

`--panel-bg --panel-surface --panel-fg --panel-muted --panel-line --panel-accent --panel-accent-2 --panel-ok --panel-warn --panel-danger --panel-cyan --panel-on-accent --panel-code-bg --panel-radius --panel-font --panel-mono` and syntax colours `--panel-hl-keyword|string|number|comment|title|type`.

`body` is transparent over `--panel-bg`. The reset and element styles are `:where()`-scoped (zero specificity), so your CSS always wins.

| Class | Effect | Tunable by |
|---|---|---|
| `.p-stack` | vertical flex column | `--p-gap` (16px) |
| `.p-row` | wrapping flex row, centred | `--p-gap` (12px) |
| `.p-grid` | auto-fit grid | `--p-min` (220px), `--p-gap` (16px) |
| `.p-card` | surface box with border and radius | |
| `.p-pill` | small rounded label | |
| `.p-btn` (`.ghost`) | button (filled / outlined) | |
| `.p-skel` / `.p-error` | skeleton shimmer / inline error box used by the house elements | |

## 3. Deck engine: `import 'panel/deck'`

A strict subset of reveal.js markup. A slide is a fixed 1280x720 canvas scaled to fit the frame (`--deck-scale`), so type sizes
mean the same thing at 800x450 and at full screen.

```html
<main class="deck" data-transition="slide">
  <section class="title" data-background-gradient="linear-gradient(...)"> <h1>...</h1> <aside class="notes">Speaker notes</aside> </section>
  <section><section>vertical A</section><section>vertical B</section></section>   <!-- nested = vertical stack -->
</main>
```

Programmatic start: `import { start } from 'panel/deck'; const deck = await start(document.querySelector('main.deck'));` (`start` returns a
Promise of the deck, once its stylesheet is in; it is idempotent per element, and importing `panel/deck` already starts the first `main.deck`).

### Slide attributes (on `<section>`)

| Attribute | Values | Meaning |
|---|---|---|
| `data-title` | text | Title reported to the host and used for the accessible name. Default: first `h1/h2/h3`, else "Slide N". |
| `data-transition` | `slide` `fade` `zoom` `none` | Transition used when entering this slide (also accepted on `main.deck` as the default). reveal's `fade-in slide-out` form is read as its first word. |
| `data-background-color` | CSS colour | Full-viewport background behind the slide, cross-faded. |
| `data-background-gradient` | CSS `*-gradient(...)` or any `background-image` value | Same, as an image/gradient. `var(--deck-*)` tokens work. |
| `data-background-image` | file name | Same, as an image from the scene folder. |
| `data-background-size` `data-background-position` | CSS values | For the image (default `cover` / `center`). |
| `data-background-opacity` | 0..1 | Opacity of the background layer. |
| `data-auto-animate` | boolean | With the previous or next slide also marked, elements sharing a `data-id` tween (FLIP) from their old box, colour and background to the new one. Only between consecutive slides. |
| `data-id` | text (on elements) | Pairs elements for auto-animate. |
| `data-audio` | file name | Narration: plays when the slide is shown, after the first user gesture (key, click or host key). `m` mutes. |
| `class="fragment"` | `fade-in` (default) `fade-up` `grow` `fade-out` `highlight-accent` | Step-by-step reveal. `data-fragment-index="n"` sets the step (fragments with the same index appear together; one without an index takes the previous fragment's index plus one, in document order). |
| `<aside class="notes">` | text | Speaker notes, never shown on the slide; sent to the host in every `panel-deck` message. |

Layouts (classes on the slide): `.title` (centred cover), `.two-col` (two equal columns; `h1/h2/h3` and `.span-all` span both),
`.big-number` (put the figure in `.num` and the caption in `.label`), `.image-full` (a direct child `img`/`video`/`.media` covers the
slide, text sits at the bottom). Helpers: `.lead`, `.muted`, `.eyebrow`, `.grad` (gradient text).

### Theme tokens (`deck.css`, set on `:root` or on `main.deck`)

`--deck-bg --deck-fg --deck-muted --deck-line --deck-surface --deck-accent --deck-accent-2 --deck-ok --deck-danger --deck-font --deck-mono`
default to the matching `--panel-*` token. Also `--deck-glow-1/2` (gradient glow colours), `--deck-pad-x/y` (96px/72px), `--deck-h1/h2/h3/body`
(84/52/34/28px), `--deck-shift` (48px, slide travel), `--deck-ms` (450ms, transition time), `--deck-ease`.

### Navigation

| Input | Action |
|---|---|
| `ArrowRight` / `ArrowLeft` | next / previous step (fragments first, then slide), horizontally |
| `ArrowDown` / `ArrowUp` / `PageDown` / `PageUp` / `Space` (`Shift+Space` back) | next / previous step in reading order (enters vertical stacks) |
| `Home` / `End` | first / last slide |
| `o` | overview grid: arrows move the selection, `Enter`, `Esc` or a click on a slide leaves the grid |
| `f` | `panel.emit('deck.fullscreen')`: the host toggles fullscreen |
| `i` or `s` | `panel.emit('deck.drawer')`: the host toggles its notes/summary drawer |
| `m` | mute / unmute narration |
| click | left 30 % of the slide goes back, the rest forward |
| swipe | horizontal or vertical swipe of at least 50 px |

Keys with `Ctrl`, `Meta` or `Alt` are never handled; `Tab` is never trapped. Clicks, keys and drags on controls and widgets
(`a button input select textarea label summary canvas video audio iframe [contenteditable] [data-no-nav] p-3d p-compare p-audio p-chart`)
do not turn pages. The same actions run for host `key` messages, so keys pressed outside the frame work too.

The position lives in the URL hash `#/<h>[/<v>[/<f>]]` (slide, vertical index, fragment step), kept in sync both ways; a reload of
the frame with the same hash returns to the same step.

### Events and messages

| Direction | Message |
|---|---|
| deck to host | `{type:'panel-deck', h, v, f, count, title, notes}` after every change (`count` = number of horizontal positions; title clipped to 120 and notes to 2000 chars) |
| deck to host | `panel.emit('deck.fullscreen')` and `panel.emit('deck.drawer')`: host commands, never forwarded to Claude |
| host to deck | `{type:'panel-host', name:'key', data:{key,...}}` (validated: string key of 1..24 chars) |
| inside the scene | `panel-slide` CustomEvent, `detail:{present:boolean}`, dispatched on a slide's `<section>` when it becomes or stops being current. Use it to start and stop animations. `section.dataset.state` is `present` `past` `future` `above` `below`. |

### Behaviour notes

Hidden slides are `inert` (not focusable, hidden from assistive tech); each slide is `role="region" aria-roledescription="slide"`
with an `aria-label` "Slide N of M: title", and navigation is announced through a polite live region. Under
`prefers-reduced-motion: reduce` every transition, fragment animation and auto-animate is skipped. `main.deck` stays hidden until
the engine is ready (3 s safety net). Colours follow the light/dark tokens, so a deck works in both.

## 4. House elements: `import 'panel/components'`

Each element lazy-loads its library on first use, shows a skeleton while loading, and turns any failure (bad attribute, missing file, parse
error) into an inline `.p-error` box plus a `console.error`; it never throws into your page. Files named by `src`/`before`/... are
resolved relative to the scene document. Elements that animate pause when their slide is not current, the frame is hidden, or the tab is
in the background, and re-theme when the colour scheme changes.

### `<p-chart>` (Chart.js)

| Attribute | Values | Default | Meaning |
|---|---|---|---|
| `type` | `bar` `line` `area` `scatter` `pie` | `bar` | chart kind |
| `data` | JSON | | inline data (see below) |
| `src` | file name | | a `.json` file with the same shapes (wins over `data`) |
| `x` | key | first string key (scatter: first numeric key) | row key for the category axis (scatter: x values) |
| `y` | key or comma list | every other numeric key | row key(s) for the series |
| `title` | text | none | chart title |

Data may be an array of numbers (`[3,8,5]`), an array of row objects (`[{"month":"Jan","a":3,"b":4}]`, one series per numeric key) or native
Chart.js `{labels, datasets}`. Height: `--p-chart-h` (340px). Colours come from the accent tokens; the entrance animation replays each time
its slide is shown.

### `<p-3d>` (three.js)

| Attribute | Values | Default | Meaning |
|---|---|---|---|
| `shape` | `torusknot` `cube` `sphere` `torus` | `torusknot` | built-in shape |
| `src` | `.glb` / `.gltf` file | | model from the scene folder (scaled to fit); wins over `shape` |
| `auto-rotate` | boolean | off | slow spin (disabled by reduced motion) |
| `controls` | boolean | off | drag to orbit |
| `zoom` | boolean | off | with `controls`: wheel/pinch zoom |
| `background` | CSS colour | transparent | frame background |
| `color` | CSS colour | `--panel-accent` | shape colour |

Height `--p-3d-h` (360px). Renders only while visible and current.

### `<p-audio>`

| Attribute | Values | Default | Meaning |
|---|---|---|---|
| `src` | audio file | required | file in the scene folder |
| `title` | text | none | label |
| `wave` | boolean | off | draw the file's waveform with a seekable playhead (click, or left/right arrow keys for 5 s steps) instead of live level bars |

Never autoplays: it reads "Press play". States: Press play, Playing, Paused, Finished (press play to replay), This file cannot be played. It
pauses when its slide is left or the frame is hidden.

### `<p-code>`

| Attribute | Values | Default | Meaning |
|---|---|---|---|
| `lang` | highlight.js language name | auto-detect | language and the corner label |
| `src` | text file | | load the code from a file instead of the tag body |

Write the code inside the tag (common indentation is removed; escape `<` as `&lt;`). Text is shown immediately and highlighted when the library arrives.

### `<p-md>`

| Attribute | Values | Meaning |
|---|---|---|
| `src` | `.txt` file | load Markdown from a file instead of the tag body |

GitHub-flavoured Markdown (marked) with fenced code highlighted. Output goes through an allow-list sanitiser: scripts, styles, iframes,
svg, forms, `on*` attributes, inline `style` and `javascript:`/`vbscript:`/`data:` (except base64 PNG/GIF/JPEG/WebP images) URLs are removed;
links open as new-window requests with `rel="noopener noreferrer"`.

### `<p-math>` (KaTeX)

| Attribute | Values | Meaning |
|---|---|---|
| `tex` | TeX | the formula; when absent, the tag body is used. Use `tex="a &lt; b"` for TeX with `<` or `&` |
| `display` | boolean | centred block instead of inline |

### `<p-compare>`

| Attribute | Values | Default | Meaning |
|---|---|---|---|
| `before` `after` | image files | required | the two images (same size works best) |
| `before-label` `after-label` | text | Before / After | corner tags |
| `value` | 0..100 | 50 | initial divider position |

A real `<input type=range>` underneath: drag, click, or use the arrow keys (arrows do not turn deck pages while it is focused). The box
takes the image's aspect ratio, and is clipped to the element's own height if you give it one.

### `<p-timeline>`

Children `<li data-when="label" data-tone="ok|warn|danger">text</li>`. `data-when` is the small label above the text (optional);
`data-tone` colours the marker (default accent). The line and items draw in (staggered) each time the slide is shown.

### `<p-diagram>`

| Attribute | Values | Default | Meaning |
|---|---|---|---|
| `direction` | `lr` `tb` | `lr` | flow left-to-right or top-to-bottom |
| `rough` | boolean | off | hand-drawn look (rough.js) |

Children: `<li data-node="id">Label</li>` names a node (nodes also appear from edges, labelled with their id); `<li data-from="a" data-to="b">edge label</li>`
adds an edge (the text is optional). Layout is automatic (layered, cycles allowed: back edges loop underneath). Edges draw in with a travelling dot.

## 5. Safety summary

No storage APIs; no network except files of the scene and the kit; no `eval`; `postMessage` to the parent only; incoming host messages are
accepted from `window.parent` and validated; `emit` validates names and bounds payload size; `<p-md>` is sanitised by construction (tokenise,
allow-list, re-escape).
