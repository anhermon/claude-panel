// Validators for the item-based block kinds: steps, metrics, tree, options,
// timeline, sources.
import type { PanelBlock } from '../../types'
import {
  BLOCK_CAPS as C,
  DELTA_TONES,
  STEP_STATES,
  TREE_MARKS,
  cell,
  httpUrl,
  isAbsent,
  items,
  opt,
  optOneOf,
  optStr,
  oneOf,
  str,
  strings,
  Invalid,
} from './common'
import type { Plain } from './common'

type Check = (b: Plain, path: string, trimmed: string[]) => PanelBlock

export const steps: Check = (b, path, t) => ({
  kind: 'steps',
  items: items(b.items, `${path}.items`, ['text', 'state', 'note'], C.STEPS_ITEMS, t, (it, p) => ({
    text: str(it.text, `${p}.text`, C.STEPS_TEXT_CHARS, t),
    state: oneOf(it.state, `${p}.state`, STEP_STATES),
    ...opt('note', optStr(it, 'note', p, C.STEPS_NOTE_CHARS, t)),
  })),
})

export const metrics: Check = (b, path, t) => ({
  kind: 'metrics',
  items: items(
    b.items,
    `${path}.items`,
    ['label', 'value', 'delta', 'tone'],
    C.METRICS_ITEMS,
    t,
    (it, p) => ({
      label: str(it.label, `${p}.label`, C.METRICS_LABEL_CHARS, t),
      value: cell(it.value, `${p}.value`, C.METRICS_VALUE_CHARS, t),
      ...opt(
        'delta',
        isAbsent(it.delta) ? undefined : cell(it.delta, `${p}.delta`, C.METRICS_DELTA_CHARS, t),
      ),
      ...opt('tone', optOneOf(it, 'tone', p, DELTA_TONES)),
    }),
  ),
})

export const tree: Check = (b, path, t) => ({
  kind: 'tree',
  items: items(b.items, `${path}.items`, ['path', 'mark', 'note'], C.TREE_ITEMS, t, (it, p) => ({
    path: str(it.path, `${p}.path`, C.TREE_PATH_CHARS, t),
    ...opt('mark', optOneOf(it, 'mark', p, TREE_MARKS)),
    ...opt('note', optStr(it, 'note', p, C.TREE_NOTE_CHARS, t)),
  })),
})

const optPoints = (it: Plain, key: 'pros' | 'cons', p: string, t: string[]) =>
  isAbsent(it[key])
    ? undefined
    : strings(it[key], `${p}.${key}`, C.OPTIONS_POINTS, C.OPTIONS_POINT_CHARS, t)

export const options: Check = (b, path, t) => ({
  kind: 'options',
  items: items(
    b.items,
    `${path}.items`,
    ['title', 'summary', 'pros', 'cons', 'pick'],
    C.OPTIONS_ITEMS,
    t,
    (it, p) => {
      if (!isAbsent(it.pick) && typeof it.pick !== 'boolean')
        throw new Invalid(`${p}.pick must be a boolean`)
      return {
        title: str(it.title, `${p}.title`, C.OPTIONS_TITLE_CHARS, t),
        ...opt('summary', optStr(it, 'summary', p, C.OPTIONS_SUMMARY_CHARS, t)),
        ...opt('pros', optPoints(it, 'pros', p, t)),
        ...opt('cons', optPoints(it, 'cons', p, t)),
        ...opt('pick', isAbsent(it.pick) ? undefined : (it.pick as boolean)),
      }
    },
  ),
})

export const timeline: Check = (b, path, t) => ({
  kind: 'timeline',
  items: items(
    b.items,
    `${path}.items`,
    ['when', 'text', 'tone'],
    C.TIMELINE_ITEMS,
    t,
    (it, p) => ({
      ...opt('when', optStr(it, 'when', p, C.TIMELINE_WHEN_CHARS, t)),
      text: str(it.text, `${p}.text`, C.TIMELINE_TEXT_CHARS, t),
      ...opt('tone', optOneOf(it, 'tone', p, DELTA_TONES)),
    }),
  ),
})

export const sources: Check = (b, path, t) => ({
  kind: 'sources',
  items: items(
    b.items,
    `${path}.items`,
    ['title', 'url', 'note'],
    C.SOURCES_ITEMS,
    t,
    (it, p) => ({
      title: str(it.title, `${p}.title`, C.SOURCES_TITLE_CHARS, t),
      ...opt('url', httpUrl(it, 'url', p, C.SOURCES_URL_CHARS, t)),
      ...opt('note', optStr(it, 'note', p, C.SOURCES_NOTE_CHARS, t)),
    }),
  ),
})
