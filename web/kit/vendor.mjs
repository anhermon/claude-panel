#!/usr/bin/env node
// Vendors the offline library kit for panel v4 (zero deps, Node 22, global fetch).
//   node vendor.mjs          download every pinned file from jsdelivr, rewrite kit/<id>/**, kit/manifest.json, kit/LICENSES.md
//   node vendor.mjs --only=<id>  re-vendor ONE lib: its manifest entry and LICENSES.md section are replaced, every other entry is kept as is.
//   node vendor.mjs --check  re-hash every file against manifest.json; also checks bare imports resolve. Exit 1 on any problem.
// Run by a human/agent when re-vendoring only; the panel never touches the network at runtime.
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, posix, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const KIT = dirname(fileURLToPath(import.meta.url));
const CDN = 'https://cdn.jsdelivr.net/npm/';
const MANIFEST = join(KIT, 'manifest.json');
const GZIP_LEVEL = 9;
const FETCH_RETRIES = 3;
const HOUSE_DIRS = ['panel', 'diagrams', 'ui']; // house code (T17 panel/, T44 diagrams/, T43 ui/), never touched here
const NON_LIB_FILES = new Set(['manifest.json', 'LICENSES.md', 'vendor.mjs']);
const ADDON_ROOTS = ['controls/OrbitControls.js', 'loaders/GLTFLoader.js', 'utils/BufferGeometryUtils.js'];
const STMT_RE = /^(?:import|export)\b[^;'"]*?\bfrom\s*(["'])([^"']+)\1|^import\s*(["'])([^"']+)\3/gm; // line-anchored (unminified sources)
const SPEC_RE = /(?:\bfrom|\bimport)\s*(["'])([^"'\s,()`;]+)\1/g;

// Each lib: pkg@version fetched from jsdelivr. `get` = [fromPath, toPath] (path under the package -> path under kit/<id>/).
const LIBS = [
  { id: 'three', pkg: 'three', version: '0.187.0', license: 'MIT', licenseFile: 'LICENSE',
    // jsdelivr auto-minifies the official ESM build; the module build imports ./three.core.js so the core min is stored under that name.
    get: [['build/three.module.min.js', 'build/three.module.min.js'], ['build/three.core.min.js', 'build/three.core.js']],
    addons: ADDON_ROOTS,
    imports: { three: 'build/three.module.min.js' }, prefixes: { 'three/addons/': 'examples/jsm/' } },
  { id: 'd3', pkg: 'd3', version: '7.9.2', license: 'ISC', licenseFile: 'LICENSE',
    // official d3.min.mjs imports ~30 bare d3-* packages (not bundled), so the bundled UMD is wrapped into an ES module.
    umd: { from: 'dist/d3.min.js', to: 'd3.mjs' }, imports: { d3: 'd3.mjs' } },
  { id: 'plot', pkg: '@observablehq/plot', version: '0.6.18', license: 'ISC', licenseFile: 'LICENSE',
    get: [['dist/plot.min.js', 'plot.min.js']], imports: { '@observablehq/plot': 'plot.min.js', plot: 'plot.min.js' } },
  { id: 'chart.js', pkg: 'chart.js', version: '4.6.1', license: 'MIT', licenseFile: 'LICENSE.md',
    get: [['dist/chart.js', 'dist/chart.js'], ['dist/chunks/index.js', 'dist/chunks/index.js'], ['auto/auto.js', 'auto/auto.js']],
    imports: { 'chart.js': 'dist/chart.js', 'chart.js/auto': 'auto/auto.js' } },
  { id: 'kurkle-color', pkg: '@kurkle/color', version: '0.3.4', license: 'MIT', licenseFile: 'LICENSE.md',
    get: [['dist/color.esm.js', 'color.esm.js']], imports: { '@kurkle/color': 'color.esm.js' } },
  { id: 'roughjs', pkg: 'roughjs', version: '4.6.6', license: 'MIT', licenseFile: 'LICENSE',
    get: [['bundled/rough.esm.js', 'rough.esm.js']], imports: { roughjs: 'rough.esm.js', rough: 'rough.esm.js' } },
  { id: 'matter-js', pkg: 'matter-js', version: '0.20.0', license: 'MIT', licenseFile: 'LICENSE',
    umd: { from: 'build/matter.min.js', to: 'matter.mjs' }, imports: { 'matter-js': 'matter.mjs' } },
  { id: 'katex', pkg: 'katex', version: '0.19.1', license: 'MIT', licenseFile: 'LICENSE',
    get: [['dist/katex.min.mjs', 'katex.min.mjs']], katexCss: true, css: ['katex.min.css'], imports: { katex: 'katex.min.mjs' } },
  { id: 'highlight.js', pkg: '@highlightjs/cdn-assets', version: '11.11.1', license: 'BSD-3-Clause', licenseFile: 'LICENSE',
    // es/highlight.min.js = core + the "common" language set (includes js ts python bash json xml/html css sql diff).
    get: [['es/highlight.min.js', 'highlight.min.js'], ['styles/github-dark.min.css', 'styles/github-dark.min.css'], ['styles/github.min.css', 'styles/github.min.css']],
    css: ['styles/github-dark.min.css', 'styles/github.min.css'], imports: { 'highlight.js': 'highlight.min.js' } },
  { id: 'mermaid', pkg: 'mermaid', version: '11.17.2', license: 'MIT', licenseFile: 'LICENSE',
    // dist/mermaid.min.js is ONE self-contained IIFE (every diagram type, no lazy chunks; the ESM build fetches ~100 chunk files) that sets globalThis.mermaid.
    iife: { from: 'dist/mermaid.min.js', to: 'mermaid.mjs', ns: '__esbuild_esm_mermaid_nm' }, imports: { mermaid: 'mermaid.mjs' } },
  { id: 'marked', pkg: 'marked', version: '18.1.3', license: 'MIT', licenseFile: 'LICENSE',
    get: [['lib/marked.esm.js', 'marked.esm.js']], imports: { marked: 'marked.esm.js' } },
];

const sha = (b) => createHash('sha256').update(b).digest('hex');
const gz = (b) => gzipSync(b, { level: GZIP_LEVEL }).length;

async function fetchBuf(url) {
  let err;
  for (let i = 0; i < FETCH_RETRIES; i++) {
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`${r.status} ${url}`);
      return Buffer.from(await r.arrayBuffer());
    } catch (e) { err = e; }
  }
  throw err;
}

// Wrap a UMD bundle into an ES module with a default export and one named export per property.
function wrapUmd(src, label) {
  const m = { exports: {} };
  new Function('module', 'exports', src).call(globalThis, m, m.exports);
  const names = Object.keys(m.exports).filter((k) => k !== 'default' && /^[A-Za-z_$][\w$]*$/.test(k)).sort();
  if (!names.length) throw new Error(`${label}: no exports found`);
  return `/* ES-module wrapper generated by vendor.mjs around the unmodified UMD bundle below. */\n` +
    `const exports={},module={exports};\n${src}\n;export default module.exports;\nconst $$=module.exports;\n` +
    `${names.map((n, i) => `const _${i}=$$.${n};`).join('')}\nexport {${names.map((n, i) => `_${i} as ${n}`).join(',')}};\n`; // aliased: a bare `const window` would shadow the global (d3 exports `window`)
}

// Wrap a self-contained esbuild global-name bundle (`var NS; (NS||={}).x = ...; globalThis.x = NS.x.default`) into an ES module: the
// unmodified bundle runs in a function whose `globalThis` is a shim inheriting from the real one, so `globalThis.mermaid = ...`
// becomes the default export and no real global is touched. Its `var NS;` is hoisted out to the module so the shim can see NS too.
function wrapIife(src, ns) {
  const decl = `var ${ns};`;
  if (!src.includes(decl)) throw new Error(`iife: "${decl}" not found, the bundle format changed`);
  return `/* ES-module wrapper generated by vendor.mjs around the IIFE bundle below (only its top-level \`var ${ns};\` moved out). */\n` +
    `const shim=Object.create(globalThis);\nlet ${ns}=shim.${ns}={};\n(function(globalThis){\n${src.replace(decl, '')}\n}).call(shim,shim);\nexport default shim.mermaid;\n`;
}

// Resolve the relative import closure of the three addons (non-minified originals; paths kept so relative imports work).
async function addonClosure(base, roots) {
  const out = new Map();
  const queue = roots.map((r) => posix.join('examples/jsm', r));
  while (queue.length) {
    const p = queue.shift();
    if (out.has(p)) continue;
    const buf = await fetchBuf(`${base}/${p}`);
    out.set(p, buf);
    for (const m of buf.toString().matchAll(STMT_RE)) {
      const spec = m[2] ?? m[4];
      if (spec.startsWith('.')) queue.push(posix.join(posix.dirname(p), spec));
      else if (spec.startsWith('three/addons/')) queue.push(posix.join('examples/jsm', spec.slice('three/addons/'.length)));
      else if (spec !== 'three' ) throw new Error(`unresolved bare import "${spec}" in ${p}`);
    }
  }
  return out;
}

async function buildLib(lib) {
  const base = `${CDN}${lib.pkg}@${lib.version}`;
  const files = new Map(); // relpath under kit/<id>/ -> Buffer
  for (const [from, to] of lib.get ?? []) files.set(to, await fetchBuf(`${base}/${from}`));
  if (lib.umd) files.set(lib.umd.to, Buffer.from(wrapUmd((await fetchBuf(`${base}/${lib.umd.from}`)).toString(), lib.id)));
  if (lib.iife) files.set(lib.iife.to, Buffer.from(wrapIife((await fetchBuf(`${base}/${lib.iife.from}`)).toString(), lib.iife.ns)));
  if (lib.addons) for (const [p, b] of await addonClosure(base, lib.addons)) files.set(p, b);
  if (lib.katexCss) {
    let css = (await fetchBuf(`${base}/dist/katex.min.css`)).toString();
    css = css.replace(/,url\([^)]*\.woff\) format\("woff"\)/g, '').replace(/,url\([^)]*\.ttf\) format\("truetype"\)/g, '');
    files.set('katex.min.css', Buffer.from(css));
    for (const [, f] of css.matchAll(/url\((fonts\/[^)]+\.woff2)\)/g)) files.set(f, await fetchBuf(`${base}/dist/${f}`));
  }
  files.set('LICENSE', await fetchBuf(`${base}/${lib.licenseFile}`));
  return { files, source: `${base}/` };
}

const copyrightLine = (txt) => txt.split('\n').map((l) => l.trim()).find((l) => /copyright/i.test(l)) ?? '(no copyright line in LICENSE file)';

function entry(lib, files, source) {
  const rel = [...files.keys()].sort();
  return {
    id: lib.id, version: lib.version, license: lib.license, source,
    files: Object.fromEntries(rel.map((r) => [`${lib.id}/${r}`, sha(files.get(r))])),
    imports: Object.fromEntries(Object.entries(lib.imports).map(([k, v]) => [k, `${lib.id}/${v}`])),
    prefixes: Object.fromEntries(Object.entries(lib.prefixes ?? {}).map(([k, v]) => [k, `${lib.id}/${v}`])),
    css: (lib.css ?? []).map((c) => `${lib.id}/${c}`),
    gzipBytes: rel.reduce((n, r) => n + gz(files.get(r)), 0),
  };
}

const ONLY = process.argv.find((a) => a.startsWith('--only='))?.slice('--only='.length);
const LICENSES = join(KIT, 'LICENSES.md');

async function vendor() {
  const libs = [];
  const notes = [];
  for (const lib of LIBS.filter((l) => !ONLY || l.id === ONLY)) {
    process.stderr.write(`vendoring ${lib.id}@${lib.version}\n`);
    const { files, source } = await buildLib(lib);
    rmSync(join(KIT, lib.id), { recursive: true, force: true });
    for (const [r, b] of files) {
      const dest = join(KIT, lib.id, r);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, b);
    }
    libs.push(entry(lib, files, source));
    notes.push(`## ${lib.pkg} ${lib.version}\n- License: ${lib.license}\n- ${copyrightLine(files.get('LICENSE').toString())}\n- Source: ${source}\n- Full text: \`${lib.id}/LICENSE\`\n`);
  }
  if (ONLY) { // keep every other lib exactly as it is; the re-vendored one replaces its own entry (or is appended)
    if (!libs.length) throw new Error(`--only=${ONLY}: no such lib`);
    const kept = JSON.parse(readFileSync(MANIFEST, 'utf8')).libs;
    const at = kept.findIndex((l) => l.id === ONLY);
    if (at < 0) kept.push(libs[0]); else kept[at] = libs[0];
    const sections = readFileSync(LICENSES, 'utf8').split('\n## ');
    const mine = notes[0].replace(/^## /, '');
    const idx = sections.findIndex((x) => x.includes(`Full text: \`${ONLY}/LICENSE\``));
    if (idx < 0) sections.push(mine.trimEnd() + '\n'); else sections[idx] = mine.trimEnd() + '\n';
    writeFileSync(MANIFEST, JSON.stringify({ version: 1, libs: kept }, null, 2) + '\n');
    writeFileSync(LICENSES, sections.join('\n## '));
    process.stderr.write('done\n');
    return;
  }
  writeFileSync(MANIFEST, JSON.stringify({ version: 1, libs }, null, 2) + '\n');
  writeFileSync(LICENSES, `# Third-party licenses (generated by vendor.mjs)\n\nKaTeX fonts (KaTeX_*.woff2) are distributed under the SIL OFL 1.1 / MIT by the KaTeX project.\n\n${notes.join('\n')}`);
  process.stderr.write('done\n');
}

function listFiles(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? listFiles(p) : [p];
  });
}

function check() {
  const m = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  const bad = [];
  const known = new Set();
  const specs = { ...Object.assign({}, ...m.libs.map((l) => l.imports)) };
  const prefixes = Object.assign({}, ...m.libs.map((l) => l.prefixes));
  for (const lib of m.libs) {
    for (const [rel, want] of Object.entries(lib.files)) {
      known.add(rel);
      const p = join(KIT, rel);
      if (!existsSync(p)) { bad.push(`missing ${rel}`); continue; }
      const got = sha(readFileSync(p));
      if (got !== want) bad.push(`hash mismatch ${rel}`);
    }
    for (const t of [...Object.values(lib.imports), ...Object.values(lib.prefixes), ...lib.css]) {
      if (!existsSync(join(KIT, t))) bad.push(`${lib.id}: import/css target missing ${t}`);
    }
  }
  for (const f of listFiles(KIT)) {
    const rel = relative(KIT, f).split('\\').join('/');
    if (HOUSE_DIRS.some((d) => rel.startsWith(`${d}/`)) || NON_LIB_FILES.has(rel) || rel.startsWith('.')) continue;
    if (!known.has(rel)) bad.push(`unlisted file ${rel}`);
  }
  // every bare specifier of every ES module must be mapped by the importmap (or be a prefix match)
  for (const rel of known) {
    if (!/\.(m?js)$/.test(rel)) continue;
    const text = readFileSync(join(KIT, rel), 'utf8');
    const minified = /\.min\.|^(d3|matter-js)\//.test(rel); // minified code has no line-anchored imports
    const specList = minified ? [...text.matchAll(SPEC_RE)].map((m) => m[2]) : [...text.matchAll(STMT_RE)].map((m) => m[2] ?? m[4]);
    for (const spec of specList) {
      if (spec.startsWith('.') || spec.startsWith('/') || /^(https?:|data:|blob:)/.test(spec)) continue;
      if (!/^(@[\w.-]+\/)?[\w.-]+(\/[\w./-]+)?$/.test(spec)) continue; // not a plausible specifier (string noise in minified code)
      if (!(spec in specs) && !Object.keys(prefixes).some((p) => spec.startsWith(p))) bad.push(`unmapped bare import "${spec}" in ${rel}`);
    }
  }
  if (bad.length) { console.error(bad.join('\n')); console.error(`FAIL: ${bad.length} problem(s)`); process.exit(1); }
  console.log(`OK: ${known.size} files across ${m.libs.length} libs match manifest.json`);
}

if (process.argv.includes('--check')) check(); else await vendor();
