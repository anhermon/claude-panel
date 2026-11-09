// Static guard for skills/panel-guide (the render half is tests/render-recipes.mjs, which needs Chrome).
//  - every `<!-- panel-input -->` / `<!-- scene-input -->` JSON example in the skill passes the tool schema AND the real validator
//  - every markdown file is linked from SKILL.md, SKILL.md stays short and mentions what the brief requires
//  - every recipe is a self-contained scene: no network URLs, only kit import specifiers, only documented <p-*> tags and
//    attributes, no browser storage, scripts parse, referenced files exist, notes on every deck slide
// Not a *.test.ts on purpose: `claude plugin test` forbids node:fs in a test file, and tsc (no @types/node) covers tests/*.ts.
// Run: bun tests/skill-examples.check.mjs
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { applyInput, emptyState } from '../hooks/state.ts'
import { parseSceneInput } from '../hooks/scene.ts'
import { SCENE_INPUT_SCHEMA, TOOL_INPUT_SCHEMA } from '../hooks/spec.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SKILL_DIR = join(ROOT, 'skills', 'panel-guide')
const SKILL_FILE = join(SKILL_DIR, 'SKILL.md')
const KIT_DIR = join(ROOT, 'web', 'kit')
const NOW = 1_767_000_000_000
const MAX_SKILL_LINES = 200
const MAX_RECIPE_LINES = 220
const MAX_CODE_FILE_LINES = 800 // the global rule for every code file
const KIND_COUNT = 17
const RECIPES = ['deck-explain', 'deck-compare', 'deck-review', 'stage-demo', 'chart', 'diagram', 'uml', 'three', 'audio', 'animation', 'assets', 'visual-assets', 'freeform-compose']
const HOUSE_IMPORTS = ['panel', 'panel/deck', 'panel/components', 'panel/diagrams', 'panel/assets', 'panel/ui']
const MARKERS = { panel: '<!-- panel-input -->', scene: '<!-- scene-input -->' }
const SKILL_MUST_MENTION = ['say -o', 'afconvert', 'shot_at', 'shot: false', 'panel.emit', '<panel-events>', 'untrusted', 'choices', '/panel live',
  'goto', 'live/', 'sips', 'CSP', 'prefers-reduced-motion', 'speaker notes', 'references/components.md']
const SVG_NS = 'http://www.w3.org/2000/svg'
const GLOBAL_ATTRS = /^(class|id|style|hidden|role|tabindex|slot|lang|aria-[\w-]+|data-id|data-fragment-index)$/
const LI_ATTRS = ['data-node', 'data-from', 'data-to', 'data-when', 'data-tone']
const STORAGE = /localStorage|sessionStorage|indexedDB|document\.cookie/
const NET_URL = /(?:https?:)?\/\/[\w-]+(?:\.[\w-]+)+/i // a host, with or without a scheme
const NET_REF = [
  /\b(?:src|href|poster|srcset|action)\s*=\s*["']?\s*(?:https?:)?\/\//i,
  /\burl\(\s*["']?\s*(?:https?:)?\/\//i,
  /\bfrom\s*["'](?:https?:)?\/\//i,
  /\bimport\s*\(?\s*["'](?:https?:)?\/\//i,
  /@import\s+["'](?:https?:)?\/\//i,
  /\b(?:fetch|open)\s*\(\s*["'`](?:https?:)?\/\//i,
]
const LOCAL_FILE = /['"]([\w./-]+\.(?:png|jpe?g|gif|webp|svg|json|csv|txt|glb|gltf|mp3|wav|m4a|ogg|mp4|webm))['"]/g
const IMPORT_SPEC = /\bimport\s*(?:[\w*{}\s,]+\bfrom\s*)?['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)/g
const SCANNED_EXT = /\.(html|js|mjs|css|svg|json|txt)$/
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor

const files = dir => readdirSync(dir).flatMap(n => { const p = join(dir, n); return statSync(p).isDirectory() ? files(p) : [p] })
const read = p => readFileSync(p, 'utf8')
const lineCount = p => read(p).trimEnd().split('\n').length
const rel = p => relative(SKILL_DIR, p)
const noComments = s => s.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\w])\/\/[^\n]*/g, '$1')

// ---- tiny JSON-schema check (type, enum, required, properties, additionalProperties:false, items, anyOf) --------------------
function schemaCheck(schema, v, at) {
  if (schema.anyOf) return assert.ok(schema.anyOf.some(s => { try { schemaCheck(s, v, at); return true } catch { return false } }), `${at}: matches no anyOf`)
  if (schema.enum) assert.ok(schema.enum.includes(v), `${at}: ${JSON.stringify(v)} not in ${JSON.stringify(schema.enum)}`)
  const kind = Array.isArray(v) ? 'array' : v === null ? 'null' : Number.isInteger(v) ? 'integer' : typeof v
  if (schema.type) assert.ok(kind === schema.type || (schema.type === 'number' && kind === 'integer'), `${at}: expected ${schema.type}, got ${kind}`)
  if (schema.type === 'object') {
    for (const k of schema.required ?? []) assert.ok(k in v, `${at}: missing required "${k}"`)
    for (const [k, val] of Object.entries(v)) {
      if (schema.properties?.[k]) schemaCheck(schema.properties[k], val, `${at}.${k}`)
      else assert.ok(schema.additionalProperties !== false, `${at}: unknown field "${k}"`)
    }
  }
  if (schema.type === 'array' && schema.items) v.forEach((x, i) => schemaCheck(schema.items, x, `${at}[${i}]`))
}

// ---- examples in markdown -----------------------------------------------------------------------------------------------
function examples(file, marker) {
  const ls = read(file).split('\n'), out = []
  ls.forEach((line, i) => {
    if (line.trim() !== marker) return
    assert.equal(ls[i + 1]?.trim(), '```json', `${rel(file)}:${i + 1}: marker not followed by a json fence`)
    const end = ls.findIndex((l, j) => j > i + 1 && l.trim() === '```')
    out.push({ at: `${rel(file)}:${i + 2}`, input: JSON.parse(ls.slice(i + 2, end).join('\n')) })
  })
  return out
}

function panelAccepted(label, input) {
  schemaCheck(TOOL_INPUT_SCHEMA, input, label)
  const r = applyInput(emptyState(), input, NOW)
  assert.equal(r.deny, undefined, `${label} denied: ${r.deny}`)
  assert.notEqual(r.isOk, false, `${label} rejected: ${r.error}`)
  assert.deepEqual(r.trimmed ?? [], [], `${label} was trimmed`)
}

// ---- the kit's vocabulary ----------------------------------------------------------------------------------------------
const manifest = JSON.parse(read(join(KIT_DIR, 'manifest.json')))
const kitSpecifiers = new Set(manifest.libs.flatMap(l => Object.keys(l.imports ?? {})))
const kitPrefixes = [...new Set(manifest.libs.flatMap(l => Object.keys(l.prefixes ?? {})).concat('three/addons/'))]
const knownSpecifier = s => HOUSE_IMPORTS.includes(s) || kitSpecifiers.has(s) || kitPrefixes.some(p => s.startsWith(p))

const readme = read(join(KIT_DIR, 'panel', 'README.md'))
const elements = new Map() // tag -> Set of documented attributes
for (const [, tag, body] of readme.matchAll(/^### `<(p-[a-z0-9-]+)>`[^\n]*\n([\s\S]*?)(?=^#{2,3} )/gm)) {
  const attrs = new Set()
  for (const row of body.matchAll(/^\|\s*([^|\n]+?)\s*\|/gm)) for (const [, a] of row[1].matchAll(/`([a-z][\w-]*)`/g)) attrs.add(a)
  elements.set(tag, attrs)
}
assert.ok(elements.size >= 8, `README.md documents only ${elements.size} <p-*> elements`)
for (const a of LI_ATTRS) assert.ok(readme.includes(a), `README.md no longer documents ${a}`)

function checkElements(text, at) {
  for (const [, tag, rest] of text.matchAll(/<(p-[a-z0-9-]+)((?:[^>"']|"[^"]*"|'[^']*')*)>/g)) {
    assert.ok(elements.has(tag), `${at}: <${tag}> is not documented in web/kit/panel/README.md`)
    for (const [, name] of rest.matchAll(/(?:^|\s)([a-zA-Z_:][-\w:.]*)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?/g)) {
      assert.ok(elements.get(tag).has(name) || GLOBAL_ATTRS.test(name), `${at}: <${tag} ${name}> is not a documented attribute`)
    }
  }
  for (const [, a] of text.matchAll(/<li\s[^>]*?\b(data-[a-z]+)\b/g)) if (/data-(node|from|to|when|tone)/.test(a)) assert.ok(LI_ATTRS.includes(a), `${at}: unknown li attribute ${a}`)
}

// ---- SKILL.md and the other markdown ------------------------------------------------------------------------------------
const markdown = files(SKILL_DIR).filter(f => f.endsWith('.md'))
const skill = read(SKILL_FILE)
assert.match(skill, /^---\nname: panel-guide\ndescription: .+\n---\n/, 'SKILL.md frontmatter: name panel-guide + description')
assert.ok(lineCount(SKILL_FILE) <= MAX_SKILL_LINES, `SKILL.md has ${lineCount(SKILL_FILE)} lines, limit ${MAX_SKILL_LINES}`)
for (const phrase of SKILL_MUST_MENTION) assert.ok(skill.includes(phrase), `SKILL.md must mention "${phrase}"`)
for (const f of markdown) if (f !== SKILL_FILE) assert.ok(skill.includes(`(${rel(f)})`), `${rel(f)} is not linked from SKILL.md`)
for (const [, target] of skill.matchAll(/\]\(([^)#\s]+)\)/g)) assert.ok(/^https?:/.test(target) || existsSync(join(SKILL_DIR, target)), `SKILL.md links a missing file: ${target}`)
assert.ok(!/https?:\/\//.test(skill), 'SKILL.md must not point at network URLs')
checkElements(skill, 'SKILL.md')
for (const [, spec] of skill.matchAll(/^import ['"]([^'"]+)['"]/gm)) assert.ok(knownSpecifier(spec), `SKILL.md imports unknown specifier ${spec}`)

const panelInputs = markdown.flatMap(f => examples(f, MARKERS.panel))
const sceneInputs = markdown.flatMap(f => examples(f, MARKERS.scene))
assert.ok(panelInputs.length >= 2, 'expected panel-input examples (ask+choices, card)')
assert.ok(sceneInputs.length >= 2, 'expected scene-input examples (stage publish, goto)')
for (const { at, input } of panelInputs) panelAccepted(at, input)
for (const { at, input } of sceneInputs) { schemaCheck(SCENE_INPUT_SCHEMA, input, at); parseSceneInput(input) }
assert.ok(sceneInputs.some(s => s.input.layout === 'stage' && s.input.alt), 'a scene-input example must publish a stage scene with alt')
assert.ok(sceneInputs.some(s => s.input.goto), 'a scene-input example must show goto')
assert.ok(panelInputs.some(s => s.input.ask && s.input.choices?.length), 'a panel-input example must show ask + choices')

const components = read(join(SKILL_DIR, 'references', 'components.md'))
const snippets = [...components.matchAll(/^```json\n([\s\S]*?)\n```$/gm)].map(m => JSON.parse(m[1]))
assert.equal(snippets.length, KIND_COUNT, 'components.md: one json example per block kind')
const headings = [...components.matchAll(/^## (\w+)$/gm)].map(m => m[1]).filter(h => h !== 'Quick')
assert.deepEqual(snippets.map(s => s.kind), headings, 'components.md: example kind matches its heading')
for (const block of snippets) panelAccepted(`components.md ${block.kind}`, { card: { id: 'x', blocks: [block] } })

// ---- recipes ------------------------------------------------------------------------------------------------------------
const recipesDir = join(SKILL_DIR, 'recipes')
assert.deepEqual(readdirSync(recipesDir).sort(), [...RECIPES].sort(), 'recipes/ holds exactly the documented recipes')
let specifierCount = 0, elementCount = 0
for (const name of RECIPES) {
  const dir = join(recipesDir, name), page = join(dir, 'index.html'), at = `recipes/${name}/index.html`
  const html = read(page), dirFiles = files(dir)
  assert.ok(lineCount(page) <= MAX_RECIPE_LINES, `${at} has ${lineCount(page)} lines, limit ${MAX_RECIPE_LINES}`)
  assert.ok(skill.includes(`(recipes/${name}/index.html)`), `${at} is not linked from SKILL.md`)
  const header = html.match(/<!--([\s\S]*?)-->/)?.[1] ?? ''
  for (const key of ['RECIPE', 'Use when', 'Adapt', 'Constraints']) assert.ok(header.includes(key), `${at}: header comment lacks "${key}"`)
  assert.match(html, /^<!doctype html>/i, `${at}: full document expected`)
  assert.match(html, /name="viewport"/, `${at}: needs a viewport meta`)
  assert.match(noComments(html), /--panel-|--deck-|prefers-color-scheme/, `${at}: use the panel tokens (--panel-*, --deck-*) or honour prefers-color-scheme`)

  for (const f of dirFiles) {
    assert.ok(lineCount(f) <= MAX_CODE_FILE_LINES || !SCANNED_EXT.test(f), `${rel(f)} over ${MAX_CODE_FILE_LINES} lines`)
    if (!SCANNED_EXT.test(f)) continue
    const code = noComments(read(f)).replaceAll(SVG_NS, '') // the SVG namespace is an identifier, not a request
    for (const re of NET_REF) assert.ok(!re.test(code), `${rel(f)}: network reference (${re}); nothing may load from outside the folder or the kit`)
    assert.ok(!NET_URL.test(code), `${rel(f)}: contains a host-like URL: ${code.match(NET_URL)?.[0]}`)
  }

  const code = noComments(html)
  assert.ok(!STORAGE.test(code), `${at}: browser storage is unavailable in the sandbox`)
  for (const [, ref] of code.matchAll(LOCAL_FILE)) assert.ok(dirFiles.includes(join(dir, ref)), `${at}: references missing file ${ref}`)
  for (const tag of html.matchAll(/<img\b[^>]*>/g)) assert.match(tag[0], /\balt=/, `${at}: <img> needs alt`)

  checkElements(code, at)
  elementCount += (code.match(/<p-[a-z0-9-]+/g) ?? []).length

  const scripts = [...code.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)]
  const body = scripts.map(m => m[2]).join('\n') + readdirSync(dir).filter(f => /\.m?js$/.test(f)).map(f => read(join(dir, f))).join('\n')
  for (const spec of [...body.matchAll(IMPORT_SPEC)].map(m => m[1] ?? m[2])) {
    specifierCount++
    assert.ok(spec.startsWith('.') ? existsSync(join(dir, spec)) : knownSpecifier(spec), `${at}: import specifier "${spec}" is not in the kit manifest or the house set`)
  }
  for (const [, attrs, src] of scripts) {
    if (/\ssrc=/.test(attrs) || !src.trim()) continue
    const type = attrs.match(/type="([^"]+)"/)?.[1] ?? 'text/javascript'
    if (type === 'importmap') JSON.parse(src)
    else if (type === 'module') new AsyncFunction(src.replace(/^\s*import\s[^;'"]*?from\s*['"][^'"]+['"];?/gm, '').replace(/^\s*import\s*['"][^'"]+['"];?/gm, ''))
    else new Function(src)
  }
  if (name.startsWith('deck-')) {
    const slides = (code.match(/<section\b/g) ?? []).length, notes = (code.match(/<aside class="notes"/g) ?? []).length
    assert.ok(slides >= 3 && slides <= 8, `${at}: ${slides} slides, expected 3-8`)
    assert.equal(notes, slides, `${at}: every slide needs speaker notes (${notes} notes for ${slides} slides)`)
    assert.match(code, /import\s*['"]panel\/deck['"]/, `${at}: a deck imports panel/deck`)
  }
}
assert.ok(specifierCount > 0 && elementCount > 0, 'recipes: expected import specifiers and <p-*> elements to have been checked')

console.log(`ok: ${panelInputs.length} panel + ${sceneInputs.length} scene examples, ${snippets.length} block snippets, ${RECIPES.length} recipes ` +
  `(${specifierCount} imports, ${elementCount} <p-*> tags checked), ${files(SKILL_DIR).length} files`)
