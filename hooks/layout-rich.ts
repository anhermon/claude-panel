// Terminal renderers for the "rich" block kinds: diff, tree, options, timeline,
// sources, quote. Like the others they are pure and never exceed `width` cells.
import { BLANK, COLOR, GAP, GLYPH } from './layout-types'
import type { Line, Seg } from './layout-types'
import { cellWidth, clean, fit, hang, own, pad, padEnd, recs, str, strs, wrapText } from './layout-text'
import type { Rec } from './layout-text'

// ---- diff ------------------------------------------------------------------
const DIFF_FILE_HEADERS = ['+++ ', '--- ']

export function diffBlock(b: Rec, width: number): Line[] {
  const out: Line[] = []
  const file = str(b.file).trim()
  if (file !== '') out.push([{ text: fit(file, width), isDim: true, isBold: true }])
  const text = clean(str(b.text))
  if (text.trim() === '') return out
  for (const raw of text.split('\n')) {
    const shown = fit(raw, width)
    const isHeader = DIFF_FILE_HEADERS.some(h => raw.startsWith(h))
    if (raw.startsWith('@@') || isHeader) out.push([{ text: shown, isDim: true }])
    else if (raw.startsWith('+')) out.push([{ text: shown, color: COLOR.OK }])
    else if (raw.startsWith('-')) out.push([{ text: shown, color: COLOR.DANGER }])
    else out.push([{ text: shown }])
  }
  return out
}

// ---- tree ------------------------------------------------------------------
const TREE_MARK: Record<string, Seg> = {
  added: { text: '+ ', color: COLOR.OK },
  changed: { text: '~ ', color: COLOR.WARN },
  removed: { text: '- ', color: COLOR.DANGER },
  focus: { text: '◉ ', color: COLOR.ACCENT },
}
const TREE_NO_MARK = '  '
const TREE_INDENT = 2
const TREE_MIN_NAME = 8
const TREE_NOTE_MIN = 4

type TreeNode = { name: string; isDir: boolean; mark: string; note: string; kids: TreeNode[] }

function buildTree(items: readonly Rec[]): TreeNode {
  const root: TreeNode = { name: '', isDir: true, mark: '', note: '', kids: [] }
  for (const it of items) {
    const path = str(it.path).trim()
    const parts = path.split('/').filter(p => p !== '' && p !== '.')
    if (parts.length === 0) continue
    const isDirItem = path.endsWith('/')
    let at = root
    parts.forEach((part, i) => {
      const isLast = i === parts.length - 1
      const wantsDir = !isLast || isDirItem
      let next = at.kids.find(k => k.name === part && k.isDir === wantsDir)
      if (next === undefined) {
        next = { name: part, isDir: wantsDir, mark: '', note: '', kids: [] }
        at.kids.push(next)
      }
      if (isLast) {
        next.mark = str(it.mark)
        next.note = str(it.note)
      }
      at = next
    })
  }
  return root
}

/** `src` → `net` → files becomes one `src/net/` line when nothing else hangs off `src`. */
function squash(n: TreeNode): TreeNode {
  let node = n
  while (node.isDir && node.name !== '' && node.mark === '' && node.note === '' && node.kids.length === 1) {
    const only = node.kids[0] as TreeNode
    if (!only.isDir) break
    node = { ...only, name: `${node.name}/${only.name}` }
  }
  return { ...node, kids: node.kids.map(squash) }
}

function treeLines(n: TreeNode, depth: number, width: number, out: Line[]): void {
  for (const k of n.kids) {
    const indent = Math.min(depth * TREE_INDENT, Math.max(0, width - TREE_NO_MARK.length - TREE_MIN_NAME))
    const avail = width - TREE_NO_MARK.length - indent
    const label = fit(k.isDir ? `${k.name}/` : k.name, avail)
    const room = avail - cellWidth(label) - GAP
    const segs: Seg[] = [
      own(TREE_MARK, k.mark) ?? { text: TREE_NO_MARK },
      { text: pad(indent) },
      k.isDir ? { text: label, isDim: true } : k.mark === 'focus' ? { text: label, isBold: true } : { text: label },
    ]
    if (k.note.trim() !== '' && room >= TREE_NOTE_MIN) segs.push({ text: pad(GAP) + fit(k.note, room), isDim: true })
    out.push(segs)
    treeLines(k, depth + 1, width, out)
  }
}

export function treeBlock(b: Rec, width: number): Line[] {
  const out: Line[] = []
  treeLines(squash(buildTree(recs(b.items))), 0, width, out)
  return out
}

// ---- options ---------------------------------------------------------------
const PICK_TAG = 'Recommended'
const OPTION_INDENT = 2
const OPTION_PICK_PREFIX = `${GLYPH.STAR} `

function optionLines(it: Rec, width: number): Line[] {
  const inner = width - OPTION_INDENT
  const isPick = it.pick === true
  const title = wrapText(str(it.title), inner)
  const lines: Line[] = title.map((l, i): Line => [
    isPick && i === 0
      ? { text: OPTION_PICK_PREFIX, color: COLOR.ACCENT }
      : { text: pad(OPTION_INDENT) },
    { text: l, isBold: true },
  ])
  if (isPick) {
    // The tag rides on the title's last row when it fits, else gets a row of its own.
    const last = lines.length - 1
    const lastW = cellWidth(title[last] ?? '')
    const tag: Seg = { text: ' ' + PICK_TAG, color: COLOR.ACCENT, isBold: true }
    if (lastW + cellWidth(tag.text) <= inner) lines[last] = [...(lines[last] as Line), tag]
    else lines.push([{ text: pad(OPTION_INDENT) }, { ...tag, text: PICK_TAG }])
  }
  const indent: Seg = { text: pad(OPTION_INDENT) }
  const summary = str(it.summary)
  if (summary.trim() !== '') lines.push(...hang(indent, summary, width, { isDim: true }))
  for (const p of strs(it.pros))
    lines.push(...hang({ text: pad(OPTION_INDENT) + `${GLYPH.DONE} `, color: COLOR.OK }, p, width))
  for (const c of strs(it.cons))
    lines.push(...hang({ text: pad(OPTION_INDENT) + `${GLYPH.FAIL} `, color: COLOR.DANGER }, c, width))
  return lines
}

export function optionsBlock(b: Rec, width: number): Line[] {
  const blocks = recs(b.items)
    .filter(it => str(it.title).trim() !== '')
    .map(it => optionLines(it, width))
  return blocks.flatMap((l, i) => (i === 0 ? l : [BLANK, ...l]))
}

// ---- timeline --------------------------------------------------------------
const TIMELINE_TONE: Record<string, string> = { ok: COLOR.OK, warn: COLOR.WARN, danger: COLOR.DANGER }
const TIMELINE_WHEN_SHARE = 1 / 3
const TIMELINE_MIN_TEXT = 14
const TIMELINE_GUTTER = 2

export function timelineBlock(b: Rec, width: number): Line[] {
  const items = recs(b.items)
    .map(it => ({ when: str(it.when).trim(), text: str(it.text), color: own(TIMELINE_TONE, str(it.tone)) }))
    .filter(it => it.text.trim() !== '')
  if (items.length === 0) return []
  const whenW = Math.min(
    Math.max(...items.map(i => cellWidth(i.when))),
    Math.floor(width * TIMELINE_WHEN_SHARE),
  )
  const textW = width - TIMELINE_GUTTER - (whenW > 0 ? whenW + GAP : 0)
  const isStacked = textW < TIMELINE_MIN_TEXT
  const dot = (color: string | undefined): Seg => ({ text: `${GLYPH.TL_DOT} `, ...(color ? { color } : { isDim: true }) })
  const rail: Seg = { text: `${GLYPH.TL_LINE} `, isDim: true }
  const out: Line[] = []
  for (const it of items) {
    if (isStacked) {
      out.push([dot(it.color), { text: fit(it.when, width - TIMELINE_GUTTER), isDim: true }])
      out.push(...wrapText(it.text, width - TIMELINE_GUTTER).map((l): Line => [rail, { text: l }]))
      continue
    }
    const wrapped = wrapText(it.text, textW)
    wrapped.forEach((l, i) => {
      const when = i === 0 ? padEnd(fit(it.when, whenW), whenW) + (whenW > 0 ? pad(GAP) : '') : pad(whenW > 0 ? whenW + GAP : 0)
      out.push([i === 0 ? dot(it.color) : rail, { text: when, isDim: true }, { text: l }])
    })
  }
  return out
}

// ---- sources ---------------------------------------------------------------
const URL_RE = /^https?:\/\//i
const SECURE_SCHEME = /^https:\/\//i
const SOURCE_INDENT = '  '
const SOURCE_BULLET: Seg = { text: `${GLYPH.BULLET} `, isDim: true }

export function sourcesBlock(b: Rec, width: number): Line[] {
  const out: Line[] = []
  for (const it of recs(b.items)) {
    const title = str(it.title)
    if (title.trim() === '') continue
    const url = str(it.url).trim()
    const isLink = URL_RE.test(url)
    out.push(...hang(SOURCE_BULLET, title, width, isLink ? { color: COLOR.INFO } : {}))
    if (isLink)
      out.push([{ text: SOURCE_INDENT + fit(url.replace(SECURE_SCHEME, ''), width - SOURCE_INDENT.length), isDim: true }])
    const note = str(it.note)
    if (note.trim() !== '') out.push(...hang({ text: SOURCE_INDENT }, note, width, { isDim: true }))
  }
  return out
}

// ---- quote -----------------------------------------------------------------
export function quoteBlock(b: Rec, width: number): Line[] {
  const text = str(b.text)
  if (text.trim() === '') return []
  const side: Seg = { text: `${GLYPH.QUOTE_SIDE} `, isDim: true }
  const out: Line[] = wrapText(text, width - side.text.length).map((l): Line => [side, { text: l, isItalic: true }])
  const by = str(b.by).trim()
  if (by !== '') out.push([side, { text: fit(`— ${by}`, width - side.text.length), isDim: true }])
  return out
}
