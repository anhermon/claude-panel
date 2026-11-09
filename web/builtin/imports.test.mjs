// Smoke test for the pages' ES modules: every relative import must name a file that exists and an export that file has.
// A broken import makes the browser refuse the whole scene (a blank tile), so this catches a half-synced or half-edited
// tree before it is served (scripts/sync-sessions.sh runs it first). Static, no DOM: it reads the source text.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const SCENE_FILE = /\.(js|mjs)$/
const TEST_FILE = /\.test\./
const SKIPPED_DIRS = new Set(['fixtures', 'live', 'node_modules'])
const IMPORT = /import\s+([^'";]*?)\s*from\s*['"](\.[^'"]+)['"]/g
const EXPORT_DECL = /export\s+(?:async\s+)?(?:const|let|var|function\*?|class)\s+([\w$]+)/g
const EXPORT_LIST = /export\s*\{([^}]*)\}/g
const NAMED = /\{([^}]*)\}/

const walk = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return SKIPPED_DIRS.has(name) ? [] : walk(path)
    return SCENE_FILE.test(name) && !TEST_FILE.test(name) ? [path] : []
  })

const STAR_EXPORT = /export\s*\*\s*from\s*['"](\.[^'"]+)['"]/g

const exportsOf = (text, file) => {
  const names = new Set()
  for (const m of text.matchAll(STAR_EXPORT)) {
    const inner = resolve(dirname(file), m[1])
    if (existsSync(inner)) for (const n of exportsOf(readFileSync(inner, 'utf8'), inner)) names.add(n)
  }
  for (const m of text.matchAll(EXPORT_DECL)) names.add(m[1])
  for (const m of text.matchAll(EXPORT_LIST)) for (const part of m[1].split(',')) if (part.trim()) names.add(part.trim().split(/\s+as\s+/).pop())
  if (/export\s+default\b/.test(text)) names.add('default')
  return names
}

test('every relative import of the pages resolves to a file and an export that exist', () => {
  const problems = []
  for (const file of walk(ROOT)) {
    const text = readFileSync(file, 'utf8')
    for (const m of text.matchAll(IMPORT)) {
      const target = resolve(dirname(file), m[2])
      if (!existsSync(target)) {
        problems.push(`${file}: imports missing file ${m[2]}`)
        continue
      }
      const have = exportsOf(readFileSync(target, 'utf8'), target)
      const named = NAMED.exec(m[1])
      for (const part of named ? named[1].split(',') : []) {
        const name = part.trim().split(/\s+as\s+/)[0]
        if (name && !have.has(name)) problems.push(`${file}: ${m[2]} does not export ${name}`)
      }
      if (/^[\w$]+\s*(,|$)/.test(m[1].trim()) && !have.has('default')) problems.push(`${file}: ${m[2]} has no default export`)
    }
  }
  assert.deepEqual(problems, [])
})
