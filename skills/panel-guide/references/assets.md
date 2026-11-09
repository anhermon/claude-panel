# Visual assets: pick by the shape of the information

`panel/assets` is a library of generators for ad-hoc visuals about the work in this session. Choose the asset by what the information IS (a flow, a
part-of-whole, a network, a before/after), never by how it looks. Two ways to use one, same data either way:

- **One tool call, board frame:** `panel {frame: {id, type: "viz", kind, data, caption?}}`. `data` is the asset's own schema (at most 12 KB); a wrong field is
  refused with its path, or drawn as an error panel in the frame; an unknown `kind` lists the valid kinds.
- **In a scene:** `import { sankey, treemap, render, kinds, describe } from 'panel/assets'`; every maker is `name(data, opts) -> <figure>` with `.update(data)`.
  `opts`: `title`, `caption`, `height` (px), `fs` (font px). `render(kind, data, opts)` takes the kind by name; `describe(kind)` returns shape, fields and a sample.

<!-- panel-input -->
```json
{ "frame": { "id": "where-tokens-went", "type": "viz", "kind": "sankey", "caption": "k tokens by what they were spent on",
  "data": { "unit": "k tok", "links": [ { "from": "Session", "to": "Reading", "value": 46 }, { "from": "Session", "to": "Editing", "value": 22 }, { "from": "Reading", "to": "Useful", "value": 40 }, { "from": "Reading", "to": "Re-read", "value": 6 } ] } } }
```

Every asset: themed (dark and light), readable from 360 to 1280 px, labels carry their unit, motion only where it means something (flow direction, a slider
you drag), `prefers-reduced-motion` honoured, hover titles on marks. Data is validated; the error names the field (`data.links[2].value must be a number`).
Keep numbers measured: build the data from a file or tool output, not from memory.

## Information shape to asset
| The information is... | Asset | Data fields (see `describe(kind).sample`) |
|---|---|---|
| quantity splitting and merging (where tokens, time, money went) | `sankey` | `unit, nodes?, links[{from,to,value}]` |
| things moving along paths, rate and direction matter | `flow` | `unit, nodes[{id,label}], edges[{from,to,rate,label?}]` |
| part-of-whole, size matters | `treemap` | `unit, root{name, value?, children[]}` |
| part-of-whole, depth matters, radial | `sunburst` | same as treemap |
| part-of-whole, long names or a narrow tile | `icicle` | same as treemap |
| files changed, with how much churn | `filetree` | `unit, files[{path, added?, removed?, status?, note?}]` |
| what two or three groups share | `venn` | `sets[{id,label,size}], overlaps[{sets,size,items?}]` |
| who depends on / calls / blocks whom | `network` | `nodes[{id,label,group?,size?}], edges[{from,to,label?,directed?}]` |
| ideas around a centre, a concept map | `mindmap` | `center, branches[{label, children?}], links?` |
| a decision and what follows each branch | `decision` | `root{id?, label, edge?, kind?, children[], tone?}, chosen?` |
| a rough idea that is not settled | `sketch` | `nodes[{id,label,shape?,unsure?}], edges[{from,to,label?,unsure?}], note?` |
| layers of a system, what sits on what | `layers` | `layers[{name, items[{label,tone?}], note?}], flow?` |
| one thing scored on several axes | `radar` | `unit?, axes[{key,label,max?}], series[{name,values}]` |
| before and after for each of many items | `dumbbell` | `unit, goodWhen?, fromLabel?, toLabel?, items[{label,from,to}]` |
| many comparable series side by side | `multiples` | `unit, kind?, shared?, panels[{label,values[],tone?}]` |
| who touched what / what co-occurs | `matrix` | `unit, rowTitle?, colTitle?, totals?, rows[], cols[], values[][]` |
| an estimate with a range, against a target | `ranges` | `unit, target?, confidence?, items[{label,low,mid?,high,actual?}]` |
| a forecast that widens with time | `fan` | `unit, xLabels?, history[], forecast{mid[], bands[{label,low[],high[]}]}` |
| one number against thresholds | `dial` | `label, unit, min, max, value, target?, bands[{to,tone,label?}]` |
| several levels against thresholds | `thermo` | `unit, min, max, items[{label,value,bands?,target?}]` |
| time and state over the session (what kind of work, when) | `river` | `x[], layers[{name, values[]}]` |
| events with notes along time | `events` | `unit, items[{at,end?,label,note?,tone?}]` |
| where something got lost (stages) | `funnel` | `unit, stages[{label,value,note?}]` |
| what added and removed from a total | `waterfall` | `unit, start{label,value}, steps[{label,delta}], end?` |
| a screenshot or picture with callouts | `annotate` | `src, alt, ratio?, notes[{x,y,text,tone?,shape?}]` (x,y,w,h are 0..1 of the picture; `src` is a scene file or a data: URI) |
| a change you can slide between | `beforeafter` | `unit, goodWhen?, before{label,src?}, after{label,src?}, items[{label,before,after}]?, start?` |
| status of many items | `statusboard` | `columns[{id,title,tone?,limit?,items[{title,sub?,tags?,open?}]}]` (`open` is a session id: the card becomes a button that opens that session's transcript in the Agents tile; the board's own sessions frame sets it) |
| things placed in space | `scene3d` | `objects[{id,shape,pos,size?,label?,tone?}], links?, ground?, autoRotate?` |

## When NOT to use a chart
- One number: say it (`metric`, or a sentence). A chart of one value is decoration.
- Two or three values the user reads in one glance: a sentence, or `bars` with 2-3 rows.
- The point is a sequence of steps or a plan: `steps`; a mechanism: `uml`/`diagram`. Do not draw a flow as a sankey unless widths are real amounts.
- You have no real numbers: a sketch (`sketch`, `mindmap`) says "this is an idea", a precise chart lies. Never invent data to fill a chart; label illustrations as such.
- The user must compare exact values: a `table` or `card` `table` beats any picture.
- Nothing changed since the last frame: do not repost it; remove frames that are no longer true.
- Many nearly-equal slices, more than ~12 items, or labels the user cannot read at 360 px: aggregate first ("other") or use `treemap` / `matrix`.
- Motion: only when it explains (`flow` direction, `beforeafter` slider). Never animate to look alive.

## Three worked compositions (one scene, several assets plus plain HTML/SVG)
All three use a stage scene (`layout: "stage"`) with `panel/ui` layout; the assets are ordinary elements you place anywhere.

**1. "Where did the tokens go?"** a sankey (the split), a waterfall (what the re-reads added) and one sentence that states the finding.
```js
import { mount, grid, card, text } from 'panel/ui';
import { sankey, waterfall } from 'panel/assets';
mount(document.body,
  text({ text: '40% of reading tokens were re-reads of the same 6 files', size: 'l', bold: true }),
  grid({ min: 420 }, card({ title: 'Where tokens went' }, sankey(split, { caption: 'k tokens' })),
                     card({ title: 'What the re-reads added' }, waterfall(adds))));
```
**2. "A design idea that is not settled."** a `sketch` of the architecture with `unsure` parts, `ranges` for the effort estimate of each, and a `decision` tree for what to do first.
Place the sketch left, ranges right; the `caption` of each says what is known and what is a guess. Hand-drawn look = "not final" without a disclaimer.

**3. "Why did the build slow down?"** `river` (what kind of work over time) above a `matrix` (file x agent touches), and your own SVG: a vertical rule at the moment of the slowdown.
```js
const r = river(over, { height: 220 });
const rule = document.createElementNS('http://www.w3.org/2000/svg', 'svg');   // own SVG on top: one line, one label
mount(document.body, card({ title: 'Work by kind over the session' }, r, rule), card({ title: 'Who touched what' }, matrix(touches)));
```
Compose freely: a card with an asset, a `<p-code>` and a hand-written SVG arrow is a valid scene. The library gives the hard parts (layout, scales, labels that do not collide), not a house style.

## Choosing between neighbours
- `treemap` vs `sunburst` vs `icicle`: area compares sizes best; rings show depth; icicle survives narrow widths and long names.
- `sankey` vs `flow`: sankey = amounts that add up; flow = rates and direction on a live path.
- `network` vs `decision` vs `mindmap`: any relationships, one chosen route through branches, or a hierarchy of ideas.
- `dumbbell` vs `beforeafter`: many items, one pair each, vs one thing the user wants to drag between.
- `ranges` vs `fan`: uncertainty across items vs uncertainty growing over time.
- `dial` vs `thermo`: one headline value vs several levels sharing a scale.
