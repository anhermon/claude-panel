// Kit routes (/<token>/kit/...), the importmap + panel.css + panel.js injection into scene documents, and the CSP over HTTP.
// Everything runs against a FIXTURE kit in a temp dir (--kit), never against web/kit.
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { wrapEntry } from './scene-doc.mjs';
import { KIT_FILE_TYPES, HOUSE_IMPORTS, DEFAULT_PREFIXES } from './scene-kit.mjs';
import { startServer, makeKitFixture, importMapOf, importMapCount, TEST_TOKEN, HERE, KIT_MANIFEST, KIT_FIXTURE_FILES } from './testkit.mjs';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'panel-kit-')));
const kitDir = join(root, 'kit');
const outside = join(root, 'outside');
const stateFile = join(root, 'state.json');
const SECRET = 'TOP-SECRET';
const KIT = `/${TEST_TOKEN}/kit/`;
const procs = [];
let s;

const sceneDir = (name, entry, text) => {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, entry), text);
  return dir;
};
const AUTHOR_MAP = '{"imports":{"d3":"/author/d3.js","mine":"/author/mine.js"},"scopes":{"/s/":{"x":"/y.js"}},"integrity":{"/author/mine.js":"sha384-abc"}}';
const DOCS = {
  frag: ['index.html', '<h1 id="frag">hello</h1>'],
  full: ['index.html', '<!doctype html><html><head><title>t</title></head><body><p>full</p></body></html>'],
  nohead: ['index.html', '<!doctype html><html lang="en"><body><p>no head</p></body></html>'],
  author: ['index.html', `<!doctype html><html><head><meta charset="utf-8"><script type="importmap">${AUTHOR_MAP}</script></head><body><script type="module">import 'mine'</script></body></html>`],
  fragmap: ['index.html', `<script type="importmap">{"imports":{"frag-only":"/f.js"}}</script><script type="module">import 'frag-only'</script>`],
  badmap: ['index.html', '<html><head><script type="importmap">{not json</script></head><body></body></html>'],
  optout: ['index.html', '<html><head><meta name="panel-css" content="off"></head><body></body></html>'],
  optout2: ['index.html', '<html><head><meta content="OFF" name="panel-css"></head><body></body></html>'],
  optfrag: ['index.html', '<meta name="panel-css" content="off"><p>fragment</p>'],
  commented: ['index.html', '<html><head><!-- <meta name="panel-css" content="off"> --></head><body></body></html>'],
  onmeta: ['index.html', '<html><head><meta name="panel-css" content="on"></head><body></body></html>'],
  commentedmap: ['index.html', '<html><head><!-- <script type="importmap">{"imports":{"ghost":"/g.js"}}</script> --></head><body></body></html>'],
  shim: ['index.html', '<html><head><script type="importmap-shim">{"imports":{"s":"/s.js"}}</script></head><body></body></html>'],
};

before(async () => {
  makeKitFixture(kitDir);
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, 'secret.js'), SECRET);
  symlinkSync(join(outside, 'secret.js'), join(kitDir, 'link-out.js'));
  symlinkSync(outside, join(kitDir, 'linkdir'));
  symlinkSync(join(kitDir, 'd3', 'd3.mjs'), join(kitDir, 'link-in.mjs')); // positive control: stays inside the kit
  const scenes = Object.entries(DOCS).map(([id, [entry, text]]) => ({ id, dir: sceneDir(id, entry, text), alt: id, rev: 1 }));
  writeFileSync(stateFile, JSON.stringify({ v: 4, rev: 1, scenes }));
  s = await startServer(stateFile, { procs, extraArgs: ['--kit', kitDir] });
});
after(() => { for (const p of procs) p.kill(); rmSync(root, { recursive: true, force: true }); });

const kit = (path, opts) => s.api(`/kit/${path}`, opts);
const doc = async (id) => (await s.api(`/s/${id}/`)).text;

test('kit files are served with their types and the cross-origin headers; kit responses carry no scene CSP', async () => {
  const want = { 'panel/panel.js': /^text\/javascript/, 'panel/panel.mjs': /^text\/javascript/, 'panel/panel.css': /^text\/css/, 'manifest.json': /^application\/json/,
    'katex/fonts/k.woff2': /^font\/woff2/, 'three/build/three.module.min.js': /^text\/javascript/, 'link-in.mjs': /^text\/javascript/ };
  for (const [p, type] of Object.entries(want)) {
    const r = await kit(p);
    assert.equal(r.status, 200, p);
    assert.match(r.headers['content-type'], type, p);
    assert.equal(r.headers['x-content-type-options'], 'nosniff', p);
    assert.equal(r.headers['access-control-allow-origin'], '*', p);
    assert.equal(r.headers['cross-origin-resource-policy'], 'cross-origin', p);
    assert.equal(r.headers['cache-control'], 'public, max-age=3600', p);
    assert.equal(r.headers['referrer-policy'], 'no-referrer', p);
    assert.equal(r.headers['content-security-policy'], undefined, p);
  }
  assert.equal((await kit('panel/panel.js')).text, KIT_FIXTURE_FILES['panel/panel.js']);
  assert.equal((await kit('panel/panel.js', { method: 'HEAD' })).status, 200);
  assert.equal((await kit('panel/panel.js', { method: 'HEAD' })).body.length, 0);
  const html = await kit('page.html'); // the one document type: sandboxed so it can never run with the panel origin
  assert.equal(html.status, 200);
  assert.equal(html.text, '<p>kit page</p>', 'kit html is not wrapped or injected');
  assert.equal(html.headers['content-security-policy'], 'sandbox allow-scripts');
});

test('kit files support Range (206, Content-Range, 416)', async () => {
  const r = await kit('panel/panel.js', { headers: { range: 'bytes=0-5' } });
  assert.equal(r.status, 206);
  assert.equal(r.headers['content-range'], `bytes 0-5/${KIT_FIXTURE_FILES['panel/panel.js'].length}`);
  assert.equal(r.text, 'window');
  assert.equal(r.headers['access-control-allow-origin'], '*');
  assert.equal((await kit('panel/panel.js', { headers: { range: 'bytes=999-' } })).status, 416);
});

test('kit extension allow-list: exactly html css js mjs json woff2; .txt, .map, no extension and directories are 404', async () => {
  assert.deepEqual(Object.keys(KIT_FILE_TYPES), ['html', 'css', 'js', 'mjs', 'json', 'woff2']);
  for (const p of ['notes.txt', 'three/build/three.module.min.js.map', 'LICENSE', 'panel', 'panel/', 'three/', 'katex/fonts/', 'nope.js', 'panel/missing.css']) {
    assert.equal((await kit(p)).status, 404, p);
  }
  for (const p of ['/kit', '/kit/']) {
    const r = await s.api(p);
    assert.ok([404, 308].includes(r.status), `${p} -> ${r.status}`); // no listing either way
    assert.ok(!r.text.includes('manifest'), p);
  }
});

test('kit path traversal, dotfiles and symlink escapes are all 404 and never leak', async () => {
  const attempts = ['../outside/secret.js', '%2e%2e/outside/secret.js', '..%2foutside%2fsecret.js', '..%5coutside%5csecret.js', 'panel/../../outside/secret.js',
    'panel/%2e%2e/%2e%2e/outside/secret.js', '%252e%252e/outside/secret.js', 'panel/panel.js%00.css', './manifest.json', 'panel/./panel.js', '/etc/passwd',
    'panel/.secret.js', '.secret.js', '%2esecret.js', 'panel/%2Esecret.js', 'link-out.js', 'linkdir/secret.js', 'linkdir', 'linkdir/'];
  for (const a of attempts) {
    const r = await kit(a);
    assert.equal(r.status, 404, a);
    assert.ok(!r.text.includes(SECRET), a);
  }
  for (const p of ['/s/demo/../kit/manifest.json', '/kit/../state', '/kit/%2e%2e/state']) assert.equal((await s.api(p)).status, 404, p);
});

test('kit route: token and method rules are the same as everywhere else', async () => {
  assert.equal((await s.get('/kit/manifest.json')).status, 404, 'no token');
  assert.equal((await s.get('/wrong/kit/manifest.json')).status, 404);
  assert.equal((await s.get(`/${TEST_TOKEN}x/kit/manifest.json`)).status, 404);
  for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS']) assert.equal((await kit('manifest.json', { method })).status, 405, method);
  assert.equal((await kit('manifest.json', { host: 'evil.example' })).status, 421);
});

test('a missing kit dir is a plain 404 for every kit file, and scenes still load', async () => {
  const lonely = await startServer(stateFile, { procs, extraArgs: ['--kit', join(root, 'no-such-kit')] });
  assert.equal((await lonely.api('/kit/manifest.json')).status, 404);
  assert.equal((await lonely.api('/kit/panel/panel.js')).status, 404);
  const entry = await lonely.api('/s/frag/');
  assert.equal(entry.status, 200);
  assert.ok(entry.text.includes('id="frag"'));
  lonely.kill();
});

test('importmap: present in a fragment AND a full document, first thing in <head>, absolute /<token>/kit URLs, house specifiers + prefix', async () => {
  for (const id of ['frag', 'full', 'nohead']) {
    const text = await doc(id);
    assert.equal(importMapCount(text), 1, id);
    assert.ok(text.indexOf('<head') < text.indexOf('<script type="importmap">'), id);
    assert.match(text, /<head[^>]*><script type="importmap">/, `${id}: the map is the first child of <head>`);
    const { imports } = importMapOf(text);
    assert.deepEqual(imports, {
      three: `${KIT}three/build/three.module.min.js`,
      'three/addons/': `${KIT}three/examples/jsm/`,
      d3: `${KIT}d3/d3.mjs`,
      '@observablehq/plot': `${KIT}plot/plot.min.js`,
      plot: `${KIT}plot/plot.min.js`,
      panel: `${KIT}panel/panel.mjs`,
      'panel/deck': `${KIT}panel/deck.js`,
      'panel/components': `${KIT}panel/components.js`,
      'panel/diagrams': `${KIT}diagrams/diagram.js`,
      'panel/ui': `${KIT}ui/index.js`,
      'panel/assets': `${KIT}assets/index.js`,
    }, id);
    assert.ok(text.indexOf('importmap') < text.indexOf('<h1') || id !== 'frag', 'before the fragment content');
    // every mapped URL is served by the kit route
    for (const url of Object.values(imports).filter((u) => !u.endsWith('/'))) assert.equal((await s.get(url)).status, 200, url);
  }
  assert.ok((await doc('frag')).includes('<h1 id="frag">hello</h1>'), 'the fragment text is kept verbatim');
  assert.match(await doc('nohead'), /<html lang="en"><head><script type="importmap">[\s\S]*<\/head><body><p>no head<\/p>/, 'a missing <head> is created');
  assert.equal(importMapOf(await doc('nohead')).imports.three.startsWith('/'), true);
});

test('panel.css link and panel.js script are injected after the map; the inline window.panel fallback follows', async () => {
  for (const id of ['frag', 'full', 'nohead']) {
    const t = await doc(id);
    const iMap = t.indexOf('<script type="importmap">');
    const iCss = t.indexOf(`<link rel="stylesheet" href="${KIT}panel/panel.css">`);
    const iJs = t.indexOf(`<script src="${KIT}panel/panel.js"></script>`);
    const iFallback = t.indexOf('window.panel || (window.panel = { fit: fit })');
    assert.ok(iMap >= 0 && iMap < iCss && iCss < iJs && iJs < iFallback, `${id}: ${[iMap, iCss, iJs, iFallback]}`);
    assert.equal(t.split('panel/panel.js').length, 2, `${id}: panel.js once`);
  }
  assert.match(await doc('frag'), /color-scheme: light dark/, 'a fragment still gets the base style + tokens');
  assert.doesNotMatch(await doc('full'), /color-scheme: light dark/, 'a full document does not');
});

test('<meta name="panel-css" content="off"> drops only the stylesheet link (any attribute order, any case); commented-out or content=on does not', async () => {
  for (const id of ['optout', 'optout2', 'optfrag']) {
    const t = await doc(id);
    assert.ok(!t.includes('panel/panel.css'), id);
    assert.ok(t.includes(`${KIT}panel/panel.js`), `${id}: panel.js stays`);
    assert.equal(importMapCount(t), 1, `${id}: the map stays`);
  }
  for (const id of ['commented', 'onmeta', 'frag', 'full']) assert.ok((await doc(id)).includes(`${KIT}panel/panel.css`), id);
});

test('an author importmap is MERGED into the single map: author keys win, scopes and integrity are kept, kit keys are added', async () => {
  const t = await doc('author');
  assert.equal(importMapCount(t), 1, 'never two maps');
  const map = importMapOf(t);
  assert.equal(map.imports.d3, '/author/d3.js', 'author wins over the kit');
  assert.equal(map.imports.mine, '/author/mine.js');
  assert.equal(map.imports.three, `${KIT}three/build/three.module.min.js`, 'kit keys are added');
  assert.equal(map.imports.panel, `${KIT}panel/panel.mjs`);
  assert.deepEqual(map.scopes, { '/s/': { x: '/y.js' } });
  assert.deepEqual(map.integrity, { '/author/mine.js': 'sha384-abc' });
  assert.ok(t.indexOf('importmap') < t.indexOf('type="module"'), 'the map stays before the module script');
  assert.ok(t.includes(`${KIT}panel/panel.js`), 'panel.js is still injected');
  assert.match(t, /<head><script src=|<head><link rel="stylesheet"/, 'the rest of the kit head goes first in <head>, without a second map');

  const frag = await doc('fragmap'); // an importmap inside a fragment is merged too
  assert.equal(importMapCount(frag), 1);
  const fragMap = importMapOf(frag);
  assert.equal(fragMap.imports['frag-only'], '/f.js');
  assert.equal(fragMap.imports.d3, `${KIT}d3/d3.mjs`);

  const bad = await doc('badmap'); // unparsable author map: replaced, still one map
  assert.equal(importMapCount(bad), 1);
  assert.equal(importMapOf(bad).imports.three, `${KIT}three/build/three.module.min.js`);
});

test('importmap lookalikes do not count: commented-out maps and importmap-shim are ignored', async () => {
  const commented = await doc('commentedmap');
  assert.equal(importMapCount(commented.replace(/<!--[\s\S]*?-->/g, '')), 1, 'ours is the only live map');
  assert.ok(commented.includes('<!-- <script type="importmap">{"imports":{"ghost":"/g.js"}}</script> -->'), 'the comment is untouched');
  const shim = await doc('shim');
  assert.equal(importMapCount(shim.replace(/<script type="importmap-shim">[\s\S]*?<\/script>/, '')), 1);
  assert.ok(shim.includes('<script type="importmap-shim">{"imports":{"s":"/s.js"}}</script>'));
});

test('manifest missing or invalid: only the house specifiers, ONE warning on stderr, the server stays up', async () => {
  const house = Object.fromEntries(Object.entries(HOUSE_IMPORTS).map(([k, v]) => [k, `${KIT}${v}`]));
  for (const [label, manifest] of [['missing', null], ['not json', '{nope'], ['not an object', '[1,2]'], ['libs not an array', '{"version":1,"libs":{}}']]) {
    const dir = makeKitFixture(join(root, `kit-${label.replace(/\W/g, '')}`), { manifest });
    const srv = await startServer(stateFile, { procs, extraArgs: ['--kit', dir] });
    for (let i = 0; i < 3; i++) assert.deepEqual(importMapOf((await srv.api('/s/frag/')).text).imports, house, label);
    const warnings = srv.stderr().split('\n').filter((l) => /manifest/.test(l));
    assert.equal(warnings.length, 1, `${label}: exactly one warning, got ${JSON.stringify(warnings)}`);
    assert.equal((await srv.api('/state')).status, 200);
    srv.kill();
  }
});

test('manifest entries are sanitised: unsafe relpaths dropped, house specifiers cannot be overridden, prefix fallback and override', async () => {
  const manifest = { version: 1, libs: [
    { id: 'evil', imports: { up: '../outside/secret.js', abs: '/etc/passwd', dot: 'a/.hidden/x.js', back: 'a\\b.js', empty: '', num: 5, panel: 'evil/panel.js', 'panel/deck': 'evil/deck.js', 'sp ace': 'a b/c d.js', ok: 'ok/ok.js' } },
    'junk', null,
  ] };
  const dir = makeKitFixture(join(root, 'kit-sanitise'), { manifest });
  const srv = await startServer(stateFile, { procs, extraArgs: ['--kit', dir] });
  const { imports } = importMapOf((await srv.api('/s/frag/')).text);
  assert.deepEqual(Object.keys(imports).sort(), ['ok', 'panel', 'panel/components', 'panel/deck', 'panel/diagrams', 'panel/ui', 'panel/assets', 'sp ace', 'three/addons/'].sort());
  assert.equal(imports.panel, `${KIT}${HOUSE_IMPORTS.panel}`);
  assert.equal(imports['panel/deck'], `${KIT}${HOUSE_IMPORTS['panel/deck']}`);
  assert.equal(imports['sp ace'], `${KIT}a%20b/c%20d.js`, 'segments are URL-encoded');
  assert.equal(imports['three/addons/'], `${KIT}${DEFAULT_PREFIXES['three/addons/']}`, 'no lib declares the prefix: the built-in fallback applies');
  srv.kill();

  const declared = { version: 1, libs: [{ id: 'three', imports: { three: 'three/build/three.module.min.js' }, prefixes: { 'three/addons/': 'three/jsm-elsewhere/', 'bad/': 'no-trailing-slash', 'worse': 'x/' } }] };
  const srv2 = await startServer(stateFile, { procs, extraArgs: ['--kit', makeKitFixture(join(root, 'kit-prefix'), { manifest: declared })] });
  const map2 = importMapOf((await srv2.api('/s/frag/')).text).imports;
  assert.equal(map2['three/addons/'], `${KIT}three/jsm-elsewhere/`, 'the manifest prefix wins over the built-in one');
  assert.ok(!('bad/' in map2) && !('worse' in map2), 'a prefix needs a trailing slash on both sides');
  srv2.kill();
});

test('the manifest is re-read on every document: a kit vendored while the server runs is picked up', async () => {
  const dir = makeKitFixture(join(root, 'kit-live'), { manifest: null });
  const srv = await startServer(stateFile, { procs, extraArgs: ['--kit', dir] });
  assert.equal(importMapOf((await srv.api('/s/frag/')).text).imports.d3, undefined);
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(KIT_MANIFEST));
  assert.equal(importMapOf((await srv.api('/s/frag/')).text).imports.d3, `${KIT}d3/d3.mjs`);
  srv.kill();
});

test('wrapEntry with a kit: `<` in map values cannot close the script element; no kit = fallback only', () => {
  const out = wrapEntry('<p>x</p>', { url: '/t/kit/', imports: { 'a</script><b>': '/x' } });
  assert.ok(!out.includes('a</script><b>'));
  assert.ok(out.includes('a\\u003c/script>'));
  assert.equal(importMapOf(out).imports['a</script><b>'], '/x', 'round-trips through JSON.parse');
  const bare = wrapEntry('<p>x</p>');
  assert.ok(!bare.includes('importmap') && !bare.includes('/kit/'));
  assert.ok(bare.includes('window.panel || (window.panel = { fit: fit })'));
});

test('over HTTP the scene CSP names the real origin for scripts, styles and fonts so the kit URLs load', async () => {
  const csp = (await s.api('/s/frag/')).headers['content-security-policy'];
  for (const directive of ['script-src', 'style-src', 'font-src', 'img-src', 'media-src', 'connect-src', 'worker-src']) {
    assert.match(csp, new RegExp(`${directive} [^;]*${s.origin.replace(/[.]/g, '\\.')}`), directive);
  }
  assert.ok(csp.endsWith('sandbox allow-scripts'));
});

test('against the real web/kit (when vendored): the map has the manifest imports and each URL is served', { skip: !existsSync(join(HERE, 'kit', 'manifest.json')) }, async () => {
  const real = await startServer(stateFile, { procs });
  const { imports } = importMapOf((await real.api('/s/frag/')).text);
  assert.ok(imports.three && imports.d3, JSON.stringify(Object.keys(imports)));
  for (const [spec, url] of Object.entries(imports)) {
    if (spec.startsWith('panel') || url.endsWith('/')) continue; // house files are written by another task
    assert.equal((await real.get(url)).status, 200, url);
  }
  real.kill();
});
