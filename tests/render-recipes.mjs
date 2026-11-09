// Renders every skill recipe in the REAL panel server + headless Chrome and fails on any console error or blocked request.
//   node tests/render-recipes.mjs [recipe ...] [--slides] [--out DIR] [--port N]
//   --slides  also shoot every slide of the deck recipes (#/1 ... #/n-1), so each page can be looked at, not only the first
//   --out     where the PNGs go (default: $TMPDIR/panel-recipes)
// Needs Chrome (web/shot.mjs finds it). Starts one server on a state file that lists all recipes as scenes, kills it at the end.
// Not run by `claude plugin test`: it needs a browser. Companion of tests/skill-examples.check.mjs (static checks).
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const RECIPES_DIR = join(ROOT, 'skills', 'panel-guide', 'recipes')
const SERVER = join(ROOT, 'web', 'server.mjs')
const SHOT = join(ROOT, 'web', 'shot.mjs')
const DEFAULT_PORT = 4897
const TOKEN = 't'
const SHOT_WAIT_MS = 2000
const SLIDE_WAIT_MS = 1200
const SERVER_START_MS = 8000
const SHOT_TIMEOUT_MS = 60_000
const STAGE_RECIPE = /^(deck-|stage-)/
const SLIDE_TAG = /<section\b/g
const PORT_LINE = /^PORT (\d+)/m
const FATAL_LEVELS = new Set(['error', 'assert'])

function parseArgs(argv) {
  const o = { names: [], slides: false, out: join(tmpdir(), 'panel-recipes'), port: DEFAULT_PORT }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--slides') o.slides = true
    else if (a === '--out') o.out = resolve(argv[++i])
    else if (a === '--port') o.port = Number(argv[++i])
    else if (a.startsWith('--')) throw new Error(`unknown option ${a}`)
    else o.names.push(a)
  }
  return o
}

function sceneFor(name) {
  const dir = join(RECIPES_DIR, name)
  const stage = STAGE_RECIPE.test(name)
  return { id: name.slice(0, 24), title: name, dir, alt: `Recipe ${name}`, layout: stage ? 'stage' : 'card', height: 560, rev: 1, span: 3,
    slides: stage ? Math.max(1, (readFileSync(join(dir, 'index.html'), 'utf8').match(SLIDE_TAG) ?? []).length) : 1 }
}

function startServer(stateFile, port) {
  const child = spawn(process.execPath, [SERVER, stateFile, '--token', TOKEN, '--port', String(port)], { stdio: ['ignore', 'pipe', 'pipe'] })
  return new Promise((ok, fail) => {
    let out = ''
    const timer = setTimeout(() => fail(new Error('server did not print PORT in time')), SERVER_START_MS)
    child.stdout.on('data', d => {
      out += d
      const m = PORT_LINE.exec(out)
      if (m) { clearTimeout(timer); ok({ child, port: Number(m[1]) }) }
    })
    child.on('exit', code => fail(new Error(`server exited early (${code})`)))
  })
}

function shoot(url, png, wait) {
  const r = spawnSync(process.execPath, [SHOT, url, '--out', png, '--wait', String(wait)], { encoding: 'utf8', timeout: SHOT_TIMEOUT_MS })
  try { return JSON.parse(r.stdout.trim().split('\n').pop()) } catch { return { ok: false, error: `no JSON from shot.mjs: ${r.stderr || r.stdout}`, errors: [], console: [] } }
}

const args = parseArgs(process.argv.slice(2))
const all = readdirSync(RECIPES_DIR).sort()
const names = args.names.length ? args.names : all
for (const n of names) if (!all.includes(n)) throw new Error(`no such recipe: ${n} (have ${all.join(', ')})`)
mkdirSync(args.out, { recursive: true })

const work = mkdtempSync(join(tmpdir(), 'panel-render-'))
const scenes = names.map(sceneFor)
const state = { v: 4, rev: 1, updatedAt: Date.now(), url: null, status: 'working', task: null, ask: null, choices: [], labels: {}, context: [], done: [], next: [], cards: [],
  scenes: scenes.map(({ slides, ...s }) => s) }
const stateFile = join(work, 'state.json')
writeFileSync(stateFile, JSON.stringify(state))

let server
const failures = []
try {
  server = await startServer(stateFile, args.port)
  const base = `http://127.0.0.1:${server.port}/${TOKEN}/s`
  for (const s of scenes) {
    const hashes = args.slides ? Array.from({ length: s.slides }, (_, i) => (i === 0 ? '' : `#/${i}`)) : ['']
    for (const [i, hash] of hashes.entries()) {
      const png = join(args.out, `${s.title}${hash ? `-${i + 1}` : ''}.png`)
      const r = shoot(`${base}/${s.id}/${hash}`, png, i === 0 ? SHOT_WAIT_MS : SLIDE_WAIT_MS)
      const fatal = (r.console ?? []).filter(c => FATAL_LEVELS.has(c.level))
      const bad = !r.ok || (r.errors ?? []).length > 0 || fatal.length > 0
      console.log(`${bad ? 'FAIL' : 'ok  '} ${s.title}${hash} ${bad ? JSON.stringify({ error: r.error, errors: r.errors, console: fatal }) : png}`)
      if (bad) failures.push(`${s.title}${hash}`)
    }
  }
} finally {
  server?.child.kill()
  rmSync(work, { recursive: true, force: true })
}
if (failures.length) { console.error(`${failures.length} render failure(s): ${failures.join(', ')}`); process.exit(1) }
console.log(`ok: ${names.length} recipes rendered with zero console errors, PNGs in ${args.out}`)
