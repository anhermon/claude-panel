// The browser stage as a WORKSPACE (stage.js + builtin/workspace/layout.js), under the fake DOM: every tile scene is on the
// stage at once, placed by the layout chooser; a tile's strip opens one scene alone and Esc goes back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadBrowserScripts } from './fake-dom.mjs';

const SCRIPTS = ['blocks.js', 'scenes.js', 'events-client.js', 'workspace/layout.js', 'stage.js', 'rail.js', 'ui.js'];
const stageScene = (over = {}) => ({ id: 'deck', title: 'Backoff', layout: 'stage', alt: 'A deck', rev: 1, mtime: 0, ...over });
const boardScene = (over = {}) => ({ id: 'board', title: 'Board', layout: 'stage', builtin: true, pin: true, alt: 'The board', rev: 1, mtime: 0, ...over });
const stateOf = (scenes, over = {}) => ({
  v: 4, status: 'working', task: { title: 'Why retries', why: 'because' }, ask: 'Retry 429 too?',
  choices: [{ id: 'both', label: 'Both' }], scenes, ...over,
});
const isIframe = (n) => n.tagName === 'IFRAME';

function env() {
  const t = loadBrowserScripts(SCRIPTS);
  const $ = (id) => t.doc.getElementById(id);
  const iframeOf = (id) => $('stage').find((n) => isIframe(n) && n.parentNode.dataset?.sceneId === id);
  const tileOf = (id) => iframeOf(id).parentNode.parentNode;
  return Object.assign(t, {
    $, iframeOf, tileOf,
    render: (s) => t.ctx.PanelUI.render(s),
    areas: (ids) => ids.map((id) => tileOf(id).style.gridArea),
    shown: () => [...new Set($('stage').findAll(isIframe).map((f) => f.parentNode.parentNode))].filter((n) => !n.hidden).map((n) => n.dataset.sceneId),
    key: (key, over = {}) => t.doc.dispatch('keydown', { key, target: t.doc.body, ...over }),
    visible: (id) => t.iframeOf(id).contentWindow.posted.filter((p) => p.msg.name === 'visible').map((p) => p.msg.data.visible),
    strip: (id) => tileOf(id).children[0],
  });
}

test('every tile scene is on the stage at once, in layout order; the board comes first, then publish order', () => {
  const t = env();
  t.render(stateOf([boardScene(), stageScene({ id: 'a' }), stageScene({ id: 'b' })]));
  assert.deepEqual(t.shown(), ['board', 'a', 'b']);
  assert.equal(t.$('stage').dataset.count, '3');
  // the fake stage cannot be measured: the 16:9 fallback is wide, so the board is the big tile on the left
  assert.deepEqual(t.areas(['board', 'a', 'b']), ['1 / 1 / span 2 / span 1', '1 / 2 / span 1 / span 1', '2 / 2 / span 1 / span 1']);
  assert.equal(t.$('stage').style.gridTemplateColumns, 'minmax(0,2fr) minmax(0,1fr)');
  assert.equal(t.$('stage').findAll(isIframe).length, 3, 'one iframe per scene');
});

test('a card scene is not a tile unless it is pinned; the retired pulse and other built-ins are never tiles', () => {
  const t = env();
  t.render(stateOf([boardScene(), stageScene(), { id: 'note', alt: 'n', rev: 1, mtime: 1 }, { id: 'pin', alt: 'p', pin: true, rev: 1, mtime: 1 }, boardScene({ id: 'pulse', title: 'Pulse' })]));
  assert.deepEqual(t.shown(), ['board', 'deck', 'pin']);
  assert.equal(t.$('scenes').findAll(isIframe).length, 1, 'the unpinned card stays a card in the drawer');
});

test('slot decides the order: big first, side last', () => {
  const t = env();
  t.render(stateOf([boardScene(), stageScene({ id: 'a', slot: 'side' }), stageScene({ id: 'b', slot: 'big' })]));
  assert.deepEqual(t.areas(['b', 'board', 'a']), ['1 / 1 / span 2 / span 1', '1 / 2 / span 1 / span 1', '2 / 2 / span 1 / span 1']);
});

test('more than 6 tiles: the first 6 and a "+N more" chip', () => {
  const t = env();
  const many = Array.from({ length: 8 }, (_, i) => stageScene({ id: 's' + i }));
  t.render(stateOf(many));
  assert.equal(t.shown().length, 6);
  const chip = t.$('stage').find((n) => n.className === 'tile-more');
  assert.equal(chip.hidden, false);
  assert.equal(chip.textContent, '+2 more');
  t.render(stateOf(many.slice(0, 3)));
  assert.equal(chip.hidden, true);
  assert.equal(t.$('stage').dataset.count, '3');
});

test('one tile is full-bleed with no strip; a second one brings the strips (the title of each scene)', () => {
  const t = env();
  t.render(stateOf([boardScene()]));
  assert.equal(t.$('stage').dataset.count, '1');
  assert.deepEqual(t.areas(['board']), ['1 / 1 / span 1 / span 1']);
  t.render(stateOf([boardScene(), stageScene()]));
  assert.equal(t.$('stage').dataset.count, '2');
  assert.deepEqual([t.strip('board').textContent, t.strip('deck').textContent], ['Board', 'Backoff']);
  assert.equal(t.strip('deck').tagName, 'BUTTON');
});

test('a tile strip opens that scene alone (#stage=<id>, its frame focused), the strip or Esc goes back; nothing reloads', () => {
  const t = env();
  t.render(stateOf([boardScene(), stageScene()]));
  for (const id of ['board', 'deck']) t.iframeOf(id).dispatch('load');
  t.strip('deck').dispatch('click');
  assert.equal(t.ctx.location.hash, '#stage=deck');
  assert.deepEqual(t.shown(), ['deck']);
  assert.equal(t.$('stage').dataset.count, '1');
  assert.equal(t.$('stage').classList.contains('is-solo'), true, 'the strip stays so the way back is visible');
  assert.equal(t.strip('deck').textContent, '← Backoff');
  assert.equal(t.ctx.PanelStage.view().selectedId, 'deck');
  assert.deepEqual(t.visible('board'), [true, false], 'the hidden tile is told it cannot be seen');
  assert.deepEqual(t.visible('deck'), [true]);

  assert.equal(t.key('Escape').defaultPrevented, true);
  assert.equal(t.ctx.location.hash, '');
  assert.deepEqual(t.shown(), ['board', 'deck']);
  assert.deepEqual(t.visible('board'), [true, false, true]);
  assert.equal(t.iframeOf('deck').srcLog.length, 1, 'switching never reloads');
  assert.equal(t.key('Escape').defaultPrevented, false, 'Esc with nothing alone is left to the page');

  t.strip('board').dispatch('click');
  t.strip('board').dispatch('click'); // the strip of the scene alone is the way back too
  assert.deepEqual(t.shown(), ['board', 'deck']);
});

test('Esc closes the drawer first; only then does it leave the solo view', () => {
  const t = env();
  t.render(stateOf([boardScene(), stageScene()]));
  t.strip('deck').dispatch('click');
  t.key('i');
  assert.ok(t.$('drawer').classList.contains('open'));
  t.key('Escape');
  assert.ok(!t.$('drawer').classList.contains('open'));
  assert.deepEqual(t.shown(), ['deck'], 'still alone');
  t.key('Escape');
  assert.deepEqual(t.shown(), ['board', 'deck']);
});

test('the host hash picks the solo scene on the first render; a stale one and a vanished scene fall back to the workspace', () => {
  const t = env();
  t.ctx.location.hash = '#stage=deck';
  t.render(stateOf([boardScene(), stageScene()]));
  assert.deepEqual(t.shown(), ['deck']);
  t.render(stateOf([boardScene()])); // the deck went away
  assert.deepEqual(t.shown(), ['board']);
  assert.equal(t.ctx.PanelStage.view().selectedId, '');
  const u = env();
  u.ctx.location.hash = '#stage=gone';
  u.render(stateOf([boardScene(), stageScene()]));
  assert.deepEqual(u.shown(), ['board', 'deck']);
  u.ctx.location.hash = '#stage=deck'; // Back button or a typed hash
  u.windowEvent('hashchange');
  assert.deepEqual(u.shown(), ['deck']);
  u.ctx.location.hash = '';
  u.windowEvent('hashchange');
  assert.deepEqual(u.shown(), ['board', 'deck']);
});

test('the rail has no tab row; the board alone has no drawer button and no ask pill, a scene of the model\'s brings both', () => {
  const t = env();
  t.render(stateOf([boardScene()]));
  assert.equal(t.$('rail-tabs'), null);
  assert.equal(t.$('rail-ask').hidden, true, 'the board draws the question itself');
  t.key('i');
  assert.equal(t.ctx.PanelRail.isDrawerOpen(), false, 'no drawer to open');
  t.render(stateOf([boardScene(), stageScene()]));
  assert.equal(t.$('rail-ask').hidden, false);
  t.key('i');
  assert.equal(t.ctx.PanelRail.isDrawerOpen(), true);
  t.key('Escape');
  t.render(stateOf([boardScene()]));
  assert.equal(t.$('rail-ask').hidden, true);
  assert.equal(t.$('stage').findAll(isIframe).length, 1);
});

test('the arrow keys, the progress and the notes follow the scene that reported a deck, not the first tile', () => {
  const t = env();
  t.render(stateOf([boardScene(), stageScene()]));
  t.key('ArrowRight');
  const keysOf = (id) => t.iframeOf(id).contentWindow.posted.filter((p) => p.msg.name === 'key').length;
  assert.deepEqual([keysOf('board'), keysOf('deck')], [1, 0], 'no deck yet: the first tile');
  t.post({ source: t.iframeOf('deck').contentWindow, data: { type: 'panel-deck', h: 1, v: 0, f: 0, count: 4, notes: 'n' } });
  assert.equal(t.$('rail-progress').textContent, '2/4');
  t.key('ArrowRight');
  assert.deepEqual([keysOf('board'), keysOf('deck')], [1, 1]);
});

test('the scene iframes keep the sandbox contract inside a tile, and re-layouts do not reload them', () => {
  const t = env();
  t.render(stateOf([boardScene(), stageScene()]));
  for (const id of ['board', 'deck']) {
    assert.equal(t.iframeOf(id).attrs.sandbox, 'allow-scripts');
    assert.equal(t.iframeOf(id).hasAttribute('srcdoc'), false);
  }
  t.render(stateOf([boardScene(), stageScene(), stageScene({ id: 'c' })]));
  t.render(stateOf([boardScene(), stageScene(), stageScene({ id: 'c' })], { ask: 'other' }));
  assert.equal(t.iframeOf('board').srcLog.length, 1);
  assert.equal(t.iframeOf('deck').srcLog.length, 1);
});
