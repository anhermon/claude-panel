// Pure-function tests: wrapping, ranges, CSP string, path-segment rules, the scene registry and its mtime scan.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, utimesSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { wrapEntry, isFullDocument, MAX_FIT_HEIGHT, FIT_MESSAGE_TYPE } from './scene-doc.mjs';
import { parseRange, sceneCsp, buildSceneCsp, ALLOW_CDN, decodeSegments, isWithin } from './scene-files.mjs';
import { createSceneRegistry, scanMtime, LIVE_DATA_DIR, MAX_SCAN_ENTRIES, MAX_SCAN_DEPTH, MTIME_SCAN_INTERVAL_MS } from './scene-registry.mjs';

test('wrapEntry: a fragment gets doctype, base stylesheet, theme tokens, helper; the fragment text is kept verbatim', () => {
  const frag = '<h3>hi</h3><script>x = "$&"</script>';
  const out = wrapEntry(frag);
  assert.match(out, /^<!doctype html><html><head><script>/, 'no kit given: only the window.panel fallback is injected, first in <head>');
  assert.match(out, /<meta charset="utf-8">/);
  assert.match(out, /color-scheme: light dark/);
  assert.match(out, /@media \(prefers-color-scheme: dark\)/);
  assert.match(out, /--accent:/);
  assert.match(out, /background: transparent/);
  assert.match(out, /system-ui/);
  assert.match(out, /window\.panel = \{ fit: fit \}/);
  assert.ok(out.includes(`<body>${frag}</body>`), '$& and friends are not interpreted');
  assert.ok(out.indexOf('window.panel') < out.indexOf(frag));
});

test('wrapEntry: a full document is not restyled; the fallback goes first in <head>, which is created when missing', () => {
  const doc = '<!DOCTYPE html><HTML><body><p>a</p><!-- </body> --><p>b</p></BODY></HTML>';
  const out = wrapEntry(doc);
  assert.ok(isFullDocument(doc));
  assert.doesNotMatch(out, /color-scheme: light dark/);
  assert.equal(out.indexOf('<script>'), out.lastIndexOf('<script>'));
  assert.ok(out.startsWith('<!DOCTYPE html><HTML><head><script>'), out);
  assert.ok(out.indexOf('</head>') < out.indexOf('<body>'));
  assert.ok(out.endsWith('<body><p>a</p><!-- </body> --><p>b</p></BODY></HTML>'));
  assert.match(wrapEntry('<html><p>no head</p></html>'), /^<html><head><script>[\s\S]*<\/script><\/head><p>no head<\/p><\/html>$/);
  const withHead = wrapEntry('<html lang="en"><head data-x="1"><title>t</title></head><body></body></html>');
  assert.match(withHead, /^<html lang="en"><head data-x="1"><script>[\s\S]*<\/script><title>t<\/title><\/head>/);
  assert.equal(wrapEntry('<html><header>h</header></html>').includes('<header><script>'), false, '<header> is not <head>');
  assert.ok(!isFullDocument('<div>an <htmlish> thing</div>'), '<htmlish> is not an <html> tag');
  assert.ok(!isFullDocument('<p>no html tag, mentions html in text</p>'));
});

test('helper script: defines panel.fit, posts the documented message, clamps at 1200', () => {
  const out = wrapEntry('<p>x</p>');
  assert.match(out, new RegExp(`type: '${FIT_MESSAGE_TYPE}'`));
  assert.match(out, new RegExp(`var MAX = ${MAX_FIT_HEIGHT}`));
  assert.equal(MAX_FIT_HEIGHT, 1200);
  const script = /<script>([\s\S]*)<\/script>/.exec(out)[1];
  const posted = [];
  const fakeBody = { lastElementChild: null };
  const sandbox = {
    window: {}, parent: { postMessage: (m, target) => posted.push([m, target]) },
    document: { body: fakeBody, createRange: () => ({ selectNodeContents() {}, getBoundingClientRect: () => ({ bottom: 5000 }) }) },
    getComputedStyle: () => ({ paddingBottom: '12px', marginBottom: '0px' }), isFinite, parseFloat, Math,
  };
  new Function(...Object.keys(sandbox), script)(...Object.values(sandbox));
  assert.equal(typeof sandbox.window.panel.fit, 'function');
  sandbox.window.panel.fit();
  assert.deepEqual(posted, [[{ type: 'panel-fit', height: 1200 }, '*']]);
});

const V4_CSP = (o) => `default-src 'none'; script-src 'unsafe-inline' blob: ${o}; style-src 'unsafe-inline' ${o}; font-src data: ${o}; img-src ${o} data: blob:; ` +
  `media-src ${o} data: blob:; connect-src ${o} blob: data:; worker-src blob: ${o}; frame-src 'none'; form-action 'none'; base-uri 'self'; sandbox allow-scripts`;

test('sceneCsp: exactly the v4 spec string (ALLOW_CDN is off; the v3 CDN string is still what the flag-on builder yields) with the real origin substituted', () => {
  const o = 'http://127.0.0.1:4717';
  const v3 = `default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob: ${o} https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://unpkg.com; ` +
    `style-src 'unsafe-inline' ${o} https://fonts.googleapis.com https://cdnjs.cloudflare.com https://cdn.jsdelivr.net; ` +
    `font-src data: ${o} https://fonts.gstatic.com https://cdnjs.cloudflare.com https://cdn.jsdelivr.net; img-src ${o} data: blob:; media-src ${o} data: blob:; ` +
    `connect-src ${o} blob: data: https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://unpkg.com; worker-src blob: ${o}; frame-src 'none'; ` +
    `form-action 'none'; base-uri 'self'; sandbox allow-scripts`;
  assert.equal(ALLOW_CDN, false, 'shipped state: the skill and recipes use the local kit, so no CDN host and no unsafe-eval');
  assert.equal(sceneCsp(o), V4_CSP(o));
  assert.equal(buildSceneCsp(o, true), v3);
  assert.equal(buildSceneCsp(o, false), V4_CSP(o));
});

test('sceneCsp: the ALLOW_CDN flag decides CDN hosts and unsafe-eval; the v4 string has neither', () => {
  const o = 'http://127.0.0.1:4717';
  const v4 = V4_CSP(o);
  assert.equal(buildSceneCsp(o, false), v4);
  const open = buildSceneCsp(o, true);
  assert.match(open, /script-src 'unsafe-inline' 'unsafe-eval' blob: http:\/\/127\.0\.0\.1:4717 https:\/\/cdnjs\.cloudflare\.com https:\/\/cdn\.jsdelivr\.net https:\/\/unpkg\.com;/);
  for (const csp of [v4, open]) {
    assert.match(csp, /script-src [^;]*blob: http:\/\/127\.0\.0\.1:4717/, 'the explicit origin is in script-src');
    assert.doesNotMatch(csp, /'self'[^;]*(script|img|connect|style|font|media)-src/);
    assert.ok(csp.endsWith('sandbox allow-scripts'));
  }
  assert.doesNotMatch(v4, /unsafe-eval|https:\/\/(?!127)/);
  assert.equal(sceneCsp(o), buildSceneCsp(o, ALLOW_CDN), 'sceneCsp follows the constant');
  assert.doesNotMatch(sceneCsp(o), /unsafe-eval|https:\/\/(?!127)/, 'the shipped CSP names no CDN and allows no eval');
});

test('parseRange', () => {
  assert.deepEqual(parseRange('bytes=0-9', 100), { start: 0, end: 9 });
  assert.deepEqual(parseRange('bytes=90-', 100), { start: 90, end: 99 });
  assert.deepEqual(parseRange('bytes=90-500', 100), { start: 90, end: 99 });
  assert.deepEqual(parseRange('bytes=-10', 100), { start: 90, end: 99 });
  assert.deepEqual(parseRange('bytes=-500', 100), { start: 0, end: 99 });
  for (const bad of ['bytes=100-', 'bytes=-0']) assert.equal(parseRange(bad, 100), 'unsatisfiable', bad);
  assert.equal(parseRange('bytes=0-0', 0), 'unsatisfiable');
  for (const ignored of [undefined, '', 'bytes=', 'bytes=-', 'bytes=1-2,4-5', 'bytes=5-1', 'foo=1-2', 'bytes=a-b']) assert.equal(parseRange(ignored, 100), null, String(ignored));
});

test('decodeSegments / isWithin', () => {
  assert.deepEqual(decodeSegments(['a', 'b%20c', 'd.png']), ['a', 'b c', 'd.png']);
  for (const bad of ['..', '.', '.env', '%2e%2e', '%2Eenv', 'a%2fb', 'a%5cb', 'a\\b', '%00', 'a%00', '%zz', '%E0%A4%A']) assert.equal(decodeSegments(['ok', bad]), null, bad);
  assert.equal(isWithin('/a/b', '/a/b/c'), true);
  assert.equal(isWithin('/a/b', '/a/b'), false);
  assert.equal(isWithin('/a/b', '/a/b', true), true);
  assert.equal(isWithin('/a/b', '/a/bc'), false);
  assert.equal(isWithin('/a/b', '/a'), false);
  assert.equal(isWithin('/a/b', '/a/b/../x'), false);
});

const tmp = () => mkdtempSync(join(tmpdir(), 'panel-units-'));

test('scanMtime: the top-level live/ data folder never counts, a nested one does', () => {
  const root = tmp();
  try {
    const old = new Date(1_700_000_000_000);
    const later = new Date(1_800_000_000_000);
    mkdirSync(join(root, LIVE_DATA_DIR));
    mkdirSync(join(root, 'sub', LIVE_DATA_DIR), { recursive: true });
    writeFileSync(join(root, 'index.html'), 'x');
    writeFileSync(join(root, LIVE_DATA_DIR, 'status.json'), '{}');
    for (const p of [LIVE_DATA_DIR + '/status.json', LIVE_DATA_DIR, 'sub/' + LIVE_DATA_DIR, 'sub', 'index.html', '.']) utimesSync(join(root, p), old, old);
    utimesSync(join(root, LIVE_DATA_DIR, 'status.json'), later, later);
    utimesSync(join(root, LIVE_DATA_DIR), later, later);
    assert.equal(scanMtime(root), old.getTime(), 'writing live data does not reload the scene');
    writeFileSync(join(root, 'sub', LIVE_DATA_DIR, 'f'), 'x');
    utimesSync(join(root, 'sub', LIVE_DATA_DIR, 'f'), later, later);
    assert.equal(scanMtime(root), later.getTime(), 'only the top-level folder is exempt');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('scanMtime: newest file or dir mtime; skips dotfiles; does not follow symlinks; honours the entry and depth caps', () => {
  const root = tmp();
  try {
    const old = new Date(1_700_000_000_000);
    const stamp = (p, t) => utimesSync(p, t, t);
    mkdirSync(join(root, 'a', 'b', 'c', 'd', 'e', 'f'), { recursive: true });
    writeFileSync(join(root, 'a', 'x.txt'), 'x');
    for (const p of ['a/b/c/d/e/f', 'a/b/c/d/e', 'a/b/c/d', 'a/b/c', 'a/b', 'a', 'a/x.txt', '.']) stamp(join(root, p), old);
    assert.equal(scanMtime(root), old.getTime());

    const later = new Date(1_800_000_000_000);
    stamp(join(root, 'a', 'x.txt'), later);
    assert.equal(scanMtime(root), later.getTime(), 'file mtime counts');
    stamp(join(root, 'a', 'x.txt'), old);

    writeFileSync(join(root, '.dot'), '.'); stamp(join(root, '.dot'), later);
    mkdirSync(join(root, '.dir')); writeFileSync(join(root, '.dir', 'f'), '.'); stamp(join(root, '.dir', 'f'), later);
    stamp(root, old); // creating entries moved the root dir's own mtime
    assert.equal(scanMtime(root), old.getTime(), 'dotfiles and dot dirs are skipped');

    const outside = tmp();
    writeFileSync(join(outside, 'far.txt'), 'x'); stamp(join(outside, 'far.txt'), later);
    symlinkSync(outside, join(root, 'link'));
    stamp(join(root, 'a', 'x.txt'), old);
    try { assert.ok(scanMtime(root) < later.getTime(), 'symlinked dir contents are not scanned'); } finally { rmSync(outside, { recursive: true, force: true }); }
    rmSync(join(root, 'link'));

    // depth cap: entries up to 4 levels below the root are seen (a=1, b=2, c=3, d=4); the children of d are level 5.
    assert.equal(MAX_SCAN_DEPTH, 4);
    writeFileSync(join(root, 'a', 'b', 'c', 'd', 'deep.txt'), 'x'); stamp(join(root, 'a', 'b', 'c', 'd', 'deep.txt'), later);
    assert.ok(scanMtime(root) < later.getTime(), 'level 5 is ignored');
    writeFileSync(join(root, 'a', 'b', 'c', 'near.txt'), 'x'); stamp(join(root, 'a', 'b', 'c', 'near.txt'), later);
    assert.equal(scanMtime(root), later.getTime(), 'level 4 is seen');

    assert.equal(scanMtime(join(root, 'missing')), 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('scanMtime: stops after MAX_SCAN_ENTRIES entries', () => {
  const root = tmp();
  try {
    const old = new Date(1_700_000_000_000);
    const later = new Date(1_800_000_000_000);
    assert.equal(MAX_SCAN_ENTRIES, 200);
    for (let i = 0; i < MAX_SCAN_ENTRIES + 50; i++) writeFileSync(join(root, `f${String(i).padStart(3, '0')}.txt`), 'x');
    const names = readdirSync(root);
    for (const n of names) utimesSync(join(root, n), old, old);
    utimesSync(root, old, old);
    const unseen = names.slice(MAX_SCAN_ENTRIES);
    for (const n of unseen) utimesSync(join(root, n), later, later);
    assert.equal(scanMtime(root), old.getTime(), 'entries past the cap are not examined');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('registry: whitelist, id filter, relative dirs, fields clamped; dir/entry/term.image never in the public form', () => {
  const root = tmp();
  try {
    mkdirSync(join(root, 'rel'));
    writeFileSync(join(root, 'state.json'), '{}');
    const reg = createSceneRegistry({ stateFile: join(root, 'state.json') });
    const state = {
      v: 3, task: { title: 't' },
      scenes: [
        { id: 'ok', dir: 'rel', entry: 'main.html', title: 'T', alt: 'A', span: 2, height: 99999, pin: true, rev: 4.9, html: '<b>', extra: 1, term: { art: ['x', 5, 'y'], image: '/secret.png' } },
        { id: 'Bad_ID', dir: 'rel', alt: 'x', rev: 1 },
        { id: 'a'.repeat(25), dir: 'rel', alt: 'x', rev: 1 },
        { id: 'no-dir', alt: 'x', rev: 1 },
        { id: 'nul', dir: 'a\0b', alt: 'x', rev: 1 },
        { id: 'ok', dir: 'rel', alt: 'duplicate id', rev: 1 },
        'junk', null, { id: 'min', dir: join(root, 'rel'), span: 7, height: 'tall' },
      ],
    };
    reg.load(state);
    const pub = reg.publicState(state);
    assert.deepEqual(pub.scenes.map((s) => s.id), ['ok', 'min']);
    assert.deepEqual(pub.scenes[0], { id: 'ok', title: 'T', span: 2, height: 1200, pin: true, alt: 'A', term: { art: ['x', 'y'] }, rev: 4, mtime: 0 });
    reg.load({ scenes: [{ id: 'a', dir: 'rel', layout: 'stage' }, { id: 'b', dir: 'rel', layout: 'card' }, { id: 'c', dir: 'rel', layout: 'wide' }, { id: 'd', dir: 'rel', layout: 5 }] });
    assert.deepEqual(reg.publicScenes().map((x) => x.layout), ['stage', 'card', undefined, undefined], 'only the two known layouts pass');
    reg.load(state);
    assert.deepEqual(pub.scenes[1], { id: 'min', alt: '', rev: 0, mtime: 0 });
    assert.equal(pub.task.title, 't');
    assert.equal(reg.get('ok').dir, join(root, 'rel'));
    assert.equal(reg.get('ok').entry, 'main.html');
    assert.equal(reg.get('min').entry, 'index.html');
    assert.equal(reg.get('Bad_ID'), undefined);
    const text = JSON.stringify(pub);
    for (const leak of ['dir', 'entry', 'image', 'secret', 'html', 'extra', root]) assert.ok(!text.includes(leak), leak);
    assert.equal('scenes' in reg.publicState({ v: 1 }), false, 'a state without scenes is passed through untouched');
    reg.load({ scenes: 'nope' });
    assert.deepEqual(reg.publicState({ scenes: 'nope' }).scenes, [], 'a scenes value that is not an array is replaced, never forwarded');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('registry.refresh: scans a new dir at once, then at most once per interval; keeps mtime across state reloads', () => {
  const root = tmp();
  try {
    mkdirSync(join(root, 's'));
    const file = join(root, 's', 'a.txt');
    writeFileSync(file, 'a');
    const t1 = new Date(1_750_000_000_000);
    utimesSync(file, t1, t1);
    utimesSync(join(root, 's'), t1, t1);
    let clock = 10_000;
    const reg = createSceneRegistry({ stateFile: join(root, 'state.json'), now: () => clock });
    const state = { scenes: [{ id: 's', dir: 's', alt: 'a', rev: 1 }] };
    reg.load(state);
    assert.equal(reg.refresh(), true);
    assert.equal(reg.publicScenes()[0].mtime, t1.getTime());

    const t2 = new Date(1_760_000_000_000);
    utimesSync(file, t2, t2);
    clock += MTIME_SCAN_INTERVAL_MS - 1;
    assert.equal(reg.refresh(), false, 'within the interval: no re-stat');
    assert.equal(reg.publicScenes()[0].mtime, t1.getTime());

    reg.load({ scenes: [{ id: 's', dir: 's', alt: 'edited', rev: 2 }] }); // new state, same dir
    assert.equal(reg.publicScenes()[0].mtime, t1.getTime(), 'a state rewrite does not reset the mtime to 0');
    assert.equal(reg.refresh(), false);

    clock += 1;
    assert.equal(reg.refresh(), true, 'interval elapsed: picks up the change');
    assert.equal(reg.publicScenes()[0].mtime, t2.getTime());

    const twin = { scenes: [{ id: 'one', dir: 's', alt: 'a', rev: 1 }, { id: 'two', dir: 's', alt: 'b', rev: 1 }] };
    reg.load(twin);
    reg.refresh();
    assert.deepEqual(reg.publicScenes().map((s) => s.mtime), [t2.getTime(), t2.getTime()], 'two scenes on one dir share its mtime');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
