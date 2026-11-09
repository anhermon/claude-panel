// The Pane: draws the state as pre-wrapped lines (see layout.ts; on a terminal that can draw images and has a scene,
// layout-visual.ts: the hero picture is the whole pane, with the ask box and the control rows around it). A tree taller
// than the pane body is scrolled by the engine (wheel; arrows and page keys
// while the pane is focused); scroll.ts pins the `rev N · url` footer, with a
// dim position hint, to the bottom row of the window. A scene's PNG face is an
// Image element (terminal surface only) that stands for its `rows` lines.
import type { EngineInterface, RenderElement, RenderInput } from 'claude-code'

import type { PanelState } from '../types'
import type { AgentControls } from './agent-controls'
import { loadFaces, loadOutlines } from './faces'
import { heroOf } from './hero'
import type { Faces, Line, LiveFace, Seg } from './layout'
import { paneContent } from './layout-visual'
import { AGENT_KEY_PREFIX } from './agent-controls'
import { ANSWER_KEY_PREFIX, HERO_KEY_PREFIX, LIVE_KEY, LIVE_KEY_PREFIX, LIVE_STEPS, SCROLL_ACTIONS, SCROLL_KEY_PREFIX, SCROLL_KEYS_HINT } from './layout-types'
import type { LiveStep, ScrollAction } from './layout-types'
import { imageRows, windowTree } from './scroll'

// Used only where the surface has not measured yet.
const FALLBACK_COLUMNS = 40
const FALLBACK_ROWS = 24
const VIEWPORT_CHROME_ROWS = 4
const TERMINAL = 'terminal'

const isPlaceholder = (line: Line | undefined): boolean =>
  line !== undefined && line.length === 1 && line[0]?.text === '' && line[0].image === undefined

// Props are built without undefined values: the tree is validated strictly.
function segProps(seg: Seg): Record<string, unknown> {
  const props: Record<string, unknown> = {}
  if (seg.color !== undefined) props.color = seg.color
  if (seg.isDim === true) props.dimColor = true
  if (seg.isBold === true) props.weight = 'bold'
  if (seg.isItalic === true) props.italic = true
  return props
}

/** What the caller (register.tsx) adds to the state: the note under the answer buttons and what a pressed button does. */
export type PaneInputs = {
  note?: string
  /** Called with the pressed choice's id (`answer:<id>` without the prefix). */
  onAnswer?: (id: string) => void
  /** The live frame of the stage scene (hooks/live.ts), drawn as a keyed Image the engine can swap with `ui.blit`; absent: the static face. */
  live?: LiveFace | null
  /** Called with `prev` / `next` when a slide button of the live view is pressed. */
  onLive?: (step: LiveStep) => void
  /** Called with the action of a pressed scroll button or hotkey (`scroll:<action>`): the hero tile of the live picture scrolls. */
  onScroll?: (action: ScrollAction) => void
  /** The Agents tile's buttons (hooks/agents-info-host.ts); absent: none are drawn. */
  agents?: AgentControls | null
  /** Called with the key (`agent:...`) of a pressed agent button. */
  onAgent?: (key: string) => void
  /** The scene the person picked as the hero picture (visual mode); none, or one that is gone: the default hero. */
  heroId?: string | null
  /** Called with the scene id of a pressed hero button (`hero:<id>` without the prefix). */
  onHero?: (id: string) => void
  /** Called, when the live picture is drawn, with its cell box: the live page's viewport follows that shape (hooks/live.ts). */
  onLiveBox?: (box: { columns: number; rows: number }) => void
}

const isLiveStep = (s: string): s is LiveStep => (LIVE_STEPS as readonly string[]).includes(s)
const isScrollAction = (s: string): s is ScrollAction => (SCROLL_ACTIONS as readonly string[]).includes(s)

// The state is read by the caller (register.tsx owns the atoms: the engine's
// scan only follows an atom declared in the module that reads it).
export async function paneTree($: EngineInterface, e: RenderInput<'Pane'>, state: PanelState, inputs: PaneInputs = {}) {
  const { Box, Text, Button, Link } = $.ui.resolve(e)
  // Only the terminal surface has Image; elsewhere a scene keeps its text face.
  const Picture = e.surface === TERMINAL ? $.ui.resolve(e).Image : undefined
  // With a picture to lead with (visual mode, see layout-visual.ts) only the hero scene is read; else every face.
  const hero = Picture === undefined ? undefined : heroOf(state, inputs.heroId)
  const shown = hero === undefined ? state.scenes : [hero]
  const faces: Faces = Picture === undefined ? new Map() : await loadFaces($, shown)

  // A pane is sized to its own body (narrower than the viewport while docked);
  // the viewport is the fallback when the surface did not report the body.
  const columns = e.props.bodyColumns ?? e.viewport?.columns ?? FALLBACK_COLUMNS
  const bodyRows =
    e.props.scroll?.bodyRows ??
    Math.max(1, (e.viewport?.rows ?? FALLBACK_ROWS) - VIEWPORT_CHROME_ROWS)
  const offset = e.props.scroll?.offset ?? 0

  const extras = {
    outlines: await loadOutlines($, shown),
    ...(inputs.note === undefined ? {} : { note: inputs.note }),
    // Only a terminal that has Image can show the live picture, so only it gets the live frame and its buttons.
    ...(Picture === undefined || inputs.live === undefined || inputs.live === null ? {} : { live: inputs.live }),
    ...(inputs.agents === undefined || inputs.agents === null ? {} : { agents: inputs.agents }),
  }
  const press = (key: string): void => {
    if (key.startsWith(ANSWER_KEY_PREFIX)) inputs.onAnswer?.(key.slice(ANSWER_KEY_PREFIX.length))
    else if (key.startsWith(AGENT_KEY_PREFIX)) inputs.onAgent?.(key)
    else if (key.startsWith(HERO_KEY_PREFIX)) inputs.onHero?.(key.slice(HERO_KEY_PREFIX.length))
    else if (key.startsWith(SCROLL_KEY_PREFIX) && isScrollAction(key.slice(SCROLL_KEY_PREFIX.length))) inputs.onScroll?.(key.slice(SCROLL_KEY_PREFIX.length) as ScrollAction)
    else if (key.startsWith(LIVE_KEY_PREFIX) && isLiveStep(key.slice(LIVE_KEY_PREFIX.length))) inputs.onLive?.(key.slice(LIVE_KEY_PREFIX.length) as LiveStep)
  }
  const content = paneContent(state, columns, bodyRows, {
    canDraw: Picture !== undefined,
    faces,
    extras,
    heroId: inputs.heroId ?? null,
  })
  // The key hint is only owed while the scroll buttons (which carry the hotkeys) are in the picture.
  const hasScrollKeys = content.some(line => line.some(seg => seg.button?.key.startsWith(SCROLL_KEY_PREFIX) === true))
  const lines: Line[] = windowTree(content, state, columns, offset, bodyRows, hasScrollKeys ? SCROLL_KEYS_HINT : '').tree

  const rows: RenderElement[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as Line
    const picture = line.find(seg => seg.image !== undefined)?.image
    if (picture !== undefined && Picture !== undefined) {
      if (picture.key === LIVE_KEY) inputs.onLiveBox?.({ columns: picture.columns, rows: picture.rows })
      // A live frame is a KEYED Image whose source is the frame's file: `ui.blit` swaps it in place at the frame rate.
      const source =
        picture.file === undefined
          ? { png: picture.png }
          : { file: picture.file, format: 'png' as const, ...(picture.generation === undefined ? {} : { generation: picture.generation }) }
      rows.push(
        <Picture {...(picture.key === undefined ? {} : { key: picture.key })} source={source} columns={picture.columns} rows={picture.rows} alt={picture.alt} />,
      )
      // The placeholder rows under it are part of the picture: skip them (not a footer among them).
      for (let left = imageRows(line) - 1; left > 0 && isPlaceholder(lines[i + 1]); left--) i++
      continue
    }
    if (line.some(seg => seg.button !== undefined)) {
      // A button row (an answer, or the live view's slide buttons): the box side, then the Button (it draws its own `[ label ]`).
      rows.push(
        <Box flexDirection="row">
          {line.map(seg =>
            seg.button === undefined ? (
              <Text {...segProps(seg)}>{seg.text}</Text>
            ) : (
              <Button
                key={seg.button.key}
                label={seg.button.label}
                {...(seg.button.hotkey === undefined ? {} : { hotkey: seg.button.hotkey })}
                onPress={() => press(seg.button?.key ?? '')}
              />
            ),
          )}
        </Box>,
      )
      continue
    }
    rows.push(
      <Text wrap="truncate-end">
        {line.map(seg =>
          seg.href === undefined ? (
            <Text {...segProps(seg)}>{seg.text}</Text>
          ) : (
            <Link href={seg.href}>{seg.text}</Link>
          ),
        )}
      </Text>,
    )
  }

  return <Box flexDirection="column">{rows}</Box>
}
