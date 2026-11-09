#!/usr/bin/env node
// Prints the pane's lines for a state at given widths, as plain text, so the
// layout can be judged by eye. Runs the exact code the pane runs.
//   node scripts/print-pane.mjs [width ...] [--state file.json] [--rows N] [--offset N] [--visual [--hero id]]
// Defaults: widths 45 and 100, the fixture web/sample-state.json, all rows (30 with --visual).
// --visual prints the VISUAL pane (what a terminal that can draw images shows): the hero scene's picture and nothing
// else but the ask box, the control rows and the footer; --hero picks the hero scene. The picture is a block of `#`
// filling its cells (the live picture takes every row the others leave, at the width of the pane).
// A stage scene's slide outline is read from its entry page, its dir resolved against the state file's folder.
// With --rows N the pane shows only an N-row window starting at --offset M
// (scroll.bodyRows / scroll.offset), the footer pinned on its last row.
// The live preview (hooks/live.ts: a screencast child that swaps the stage scene's Image) is NOT run here: the pane is
// printed from the state alone. Without --visual a stage scene shows its text face and no slide buttons.
import { register } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_WIDTHS = [45, 100]
const ALL_ROWS = 10_000
const VISUAL_ROWS = 30
// The pretend picture of --visual: the size of a live frame.
const FRAME = { width: 960, height: 540 }

// The modules import each other without extensions (the engine wants that);
// Node's ESM loader does not, so retry with `.ts`.
const resolveHook = `export async function resolve(spec, ctx, next) {
  try { return await next(spec, ctx) }
  catch (err) {
    if (spec.startsWith('.') && !/\\.[a-z]+$/.test(spec)) return next(spec + '.ts', ctx)
    throw err
  }
}`
register('data:text/javascript,' + encodeURIComponent(resolveHook), import.meta.url)

const args = process.argv.slice(2)
const flag = name => {
  const i = args.indexOf(name)
  return i < 0 ? undefined : args.splice(i, 2)[1]
}
const stateFile = flag('--state') ?? join(root, 'web/sample-state.json')
const isVisual = args.includes('--visual') && args.splice(args.indexOf('--visual'), 1).length > 0
const heroId = flag('--hero') ?? null
const rows = Number(flag('--rows') ?? (isVisual ? VISUAL_ROWS : ALL_ROWS))
const offset = Number(flag('--offset') ?? 0)
const widths = args.length > 0 ? args.map(Number) : DEFAULT_WIDTHS

const load = file => import(pathToFileURL(join(root, 'hooks', file)).href)
const { paneContent } = await load('layout-visual.ts')
const { heroOf } = await load('hero.ts')
const { windowTree } = await load('scroll.ts')
const { cellWidth } = await load('layout-text.ts')
const { outlineOf } = await load('outline.ts')
const state = JSON.parse(readFileSync(stateFile, 'utf8'))

const DEFAULT_ENTRY = 'index.html'
const outlines = new Map()
for (const scene of state.scenes ?? []) {
  if (scene.layout !== 'stage') continue
  const page = join(resolve(dirname(stateFile), scene.dir ?? ''), scene.entry ?? DEFAULT_ENTRY)
  if (existsSync(page)) outlines.set(scene.id, outlineOf(readFileSync(page, 'utf8')))
}

const hero = isVisual ? heroOf(state, heroId) : undefined
const faces = new Map(hero === undefined ? [] : [[hero.id, { png: '', ...FRAME }]])
const live = hero?.layout === 'stage' ? { sceneId: hero.id, file: '/live.png', generation: 1, ...FRAME } : undefined
const extras = { outlines, ...(live === undefined ? {} : { live }) }

let isOver = false
for (const width of widths) {
  const ctx = { canDraw: isVisual, faces, extras, heroId }
  const { tree } = windowTree(paneContent(state, width, rows, ctx), state, width, offset, rows)
  const shown = tree.slice(offset, offset + rows)
  // The picture (only with --visual) prints as a bordered block of exactly its cells, so the fill of the pane shows:
  // its first row carries the image, the rows under it are the placeholders.
  const text = tree.map(line => line.map(seg => seg.text).join(''))
  const at = tree.findIndex(line => line.some(seg => seg.image))
  if (at >= 0) {
    const pic = tree[at].find(seg => seg.image).image
    const label = `picture ${pic.columns}x${pic.rows} cells`
    for (let r = 0; r < pic.rows && at + r < text.length; r++) {
      const edge = r === 0 || r === pic.rows - 1
      const middle = r === Math.floor(pic.rows / 2) ? label.slice(0, pic.columns - 2).padStart(Math.floor((pic.columns - 2 + label.length) / 2)).padEnd(pic.columns - 2) : ' '.repeat(pic.columns - 2)
      text[at + r] = edge ? '#'.repeat(pic.columns) : `#${middle}#`
    }
  }
  const ruler = '+' + '-'.repeat(Math.max(0, width - 2)) + '+'
  console.log(`=== width ${width} ===`)
  console.log(ruler)
  for (const t of rows === ALL_ROWS ? text : text.slice(offset, offset + rows)) console.log(t)
  console.log(ruler)
  const widest = Math.max(...text.map(cellWidth))
  console.log(`(${shown.length} rows, widest ${widest} of ${width})\n`)
  if (widest > width) isOver = true
}
if (isOver) {
  console.error('FAIL: a line is wider than the pane')
  process.exit(1)
}
