// The field guide the `panel` tool keeps out of its always-loaded text: `{help: "<topic>"}` returns one topic as the tool
// result and changes nothing. The advertised schema is slim; every field documented here is still accepted by validation.
import { BOARD_CAPS } from './board-model'
import { FRAME_CAPS, FRAME_TYPES, VIZ_KINDS, VIZ_SIGNATURES } from './board-frames'
import { VIZ_KIND_TABLE } from './viz-kinds'
import { LANE_CAPS } from './pulse-lanes'
import { CARD_CAPS } from './state'

export const HELP_KEY = 'help'
const ASSETS_GUIDE = 'panel:panel-guide references/assets.md'
const AUTOMATIC = 'automatic frame: the board draws it by itself; send a frame of the same id to override it, frame_remove to hide it.'

// One line per frame type: the fields after `id`, `type`, `title?`, `size?`.
const FRAME_DOCS: Readonly<Record<string, string>> = {
  text: 'text{text,sub?}',
  now: 'now{text?,status?}',
  metric: 'metric{value,label?,delta?,tone info|ok|warn|danger?,spark?[]}',
  rings: `rings{items[{label,pct,color?}]<=${FRAME_CAPS.RINGS_ITEMS}}`,
  bars: `bars{items[{label,value,color?}]<=${FRAME_CAPS.BARS_ITEMS},unit?}`,
  line: `line{series[{label,points[]}]<=${FRAME_CAPS.LINE_SERIES}}`,
  steps: `steps{items[{t,state todo|doing|done|failed}]<=${FRAME_CAPS.STEPS_ITEMS}}`,
  diagram: `diagram{nodes[{id,label,tone?}]<=${FRAME_CAPS.DIAGRAM_NODES},edges[{from,to,label?}]<=${FRAME_CAPS.DIAGRAM_EDGES}}`,
  timeline: `timeline{items[{when?,text,tone?}]<=${FRAME_CAPS.TIMELINE_ITEMS}}`,
  compare: 'compare{left:{title,items[]},right:{title,items[]}}',
  avatar: 'avatar{mood idle|thinking|working|happy|alert|sleepy,say?}',
  ask: `ask{q,options[]<=${FRAME_CAPS.ASK_OPTIONS}}`,
  image: 'image{src,caption?}',
  html: `html{html<=${FRAME_CAPS.HTML_CHARS / 1024}KB}`,
  uml: `uml{code<=${FRAME_CAPS.UML_CODE_CHARS} chars of Mermaid (sequence, flowchart, state, class, ER, mindmap, timeline, gantt),highlight?{nodeId: active|done|blocked|todo}}`,
  swimlane: `swimlane{items[{label,state working|waiting|done,from,to,segs[{k ui|logic|tests|visual|docs|research|reading|delegating|working|thinking|waiting|done,a,b}]}]<=${FRAME_CAPS.SWIMLANE_ITEMS}}`,
  viz: `viz{kind,data,caption?}: data <= ${FRAME_CAPS.VIZ_DATA_CHARS / 1024}KB, field errors name paths; topic "viz" lists every kind, "<kind>" one signature`,
  lanes: `lanes{}: ${AUTOMATIC}`,
  doing: `doing{}: ${AUTOMATIC}`,
  pulse: `pulse{}: opt-in ambient frame; ${AUTOMATIC}`,
  kindstack: `kindstack{}: ${AUTOMATIC}`,
  sinks: `sinks{}: ${AUTOMATIC}`,
  repeats: `repeats{}: ${AUTOMATIC}`,
  hints: `hints{}: ${AUTOMATIC}`,
  tickets: `tickets{summary,items}: drawn from a router-kit .router/ folder in the session folder; shapes in the panel:panel-guide skill`,
  checks: `checks{}: drawn from a router-kit .router/ folder in the session folder; a claim without a verifier PASS shows as unverified`,
}

// One line for the block kinds of a card; the panel skill has the details and examples.
export const BLOCK_KINDS_HELP =
  'kind + fields: text{text} list{items[]} table{head[],rows[][]} code{text,lang?} callout{tone info|warn|ok,text} ' +
  'steps{items[{text,state todo|doing|done|failed|skipped,note?}]} kv{rows[[key,value]]} ' +
  'metrics{items[{label,value,delta?,tone?}]} progress{value 0..1,label?,note?} diff{text,file?} ' +
  'tree{items[{path,mark added|changed|removed|focus,note?}]} options{items[{title,summary?,pros[]?,cons[]?,pick?}]} ' +
  'timeline{items[{when?,text,tone?}]} sources{items[{title,url?,note?}]} bars{items[{label,value}],unit?} ' +
  'tags{items[]} quote{text,by?}. Long text is trimmed.'

const CARDS_HELP =
  `cards: [card] replaces ALL cards ([] clears), card: ONE card by id, card_remove: id|[ids]. Up to ${CARD_CAPS.CARDS} cards of ${CARD_CAPS.BLOCKS} blocks. ` +
  'card{id [a-z0-9-],title?,span 1|2|3,pin?,tone?,blocks[{kind,...}]}; at most one pinned. ' +
  BLOCK_KINDS_HELP

const LANE_HELP =
  `lane{id,label?,state?,pct ${LANE_CAPS.PCT_MIN}..${LANE_CAPS.PCT_MAX},step?,note?,goal?,at?,dod[{t,state todo|doing|done|failed}]<=${LANE_CAPS.DOD_ITEMS},session?}: ` +
  `UPSERT one agent lane by id, at most ${LANE_CAPS.LANES}. goal titles the checklist frame; dod (your acceptance criteria) is shown as a checklist, [] clears it; ` +
  'at = index into dod of the item in progress; session = ANOTHER Claude Code session\'s id (its row opens that transcript). lane_remove: id drops a lane.'

const MORE_HELP =
  'Other fields: labels{context?,done?,next?} renames the headings (merges, "" resets one), done_add[] appends to done, ' +
  'clear: true resets the header, lists and cards first (scenes stay), canvas = deprecated alias of cards. Each given list REPLACES its section. ' +
  `Frames: at most ${BOARD_CAPS.FRAMES}; the board shows the task, a pending ask, agent lanes/checklists and tool-count bars automatically, ` +
  'plus now-doing, activity-timeline, delegation and pipeline; hide an automatic frame with frame_remove (now, ask, lanes, bars).'

const VIZ_HELP =
  `viz{kind,data,caption?} visual assets by information shape: ${VIZ_SIGNATURES}. Choose by shape: ` +
  'a split or flow of amounts (where tokens/time/money went) -> sankey|treemap|waterfall, an unsettled idea or an estimate -> sketch|ranges|fan, ' +
  'who depends on whom -> network|layers|decision, change over time -> river|events, comparing candidates -> radar|dumbbell|matrix. ' +
  `Field schemas: ${ASSETS_GUIDE}.`

/** Every topic `help` knows, in the order the fallback lists them. */
export const HELP_TOPICS: readonly string[] = [...FRAME_TYPES, 'viz', 'cards', 'lane', 'more']

/** The text for one `help` topic: a frame type, `viz`, a viz kind, `cards`, `lane` or `more`; anything else gets the topic list. */
export function helpText(topic: unknown): string {
  const key = typeof topic === 'string' ? topic.trim().toLowerCase() : ''
  if (key === 'viz') return VIZ_HELP
  if (key === 'cards' || key === 'card') return CARDS_HELP
  if (key === 'lane') return LANE_HELP
  if (key === 'more') return MORE_HELP
  const doc = Object.hasOwn(FRAME_DOCS, key) ? FRAME_DOCS[key] : undefined
  if (doc !== undefined) return `frame type ${key}: {id,type:"${key}",title?,size? s|m|l|xl,...} ${doc}`
  if (VIZ_KINDS.includes(key)) {
    const entry = VIZ_KIND_TABLE[key]
    return `viz kind ${key}(${entry?.keys.join(',') ?? ''}): ${entry?.shape ?? ''}. Frame: {id,type:"viz",kind:"${key}",data:{...},caption?}. Field schemas: ${ASSETS_GUIDE}.`
  }
  return `help topics: ${HELP_TOPICS.join(' ')}, or a viz kind (${VIZ_KINDS.join(' ')}).`
}
