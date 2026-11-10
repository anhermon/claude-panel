// Browser scripts under a fake DOM (see fake-dom.mjs): block renderers, scene frames, and the page layout.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HERE } from './testkit.mjs';
import { loadBrowserScripts } from './fake-dom.mjs';

const sample = JSON.parse(readFileSync(join(HERE, 'sample-state.json'), 'utf8'));
const BLOCK_KINDS = ['text', 'list', 'table', 'code', 'callout', 'steps', 'kv', 'metrics', 'progress', 'diff', 'tree', 'options', 'timeline', 'sources', 'bars', 'tags', 'quote'];
const FIT_TYPE = 'panel-fit';

test('blocks.js: all 17 renderers are registered and render every block of the sample state', () => {
  const { ctx } = loadBrowserScripts(['blocks.js']);
  const { RENDERERS, renderBlock } = ctx.PanelBlocks;
  assert.deepEqual(Object.keys(RENDERERS).sort(), [...BLOCK_KINDS].sort());
  const seen = new Set();
  for (const card of sample.cards) {
    for (const b of card.blocks) {
      const node = renderBlock(b);
      assert.ok(node, `block ${b.kind} in card ${card.id} rendered`);
      assert.ok(node.className.includes('block-' + b.kind));
      seen.add(b.kind);
    }
  }
  assert.deepEqual([...seen].sort(), [...BLOCK_KINDS].sort(), 'the fixture covers every kind');
  assert.equal(renderBlock({ kind: 'nope' }), null);
  assert.equal(renderBlock({ kind: 'text' }), null);
  assert.equal(renderBlock(null), null);
  const link = renderBlock({ kind: 'sources', items: [{ title: 'x', url: 'javascript:alert(1)' }, { title: 'ok', url: 'https://example.com/a' }] });
  const anchors = link.findAll((n) => n.tagName === 'A');
  assert.equal(anchors.length, 1, 'only http(s) urls become links');
  assert.equal(anchors[0].rel, 'noopener noreferrer');
});

const frameOf = (container, id) => container.find((n) => n.dataset?.sceneId === id);
const iframeOf = (container, id) => frameOf(container, id).find((n) => n.tagName === 'IFRAME');

function sceneEnv() {
  const env = loadBrowserScripts(['blocks.js', 'scenes.js']);
  const container = env.doc.createElement('div');
  return { ...env, container, sync: (scenes) => env.ctx.PanelScenes.sync(container, scenes) };
}
const scene = (over = {}) => ({ id: 'pulse', title: 'Retry timing', span: 1, height: 260, alt: 'Four bars', rev: 1, mtime: 100, ...over });

test('scenes.js: the iframe is sandboxed with allow-scripts only, never srcdoc, with the contracted attributes and a relative src', () => {
  const { sync, container } = sceneEnv();
  assert.equal(sync([scene()]), 1);
  const f = iframeOf(container, 'pulse');
  assert.equal(f.attrs.sandbox, 'allow-scripts');
  assert.ok(!f.attrs.sandbox.includes('allow-same-origin'));
  assert.equal(f.hasAttribute('srcdoc'), false);
  assert.equal(f.attrs.srcdoc, undefined);
  assert.equal(f.attrs.allow, 'autoplay; fullscreen');
  assert.equal(f.attrs.referrerpolicy, 'no-referrer');
  assert.equal(f.attrs.loading, 'lazy');
  assert.equal(f.title, 'Four bars');
  assert.equal(f.src, 's/pulse/?v=1-100');
  assert.equal(frameOf(container, 'pulse').find((n) => n.className.includes('scene-body')).style.height, '260px');
  assert.equal(frameOf(container, 'pulse').className, 'scene span-1');
});

test('scenes.js: header buttons are real <button>/<a> elements with aria-labels; the link opens a new tab with noopener', () => {
  const { sync, container } = sceneEnv();
  sync([scene()]);
  const root = frameOf(container, 'pulse');
  const controls = root.findAll((n) => n.className.includes('icon-btn'));
  assert.deepEqual(controls.map((n) => n.tagName), ['BUTTON', 'A', 'BUTTON']);
  for (const c of controls) assert.ok(c.attrs['aria-label'].length > 3, 'aria-label on ' + c.tagName);
  const link = controls[1];
  assert.equal(link.target, '_blank');
  assert.equal(link.rel, 'noopener');
  assert.equal(link.href, 's/pulse/?v=1-100');
  assert.equal(controls[0].type, 'button');
  assert.equal(root.find((n) => n.tagName === 'H2').textContent, 'Retry timing');
});

test('scenes.js: the iframe src changes ONLY when rev or mtime changes; other state changes keep the same live node', () => {
  const { sync, container } = sceneEnv();
  sync([scene(), scene({ id: 'orbit', title: 'Orbit' })]);
  const a = iframeOf(container, 'pulse');
  const b = iframeOf(container, 'orbit');
  assert.equal(a.srcLog.length, 1);
  // unrelated change: title, alt, span, a third scene appears, an SSE tick with identical data
  sync([scene(), scene({ id: 'orbit', title: 'Orbit' })]);
  sync([scene({ title: 'Renamed', alt: 'New alt', span: 2 }), scene({ id: 'orbit', title: 'Orbit' }), scene({ id: 'third', title: 'Third' })]);
  assert.equal(iframeOf(container, 'pulse'), a, 'same iframe node');
  assert.equal(iframeOf(container, 'orbit'), b);
  assert.equal(a.srcLog.length, 1, 'no navigation');
  assert.equal(b.srcLog.length, 1);
  assert.equal(a.title, 'New alt');
  assert.equal(frameOf(container, 'pulse').find((n) => n.tagName === 'H2').textContent, 'Renamed');
  assert.equal(frameOf(container, 'pulse').className, 'scene span-2');
  assert.equal(a.parentNode.parentNode.parentNode, container);
  // rev bump, then mtime bump: exactly those frames navigate
  sync([scene({ rev: 2 }), scene({ id: 'orbit', title: 'Orbit' }), scene({ id: 'third', title: 'Third' })]);
  assert.deepEqual(a.srcLog, ['s/pulse/?v=1-100', 's/pulse/?v=2-100']);
  assert.equal(b.srcLog.length, 1);
  sync([scene({ rev: 2 }), scene({ id: 'orbit', title: 'Orbit', mtime: 555 }), scene({ id: 'third', title: 'Third' })]);
  assert.equal(a.srcLog.length, 2);
  assert.deepEqual(b.srcLog, ['s/orbit/?v=1-100', 's/orbit/?v=1-555']);
  assert.equal(frameOf(container, 'orbit').find((n) => n.tagName === 'A').href, 's/orbit/?v=1-555');
});

test('scenes.js: order is pinned first; adding or removing a scene does not move (reload) the others; removal drops the node', () => {
  const { sync, container } = sceneEnv();
  sync([scene({ id: 'a' }), scene({ id: 'b' }), scene({ id: 'c', pin: true })]);
  const ids = () => container.children.map((n) => n.dataset.sceneId);
  assert.deepEqual(ids(), ['c', 'a', 'b']);
  const insertCount = (id) => frameOf(container, id).insertLog.length;
  const before = { a: insertCount('a'), b: insertCount('b'), c: insertCount('c') };
  sync([scene({ id: 'a' }), scene({ id: 'new' }), scene({ id: 'b' }), scene({ id: 'c', pin: true })]); // new in the middle
  assert.deepEqual(ids(), ['c', 'a', 'new', 'b']);
  assert.deepEqual({ a: insertCount('a'), b: insertCount('b'), c: insertCount('c') }, before, 'existing frames were not re-inserted');
  sync([scene({ id: 'a' }), scene({ id: 'new' }), scene({ id: 'c', pin: true })]); // b removed
  assert.deepEqual(ids(), ['c', 'a', 'new']);
  assert.equal(frameOf(container, 'b'), null);
  assert.equal(sync([]), 0);
  assert.equal(container.hidden, true);
});

test('scenes.js: hostile or malformed scene records are dropped or clamped, never rendered raw', () => {
  const { sync, container, ctx } = sceneEnv();
  const n = sync([null, 'x', { id: '../evil' }, { id: 'UP' }, { id: 'a/b' }, { id: 'ok', height: 99999, span: 9, alt: 5, title: ['x'], rev: 'z' }, scene({ id: 'ok' })]);
  assert.equal(n, 1);
  const f = iframeOf(container, 'ok');
  assert.equal(f.src, 's/ok/?v=0-0');
  assert.equal(frameOf(container, 'ok').find((x) => x.className.includes('scene-body')).style.height, '1200px');
  assert.equal(ctx.PanelScenes.normScenes([{ id: 'ok', height: 1 }])[0].height, 120);
});

test('scenes.js: panel-fit messages are accepted only from that frame, with a numeric height, clamped 120..1200', () => {
  const { sync, container, messageHandlers } = sceneEnv();
  sync([scene(), scene({ id: 'orbit' })]);
  assert.equal(messageHandlers.length, 1);
  const post = messageHandlers[0];
  const height = (id) => frameOf(container, id).find((n) => n.className.includes('scene-body')).style.height;
  const pulseWin = iframeOf(container, 'pulse').contentWindow;
  const orbitWin = iframeOf(container, 'orbit').contentWindow;

  post({ source: pulseWin, data: { type: FIT_TYPE, height: 333.4 } });
  assert.equal(height('pulse'), '333px');
  assert.equal(height('orbit'), '260px', 'other frames untouched');
  post({ source: pulseWin, data: { type: FIT_TYPE, height: 5 } });
  assert.equal(height('pulse'), '120px');
  post({ source: pulseWin, data: { type: FIT_TYPE, height: 50000 } });
  assert.equal(height('pulse'), '1200px');
  post({ source: orbitWin, data: { type: FIT_TYPE, height: 700 } });
  assert.equal(height('orbit'), '700px');

  const frozen = height('pulse');
  for (const bad of [
    { source: {}, data: { type: FIT_TYPE, height: 200 } }, // not a frame's window
    { source: null, data: { type: FIT_TYPE, height: 200 } },
    { source: pulseWin, data: { type: 'other', height: 200 } },
    { source: pulseWin, data: { type: FIT_TYPE, height: '200' } },
    { source: pulseWin, data: { type: FIT_TYPE, height: NaN } },
    { source: pulseWin, data: { type: FIT_TYPE, height: Infinity } },
    { source: pulseWin, data: { type: FIT_TYPE } },
    { source: pulseWin, data: 'panel-fit' },
    { source: pulseWin, data: null },
    { source: pulseWin, data: [FIT_TYPE, 200] },
  ]) post(bad);
  assert.equal(height('pulse'), frozen);

  // a model-set height wins over an earlier fit() once it changes
  sync([scene({ height: 500 }), scene({ id: 'orbit' })]);
  assert.equal(height('pulse'), '500px');
  sync([scene({ height: 500 }), scene({ id: 'orbit' })]);
  post({ source: pulseWin, data: { type: FIT_TYPE, height: 250 } });
  sync([scene({ height: 500, title: 'unrelated change' }), scene({ id: 'orbit' })]);
  assert.equal(height('pulse'), '250px', 'an unrelated update keeps the fitted height');
});

test('scenes.js: skeleton until load; after 8 s without a load the alt text shows; load clears both; reload button re-navigates', () => {
  const { sync, container, timers } = sceneEnv();
  sync([scene()]);
  const body = frameOf(container, 'pulse').find((n) => n.className.includes('scene-body'));
  const iframe = iframeOf(container, 'pulse');
  const live = () => timers.filter((t) => t.live);
  assert.ok(body.classList.contains('loading'));
  assert.equal(live().length, 1);
  assert.equal(live()[0].ms, 8000);
  const altEl = body.find((n) => n.className === 'scene-alt');
  assert.equal(altEl.textContent, 'Four bars');
  live()[0].fn();
  assert.ok(body.classList.contains('slow'), 'after 8s the alt text is revealed');
  iframe.dispatch('load');
  assert.ok(!body.classList.contains('loading') && !body.classList.contains('slow'));
  assert.equal(live().length, 0, 'the watchdog is cleared on load');

  const reload = frameOf(container, 'pulse').find((n) => n.tagName === 'BUTTON');
  reload.dispatch('click');
  assert.deepEqual(iframe.srcLog, ['s/pulse/?v=1-100', 's/pulse/?v=1-100&r=1']);
  assert.ok(body.classList.contains('loading'));
  iframe.dispatch('load');
  reload.dispatch('click');
  assert.equal(iframe.src, 's/pulse/?v=1-100&r=2');
  // a real file change resets the manual-reload counter
  sync([scene({ mtime: 200 })]);
  assert.equal(iframe.src, 's/pulse/?v=1-200');
});

test('scenes.js: fullscreen button calls requestFullscreen on the iframe and is hidden when unsupported', () => {
  const { sync, container } = sceneEnv();
  sync([scene()]);
  const iframe = iframeOf(container, 'pulse');
  let called = 0;
  iframe.requestFullscreen = () => { called++; return Promise.resolve(); };
  frameOf(container, 'pulse').findAll((n) => n.tagName === 'BUTTON')[1].dispatch('click');
  assert.equal(called, 1);

  const doc = loadBrowserScripts(['blocks.js']).doc;
  doc.fullscreenEnabled = false;
  const env2 = loadBrowserScripts(['blocks.js', 'scenes.js'], { doc });
  const c2 = doc.createElement('div');
  env2.ctx.PanelScenes.sync(c2, [scene()]);
  assert.equal(frameOf(c2, 'pulse').findAll((n) => n.tagName === 'BUTTON')[1].hidden, true);
});

const PAGE_SCRIPTS = ['plain-title.js', 'blocks.js', 'scenes.js', 'events-client.js', 'workspace/layout.js', 'stage.js', 'rail.js', 'ui.js'];

function pageEnv() {
  const env = loadBrowserScripts(PAGE_SCRIPTS);
  const $ = (id) => env.doc.getElementById(id);
  return { ...env, $, render: (s) => env.ctx.PanelUI.render(s) };
}

test('ui.js: the sample state renders header, ask, pinned cards, scenes (before the core columns), cards; scenes alone are not "empty"', () => {
  const { $, render, doc } = pageEnv();
  render(sample);
  assert.equal($('status').hidden, false);
  assert.equal($('waiting').hidden, true);
  assert.equal($('ask').hidden, false);
  assert.equal($('scenes').hidden, false);
  assert.equal($('scenes').children.length, sample.scenes.length);
  assert.deepEqual($('scenes').children.map((n) => n.dataset.sceneId), sample.scenes.map((s) => s.id));
  assert.ok($('pinned').children.length >= 1, 'a pinned card');
  assert.ok($('cards').children.length >= 1);
  assert.equal($('cols').hidden, false);
  assert.match(doc.title, /^Panel — /);
  const frames = $('scenes').findAll((n) => n.tagName === 'IFRAME');
  assert.deepEqual(frames.map((f) => f.src), sample.scenes.map((s) => `s/${s.id}/?v=${s.rev}-${s.mtime ?? 0}`));
  assert.ok(frames.every((f) => f.attrs.sandbox === 'allow-scripts'));

  // same state again (an SSE tick): nothing navigates, nothing is rebuilt
  const nodes = frames.slice();
  render(sample);
  render({ ...sample, updatedAt: sample.updatedAt + 1, ask: 'another question?' });
  assert.deepEqual($('scenes').findAll((n) => n.tagName === 'IFRAME'), nodes);
  assert.ok(frames.every((f) => f.srcLog.length === 1));

  render({ v: 3, scenes: [{ id: 'solo', alt: 'only a scene', rev: 1, mtime: 1 }] });
  assert.equal($('waiting').hidden, true, 'a state with only scenes is not "Waiting for Claude"');
  assert.equal($('status').hidden, false);
  render({});
  assert.equal($('waiting').hidden, false);
  assert.equal($('scenes').hidden, true);
});

test('ui.js / ui.html: relative URLs only, scenes container sits between pinned cards and the core columns', () => {
  const html = readFileSync(join(HERE, 'ui.html'), 'utf8');
  const order = ['id="head"', 'id="ask"', 'id="pinned"', 'id="scenes"', 'id="cols"', 'id="cards"'].map((m) => html.indexOf(m));
  assert.ok(order.every((x, i) => x > 0 && (i === 0 || x > order[i - 1])), 'section order ' + order);
  assert.deepEqual([...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]), PAGE_SCRIPTS);
  const stripComments = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '');
  const js = stripComments(PAGE_SCRIPTS.map((f) => readFileSync(join(HERE, f.startsWith('workspace/') ? 'builtin' : '', f), 'utf8')).join('\n'));
  assert.doesNotMatch(js, /["'`]\/(events|state|s\/)/, 'no absolute URLs in the page scripts');
  assert.doesNotMatch(js, /allow-same-origin|srcdoc|innerHTML/);
});
