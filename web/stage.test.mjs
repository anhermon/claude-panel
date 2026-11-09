// Stage mode of the browser page, under the fake DOM (fake-dom.mjs): rail, stage frames, drawer, keys, return channel.
// Run alone: `node --test web/stage.test.mjs`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HERE } from './testkit.mjs';
import { loadBrowserScripts, createDocument } from './fake-dom.mjs';

const stageSample = JSON.parse(readFileSync(join(HERE, 'sample-stage-state.json'), 'utf8'));
const cardSample = JSON.parse(readFileSync(join(HERE, 'sample-state.json'), 'utf8'));
const SCRIPTS = ['blocks.js', 'scenes.js', 'events-client.js', 'workspace/layout.js', 'stage.js', 'rail.js', 'ui.js'];
const SENT_MS = 3000;
const AUTOHIDE_MS = 2500;
const TOAST_MS = 2000;
const UPDATES = 4;

const stageScene = (over = {}) => ({ id: 'deck', title: 'Backoff', layout: 'stage', alt: 'A deck', rev: 1, mtime: 0, ...over });
const cardScene = (over = {}) => ({ id: 'note', title: 'A card scene', alt: 'A card', rev: 1, mtime: 1, span: 1, height: 200, ...over });
const stateOf = (scenes, over = {}) => ({
  v: 4, status: 'working', task: { title: 'Why retries', why: 'because' }, ask: 'Retry 429 too?',
  choices: [{ id: 'both', label: 'Both' }, { id: 'only503', label: 'Only 503' }], scenes, ...over,
});
const flush = () => new Promise((r) => setImmediate(r));
const isIframe = (n) => n.tagName === 'IFRAME';
const plain = (x) => JSON.parse(JSON.stringify(x)); // objects built inside the vm context have another Object.prototype
const sceneIdAbove = (n) => { for (let x = n; x; x = x.parentNode) if (x.dataset?.sceneId) return x.dataset.sceneId; return null; };
const hasClass = (c) => (n) => n.className.split(' ').includes(c);

function env(files = SCRIPTS) {
  const t = loadBrowserScripts(files);
  const $ = (id) => t.doc.getElementById(id);
  const clock = { now: 1_000_000 };
  t.ctx.Date = { now: () => clock.now }; // the frame-emit throttle reads the clock
  const iframeOf = (id, root = $('stage')) => root.find((n) => isIframe(n) && sceneIdAbove(n) === id);
  const liveTimers = (ms) => t.timers.filter((x) => x.live && x.ms === ms);
  return Object.assign(t, { // assign, not spread: fetchResult is an accessor on the loader's result
    $, clock, iframeOf, liveTimers,
    runTimer: (ms) => { const x = liveTimers(ms).at(-1); assert.ok(x, 'a live timer of ' + ms + ' ms'); x.live = false; x.fn(); },
    render: (s) => t.ctx.PanelUI.render(s),
    deck: (id, over = {}) => t.post({ source: iframeOf(id).contentWindow, data: { type: 'panel-deck', h: 0, v: 0, f: 0, count: 5, title: '', notes: '', ...over } }),
    emit: (id, name, data, extra = {}) => t.post({ source: iframeOf(id).contentWindow, data: { type: 'panel-emit', name, data, ...extra } }),
    key: (key, over = {}) => t.doc.dispatch('keydown', { key, target: t.doc.body, ...over }),
    keyMessages: (id) => iframeOf(id).contentWindow.posted.filter((p) => p.msg.name === 'key').map((p) => ({ msg: plain(p.msg), origin: p.origin })),
    hostMessages: (id, name) => iframeOf(id).contentWindow.posted.filter((p) => p.msg.name === name).map((p) => plain(p.msg.data)),
    railButtons: () => $('rail-actions').children,
    railChoices: () => $('rail-ask').findAll(hasClass('choice')),
    askChoices: () => $('ask').findAll(hasClass('choice')),
  });
}

test('stage mode switches on for any layout:"stage" scene, moves the sections into the drawer, and off again', () => {
  const t = env();
  t.render(stateOf([stageScene(), cardScene()]));
  assert.ok(t.doc.body.classList.contains('stage-mode'));
  assert.deepEqual([t.$('rail').hidden, t.$('stage').hidden, t.$('drawer').hidden, t.$('main').hidden], [false, false, false, true]);
  assert.equal(t.$('content').parentNode, t.$('drawer-body'), 'ask, cards and lists live in the drawer');
  assert.equal(t.$('stage').findAll(isIframe).length, 1, 'the stage scene is in the stage');
  assert.equal(t.$('scenes').findAll(isIframe).length, 1, 'the card-layout scene stays a card, in the drawer');
  assert.equal(t.$('scenes').findAll(isIframe)[0].src, 's/note/?v=1-1');
  const card = t.$('scenes').findAll(isIframe)[0];

  t.render(stateOf([stageScene(), cardScene()], { ask: 'changed?' })); // an ordinary update never moves content or navigates
  assert.equal(t.$('content').parentNode, t.$('drawer-body'));
  assert.equal(card.srcLog.length, 1);

  t.render(stateOf([cardScene()])); // the stage scene went away: the plain v3 page is back
  assert.ok(!t.doc.body.classList.contains('stage-mode'));
  assert.deepEqual([t.$('rail').hidden, t.$('stage').hidden, t.$('drawer').hidden, t.$('main').hidden], [true, true, true, false]);
  assert.equal(t.$('content').parentNode, t.$('main'));
  assert.equal(t.$('stage').findAll(isIframe).length, 0, 'stage frames are disposed');
});

test('the card sample (no stage scene) stays the v3 page; the stage sample switches to stage mode', () => {
  const card = env();
  card.render(cardSample);
  assert.ok(!card.doc.body.classList.contains('stage-mode'));
  assert.equal(card.$('rail').hidden, true);
  assert.equal(card.$('content').parentNode, card.$('main'));

  const t = env();
  t.render(stageSample);
  assert.ok(t.doc.body.classList.contains('stage-mode'));
  assert.equal(t.iframeOf('deck').src, 's/deck/?v=1-0');
  assert.equal(t.$('rail-title').textContent, stageSample.task.title);
  assert.equal(t.$('rail-status').textContent, 'Working');
  assert.equal(t.$('rail-dot').className, 'dot working');
  assert.equal(t.$('status').hidden, false, 'the drawer keeps its own status bar');
});

test('stage iframe: sandbox is exactly allow-scripts (never same-origin, never srcdoc), full attribute set, titled with the alt', () => {
  const t = env();
  t.render(stateOf([stageScene()]));
  const f = t.iframeOf('deck');
  assert.equal(f.attrs.sandbox, 'allow-scripts');
  assert.doesNotMatch(f.attrs.sandbox, /allow-same-origin/);
  assert.equal(f.hasAttribute('srcdoc'), false);
  assert.equal(f.attrs.allow, 'autoplay; fullscreen');
  assert.equal(f.attrs.referrerpolicy, 'no-referrer');
  assert.equal(f.title, 'A deck');
  assert.equal(f.parentNode.className.includes('stage-frame'), true);
});

test('stage iframe src changes only on rev or mtime, and then keeps the position the deck reported (#/h/v/f)', () => {
  const t = env();
  t.render(stateOf([stageScene()]));
  const f = t.iframeOf('deck');
  assert.deepEqual(f.srcLog, ['s/deck/?v=1-0']);
  t.deck('deck', { h: 2, count: 5 });
  t.render(stateOf([stageScene()]));
  t.render(stateOf([stageScene({ title: 'Renamed', alt: 'New alt' })], { ask: 'other', status: 'waiting' }));
  assert.equal(f.srcLog.length, 1, 'text and status changes never navigate');
  assert.equal(f.title, 'New alt');

  t.render(stateOf([stageScene({ mtime: 55 })]));
  assert.equal(f.src, 's/deck/?v=1-55#/2');
  t.deck('deck', { h: 3, v: 1, f: 2 });
  t.render(stateOf([stageScene({ rev: 2, mtime: 55 })]));
  assert.equal(f.src, 's/deck/?v=2-55#/3/1/2');
  t.deck('deck', { h: 3, v: 0, f: 4 });
  t.render(stateOf([stageScene({ rev: 3, mtime: 55 })]));
  assert.equal(f.src, 's/deck/?v=3-55#/3/0/4');
  t.deck('deck', { h: 0 });
  t.render(stateOf([stageScene({ rev: 4, mtime: 55 })]));
  assert.equal(f.src, 's/deck/?v=4-55#/0', 'back on the first slide');
  assert.equal(f.srcLog.length, 5);

  t.railButtons()[1].dispatch('click'); // reload keeps the position too
  assert.equal(f.src, 's/deck/?v=4-55&r=1#/0');
  t.deck('deck', { h: 4 });
  assert.equal(t.railButtons()[2].href, 's/deck/?v=4-55#/4', 'open-in-new-tab follows the current slide');
});

test('rail: status, title, progress h+1/count, notes in the drawer, and the buttons (real controls with aria-labels)', () => {
  const t = env();
  t.render(stateOf([stageScene()], { status: 'blocked' }));
  assert.equal(t.$('rail-progress').hidden, true, 'no progress until the deck reports');
  assert.equal(t.$('notes').hidden, true);
  assert.equal(t.$('rail-status').textContent, 'Blocked');
  assert.equal(t.$('rail-dot').className, 'dot blocked');

  t.deck('deck', { h: 2, count: 9, notes: 'Say the claim first.' });
  assert.equal(t.$('rail-progress').textContent, '3/9');
  assert.equal(t.$('rail-progress').hidden, false);
  assert.equal(t.$('rail-progress').attrs['aria-label'], 'Slide 3 of 9');
  assert.equal(t.$('notes').hidden, false);
  assert.match(t.$('notes').textContent, /Say the claim first\./);
  t.deck('deck', { h: 3, count: 9, notes: '' });
  assert.equal(t.$('rail-progress').textContent, '4/9');
  assert.equal(t.$('notes').hidden, true, 'a slide without notes hides the section');

  const [drawer, reload, open, fullscreen] = t.railButtons();
  assert.deepEqual([drawer, reload, open, fullscreen].map((n) => n.tagName), ['BUTTON', 'BUTTON', 'A', 'BUTTON']);
  for (const b of [drawer, reload, open, fullscreen]) assert.ok(b.attrs['aria-label'].length > 3, b.tagName);
  assert.equal(open.target, '_blank');
  assert.equal(open.rel, 'noopener');
  assert.equal(drawer.attrs['aria-controls'], 'drawer');
  assert.equal(t.$('drawer-head').find((n) => n.tagName === 'BUTTON').attrs['aria-label'], 'Close panel details');
});

test('messages count only from a scene frame window: deck reports, fit requests and emits from anyone else are ignored', () => {
  const t = env();
  t.render(stateOf([stageScene(), cardScene()]));
  const note = t.iframeOf('note', t.$('scenes'));
  const before = t.$('rail-progress').textContent;
  const deckData = { type: 'panel-deck', h: 1, v: 0, f: 0, count: 5, notes: 'x' };
  t.post({ source: {}, data: deckData });
  t.post({ source: null, data: deckData });
  t.post({ source: note.contentWindow, data: deckData }); // a card scene is not a stage
  assert.equal(t.$('rail-progress').textContent, before);
  t.post({ source: {}, data: { type: 'panel-emit', name: 'hello', data: {} } });
  t.post({ source: null, data: { type: 'panel-emit', name: 'hello', data: {} } });
  assert.equal(t.fetchLog.length, 0);

  const stageWin = t.iframeOf('deck').contentWindow;
  for (const bad of [
    { type: 'panel-deck', h: 5, count: 5 }, // h out of range
    { type: 'panel-deck', h: -3, count: 5 },
    { type: 'panel-deck', h: '1', count: 5 },
    { type: 'panel-deck', h: 1.5, count: 5 },
    { type: 'panel-deck', h: 1, count: 0 },
    { type: 'panel-deck', h: 1, count: 100000 },
    { type: 'panel-deck', h: 0, v: 'x', count: 5 },
    { type: 'panel-deck' },
    'panel-deck', null, [1],
  ]) t.post({ source: stageWin, data: bad });
  assert.equal(t.$('rail-progress').hidden, true, 'malformed reports never reach the rail');
  t.deck('deck', { h: 1, notes: 'n'.repeat(10_000) });
  assert.equal(t.$('rail-progress').textContent, '2/5');
  assert.ok(t.$('notes').textContent.length < 4100, 'notes are clipped');

  // panel-fit is for card scenes only: a stage frame cannot resize anything
  const heightOf = (id) => t.$('scenes').find((n) => n.dataset?.sceneId === id).find((n) => n.className.includes('scene-body')).style.height;
  assert.equal(heightOf('note'), '200px');
  t.post({ source: stageWin, data: { type: 'panel-fit', height: 700 } });
  assert.equal(heightOf('note'), '200px');
  t.post({ source: note.contentWindow, data: { type: 'panel-fit', height: 700 } });
  assert.equal(heightOf('note'), '700px', 'card scenes still fit');
});

test('panel-emit: POSTed to the relative event URL with the scene id taken from the SOURCE frame, never from the message', async () => {
  const t = env();
  t.render(stateOf([stageScene(), stageScene({ id: 'other', title: 'Other' }), cardScene()]));
  t.emit('deck', 'quiz.answer', { pick: 'full' }, { scene: 'other', sceneId: 'other', id: 'other' });
  assert.equal(t.fetchLog.length, 1);
  const [call] = t.fetchLog;
  assert.equal(call.url, 'event', 'relative: the page lives at /<token>/');
  assert.equal(call.opts.method, 'POST');
  assert.equal(call.opts.headers['Content-Type'], 'application/json');
  assert.deepEqual(call.body, { scene: 'deck', name: 'quiz.answer', data: { pick: 'full' } });
  await flush();
  assert.equal(t.$('toast').hidden, false, 'a small "sent" toast');
  assert.equal(t.$('toast').textContent, 'Sent: quiz.answer');
  assert.equal(t.liveTimers(TOAST_MS).length, 1);
  t.runTimer(TOAST_MS);
  assert.equal(t.$('toast').hidden, true);

  t.clock.now += 500;
  t.emit('other', 'ping', undefined, { scene: 'deck' }); // another stage frame; no data at all
  assert.deepEqual(t.fetchLog[1].body, { scene: 'other', name: 'ping', data: null });
  t.clock.now += 500;
  t.post({ source: t.iframeOf('note', t.$('scenes')).contentWindow, data: { type: 'panel-emit', name: 'card.click', data: { n: 1 } } });
  assert.deepEqual(t.fetchLog[2].body, { scene: 'note', name: 'card.click', data: { n: 1 } }, 'card-layout scenes can emit too');
});

test('panel-open: only the built-in board may ask the page to open an absolute http(s) url, in a new tab without opener', () => {
  const t = env();
  const opened = [];
  t.ctx.window.open = (...a) => { opened.push(a); return null; };
  t.render(stateOf([stageScene({ id: 'board', builtin: true }), stageScene({ id: 'other', title: 'Other' })]));
  const open = (id, url) => t.post({ source: t.iframeOf(id).contentWindow, data: { type: 'panel-open', url } });
  open('board', 'https://x.pagerduty.com/incidents/P1');
  assert.deepEqual(opened, [['https://x.pagerduty.com/incidents/P1', '_blank', 'noopener,noreferrer']]);
  for (const bad of ['javascript:alert(1)', 'data:text/html,x', '//evil.com', '/rel', 'mailto:a@b.c', '', 5, null, 'https://' + 'a'.repeat(2100)]) open('board', bad);
  open('other', 'https://e.com/');
  t.post({ source: {}, data: { type: 'panel-open', url: 'https://e.com/' } });
  assert.equal(opened.length, 1, 'bad urls and non-board senders are ignored');
});

test('session-open: a card of the board\'s Other sessions frame opens that session in the Agents tile through the page, never reaching the server; only the board may ask', () => {
  const t = env();
  t.render(stateOf([stageScene({ id: 'board', builtin: true }), stageScene({ id: 'agents-info', title: 'Agents', builtin: true }), stageScene({ id: 'other', title: 'Other' })]));
  const ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const sent = t.fetchLog.length;
  const ask = (id, data) => { t.clock.now += 1000; t.emit(id, 'session-open', data); };
  ask('board', { id: ID, title: 'Fix login', state: 'waiting' });
  assert.deepEqual(t.hostMessages('agents-info', 'open-session'), [{ id: ID, title: 'Fix login', state: 'waiting' }]);
  assert.equal(t.fetchLog.length, sent, 'a card click is for the Agents tile: nothing is posted to the events file (Claude never sees it)');
  for (const bad of [{ id: '../x', title: 'x', state: 'busy' }, { id: 5 }, { title: 'no id' }, null, 'text']) ask('board', bad);
  ask('other', { id: ID, title: 'forged', state: 'busy' });
  assert.equal(t.hostMessages('agents-info', 'open-session').length, 1, 'bad ids and other scenes route nothing');
  ask('board', { id: ID, title: 'x'.repeat(200), state: 'nonsense' });
  assert.deepEqual(t.hostMessages('agents-info', 'open-session').at(-1), { id: ID, title: 'x'.repeat(70), state: 'busy' }, 'title cut, unknown state falls back');
});

test('session-open while the board is shown alone brings the Agents tile forward so the opened transcript is visible', () => {
  const t = env();
  t.render(stateOf([stageScene({ id: 'board', builtin: true }), stageScene({ id: 'agents-info', title: 'Agents', builtin: true })]));
  t.ctx.PanelStage.selectTab('board');
  assert.equal(t.ctx.PanelStage.view().selectedId, 'board');
  t.clock.now += 1000;
  t.emit('board', 'session-open', { id: 'sess-1', title: 'T', state: 'idle' });
  assert.equal(t.ctx.PanelStage.view().selectedId, 'agents-info');
  assert.equal(t.hostMessages('agents-info', 'open-session').length, 1);
});

test('panel-emit validation and failure handling: bad names, big data, floods, and rejections are silent', async () => {
  const t = env();
  t.render(stateOf([stageScene()]));
  const emit = (name, data) => { t.clock.now += 1000; t.emit('deck', name, data); };
  for (const bad of ['', 'UPPER', 'has space', 'a/b', 'x'.repeat(41), '../etc', 'sp ace', 5, null, undefined, {}]) emit(bad, {});
  emit('big', { text: 'x'.repeat(2100) });
  emit('cyclic', (() => { const o = {}; o.self = o; return o; })());
  assert.equal(t.fetchLog.length, 0, 'invalid events never leave the page');
  emit('edge.40-chars_ok'.padEnd(40, 'x'), { text: 'y'.repeat(2000) });
  assert.equal(t.fetchLog.length, 1, 'names up to 40 chars and data up to 2 KB go through');

  t.clock.now += 1000;
  t.emit('deck', 'a1', {});
  t.emit('deck', 'a2', {}); // same instant: throttled, a scene cannot flood the server
  t.clock.now += 50;
  t.emit('deck', 'a3', {});
  t.clock.now += 100;
  t.emit('deck', 'a4', {});
  assert.deepEqual(t.fetchLog.slice(1).map((c) => c.body.name), ['a1', 'a4']);

  await flush();
  t.$('toast').hidden = true;
  t.fetchResult = { ok: false, status: 429 };
  emit('rejected', {});
  await flush();
  assert.equal(t.$('toast').hidden, true, 'a rejected event shows no "sent" feedback and throws nothing');
  t.fetchResult = new Error('network down');
  emit('offline', {});
  await flush();
  assert.equal(t.$('toast').hidden, true);
});

test('deck.* names are page commands: handled here and never forwarded to the events file', async () => {
  const t = env();
  t.render(stateOf([stageScene()]));
  let fullscreenCalls = 0;
  t.$('shell').requestFullscreen = () => { fullscreenCalls++; return Promise.resolve(); };
  t.emit('deck', 'deck.fullscreen');
  assert.equal(fullscreenCalls, 1, 'deck.fullscreen toggles fullscreen on the shell');
  t.clock.now += 500;
  t.emit('deck', 'deck.drawer');
  assert.ok(t.$('drawer').classList.contains('open'), 'deck.drawer toggles the drawer');
  t.clock.now += 500;
  t.emit('deck', 'deck.something-else', { x: 1 });
  t.emit('deck', 'deck.', {});
  await flush();
  assert.equal(t.fetchLog.length, 0, 'nothing starting with deck. is ever POSTed');
  assert.equal(t.$('toast').hidden, true);
  t.emit('deck', 'decks.fine', {}); // only the exact prefix is reserved
  assert.equal(t.fetchLog.length, 1);
});

test('ask choices: inline in the rail pill and in the drawer; a click POSTs the answer, shows "Sent: <label>" for 3 s, then is clickable again', async () => {
  const t = env();
  t.render(stateOf([stageScene()]));
  assert.deepEqual(t.railChoices().map((b) => b.textContent), ['Both', 'Only 503']);
  assert.deepEqual(t.askChoices().map((b) => b.textContent), ['Both', 'Only 503'], 'the same buttons in the drawer');
  assert.equal(t.$('rail-ask').hidden, false);
  assert.equal(t.$('rail-ask').find(hasClass('rail-ask-text')).textContent, 'Retry 429 too?');
  assert.ok(t.railChoices().every((b) => b.tagName === 'BUTTON' && b.type === 'button'));

  t.railChoices()[1].dispatch('click');
  assert.deepEqual(t.fetchLog.map((c) => c.body), [{ scene: '_ask', name: 'answer', data: { id: 'only503', label: 'Only 503' } }]);
  assert.equal(t.fetchLog[0].url, 'event');
  await flush();
  for (const group of [t.$('rail-ask'), t.$('ask')]) {
    assert.equal(group.find(hasClass('choice-sent')).textContent, 'Sent: Only 503');
    assert.equal(group.find(hasClass('choice-sent')).hidden, false);
    assert.ok(group.findAll(hasClass('choice')).every((b) => b.hidden));
    assert.equal(group.find(hasClass('choices')).attrs['aria-live'], 'polite');
  }
  t.railChoices()[0].dispatch('click'); // while "Sent" shows, a second click is ignored
  assert.equal(t.fetchLog.length, 1);
  t.render(stateOf([stageScene()], { status: 'waiting' })); // an unrelated update must not drop the feedback
  assert.equal(t.$('rail-ask').find(hasClass('choice-sent')).hidden, false);

  assert.equal(t.liveTimers(SENT_MS).length, 1);
  t.runTimer(SENT_MS);
  assert.equal(t.$('rail-ask').find(hasClass('choice-sent')).hidden, true);
  assert.ok(t.railChoices().every((b) => !b.hidden) && t.askChoices().every((b) => !b.hidden), 'clickable again');
  t.askChoices()[0].dispatch('click');
  assert.deepEqual(t.fetchLog[1].body, { scene: '_ask', name: 'answer', data: { id: 'both', label: 'Both' } });

  // a rejected answer: no "Sent", buttons stay
  const u = env();
  u.render(stateOf([stageScene()]));
  u.fetchResult = { ok: false, status: 403 };
  u.railChoices()[0].dispatch('click');
  await flush();
  assert.equal(u.$('rail-ask').find(hasClass('choice-sent')).hidden, true);
  assert.ok(u.railChoices().every((b) => !b.hidden));
});

test('ask without choices: the pill still opens the drawer; no ask hides the pill; the plain v3 page shows the answers under the ask', async () => {
  const t = env();
  t.render(stateOf([stageScene()], { choices: [] }));
  assert.equal(t.$('rail-ask').hidden, false);
  assert.equal(t.railChoices().length, 0);
  assert.equal(t.$('ask').find(hasClass('choices')), null);
  t.$('rail-ask').find(hasClass('rail-ask-text')).dispatch('click');
  assert.ok(t.$('drawer').classList.contains('open'), 'clicking the pill opens the drawer');
  t.render(stateOf([stageScene()], { ask: '', choices: [{ id: 'x', label: 'X' }] }));
  assert.equal(t.$('rail-ask').hidden, true);
  assert.equal(t.railButtons()[0].classList.contains('has-ask'), false, 'no ask, no badge dot');

  const v3 = env();
  v3.render(cardSample);
  assert.equal(v3.$('rail').hidden, true);
  const buttons = v3.askChoices();
  assert.deepEqual(buttons.map((b) => b.dataset.choiceId), cardSample.choices.map((c) => c.id));
  buttons[0].dispatch('click');
  assert.deepEqual(v3.fetchLog[0].body, { scene: '_ask', name: 'answer', data: { id: cardSample.choices[0].id, label: cardSample.choices[0].label } });
  await flush();
  assert.equal(v3.$('ask').find(hasClass('choice-sent')).textContent, 'Sent: ' + cardSample.choices[0].label);
});

test('drawer: button and key i toggle it, Esc closes it, focus moves in on open and back to the stage on close, aria state follows', () => {
  const t = env();
  t.render(stateOf([stageScene()]));
  const drawer = t.$('drawer');
  const [toggle] = t.railButtons();
  assert.equal(drawer.classList.contains('open'), false);
  assert.equal(toggle.attrs['aria-expanded'], 'false');

  toggle.dispatch('click');
  assert.ok(drawer.classList.contains('open'));
  assert.equal(toggle.attrs['aria-expanded'], 'true');
  assert.equal(t.doc.activeElement, drawer, 'focus goes into the drawer');
  assert.equal(drawer.attrs.tabindex, '-1', 'programmatically focusable, not in the tab order (ui.html)');

  const frame = t.iframeOf('deck');
  toggle.dispatch('click');
  assert.equal(drawer.classList.contains('open'), false);
  assert.equal(frame.focusLog, 1, 'closing hands focus back to the stage');

  const kbd = t.key('i');
  assert.equal(kbd.defaultPrevented, true);
  assert.ok(drawer.classList.contains('open'));
  const esc = t.key('Escape', { target: drawer });
  assert.equal(esc.defaultPrevented, true);
  assert.equal(drawer.classList.contains('open'), false);
  assert.equal(t.key('Escape').defaultPrevented, false, 'Esc with nothing to close is left to the browser (fullscreen exit)');

  t.key('i', { target: { tagName: 'INPUT' } });
  t.key('i', { target: { tagName: 'TEXTAREA' } });
  t.key('i', { ctrlKey: true });
  t.key('i', { metaKey: true });
  assert.equal(drawer.classList.contains('open'), false, 'typing, or a chord, never toggles');
  t.key('i', { target: { tagName: 'BUTTON' } });
  assert.ok(drawer.classList.contains('open'), 'a focused button does not swallow i');
  t.$('drawer-head').find((n) => n.tagName === 'BUTTON').dispatch('click');
  assert.equal(drawer.classList.contains('open'), false, 'the close button closes');

  t.render(stateOf([cardScene()])); // leaving stage mode closes the drawer and disables the keys
  t.key('i');
  assert.equal(drawer.classList.contains('open'), false);
});

test('keyboard: stage keys are forwarded to the active frame as panel-host messages unless a control or the drawer owns the key', () => {
  const t = env();
  t.render(stateOf([stageScene()]));
  const forwarded = ['ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End', ' ', 'o'];
  for (const k of forwarded) {
    const ev = t.key(k);
    assert.equal(ev.defaultPrevented, true, k + ' is consumed');
  }
  const win = t.iframeOf('deck').contentWindow;
  assert.deepEqual(t.keyMessages('deck').map((p) => p.msg), forwarded.map((key) => ({ type: 'panel-host', name: 'key', data: { key } })));
  assert.ok(t.keyMessages('deck').every((p) => p.origin === '*'), 'the sandboxed frame has an opaque origin');
  assert.ok(win.posted.length >= forwarded.length);

  const count = () => t.keyMessages('deck').length;
  const n = count();
  for (const target of [{ tagName: 'INPUT' }, { tagName: 'TEXTAREA' }, { tagName: 'BUTTON' }, { tagName: 'SELECT' }, { tagName: 'DIV', isContentEditable: true }]) {
    assert.equal(t.key('ArrowRight', { target }).defaultPrevented, false, target.tagName);
  }
  t.key('ArrowRight', { target: t.$('drawer-body') }); // inside the drawer (scrolling) the keys stay local
  t.key('ArrowRight', { target: t.$('rail-title') });
  t.key('ArrowRight', { ctrlKey: true });
  t.key('ArrowRight', { metaKey: true });
  t.key('ArrowRight', { altKey: true });
  t.key('x');
  t.key('Tab'); // never trapped
  t.key('Enter');
  t.key('s');
  assert.equal(count(), n);
  assert.equal(t.key('Tab').defaultPrevented, false);

  t.doc.activeElement = t.iframeOf('deck'); // the frame itself has focus: the page does not double-send
  t.key('ArrowRight');
  assert.equal(count(), n);

  t.render(stateOf([cardScene()])); // no stage, nothing to forward to
  t.doc.activeElement = t.doc.body;
  assert.equal(t.key('ArrowRight').defaultPrevented, false);
});

test('keyboard: f toggles fullscreen at the page (and is not forwarded); fullscreen state drives a class, aria-pressed and the auto-hiding rail', async () => {
  const t = env();
  t.render(stateOf([stageScene()]));
  const shell = t.$('shell');
  let requests = 0;
  shell.requestFullscreen = () => { requests++; t.doc.fullscreenElement = shell; return Promise.resolve(); };
  const fsButton = t.railButtons()[3];
  assert.equal(fsButton.hidden, false);

  const ev = t.key('f');
  assert.equal(ev.defaultPrevented, true);
  assert.equal(requests, 1);
  assert.equal(t.keyMessages('deck').length, 0, 'f is the page\'s key');
  t.key('f', { target: { tagName: 'INPUT' } });
  assert.equal(requests, 1);

  t.doc.dispatch('fullscreenchange');
  assert.ok(t.doc.body.classList.contains('is-fullscreen'));
  assert.equal(fsButton.attrs['aria-pressed'], 'true');
  assert.equal(t.liveTimers(AUTOHIDE_MS).length, 1, 'the rail will hide after 2.5 s');
  assert.equal(t.$('rail').classList.contains('rail-hidden'), false);
  t.runTimer(AUTOHIDE_MS);
  assert.equal(t.$('rail').classList.contains('rail-hidden'), true);

  t.doc.dispatch('pointermove'); // movement brings it back and restarts the countdown
  assert.equal(t.$('rail').classList.contains('rail-hidden'), false);
  assert.equal(t.liveTimers(AUTOHIDE_MS).length, 1);
  t.runTimer(AUTOHIDE_MS);
  assert.equal(t.$('rail').classList.contains('rail-hidden'), true);
  t.doc.dispatch('touchstart');
  assert.equal(t.$('rail').classList.contains('rail-hidden'), false);
  t.runTimer(AUTOHIDE_MS);
  t.key('Home');
  assert.equal(t.$('rail').classList.contains('rail-hidden'), false, 'a key press brings it back too');

  t.$('rail').dispatch('pointerenter'); // pointer resting on the rail: it stays
  t.runTimer(AUTOHIDE_MS);
  assert.equal(t.$('rail').classList.contains('rail-hidden'), false);
  t.$('rail').dispatch('pointerleave');
  t.runTimer(AUTOHIDE_MS);
  assert.equal(t.$('rail').classList.contains('rail-hidden'), true);

  t.key('f'); // second press leaves fullscreen
  assert.equal(t.doc.exitCalls, 1);
  t.doc.dispatch('fullscreenchange');
  assert.ok(!t.doc.body.classList.contains('is-fullscreen'));
  assert.equal(fsButton.attrs['aria-pressed'], 'false');
  assert.equal(t.$('rail').classList.contains('rail-hidden'), false, 'the rail is always visible outside fullscreen');
  assert.equal(t.liveTimers(AUTOHIDE_MS).length, 0);
  t.doc.dispatch('pointermove');
  assert.equal(t.liveTimers(AUTOHIDE_MS).length, 0, 'no hide timer outside fullscreen');

  fsButton.dispatch('click'); // the button does the same as the key
  assert.equal(requests, 2);

  const noFs = createDocument();
  noFs.fullscreenEnabled = false;
  loadBrowserScripts(SCRIPTS, { doc: noFs }).ctx.PanelUI.render(stateOf([stageScene()]));
  assert.equal(noFs.getElementById('rail-actions').children[3].hidden, true, 'no fullscreen support: no button');
});

test('focus: the active stage frame is focused when it loads (unless the drawer is open) and told it is visible', () => {
  const t = env();
  t.render(stateOf([stageScene()]));
  const f = t.iframeOf('deck');
  f.dispatch('load');
  assert.equal(f.focusLog, 1);
  assert.equal(f.contentWindow.focusLog, 1);
  assert.deepEqual(t.hostMessages('deck', 'visible'), [{ visible: true }]);
  t.railButtons()[0].dispatch('click');
  f.dispatch('load'); // a live reload while reading the drawer must not steal focus
  assert.equal(f.focusLog, 1);
  assert.equal(t.doc.activeElement, t.$('drawer'));
});

test('narrow screens: the media query toggles the narrow class; the drawer button carries a badge flag while an ask is open', () => {
  const t = env();
  t.render(stateOf([stageScene()]));
  assert.equal(t.doc.body.classList.contains('narrow'), false);
  t.setNarrow(true);
  assert.equal(t.doc.body.classList.contains('narrow'), true);
  t.setNarrow(false);
  assert.equal(t.doc.body.classList.contains('narrow'), false);
  assert.equal(t.railButtons()[0].classList.contains('has-ask'), true, 'the CSS shows the dot on narrow screens');
  t.render(stateOf([stageScene()], { ask: '' }));
  assert.equal(t.railButtons()[0].classList.contains('has-ask'), false);
  const css = readFileSync(join(HERE, 'ui.css'), 'utf8');
  assert.match(css, /\.narrow \.rail-ask[^{]*\{[^}]*display: none/, 'the ask pill is hidden on narrow screens');
  assert.match(css, /\.narrow \.icon-btn\.has-ask::after/);
  assert.match(css, /@media \(pointer: coarse\)\s*\{\s*:root\s*\{\s*--rail-btn: 36px/, 'touch targets grow');
});

test('events-client: only the exact scene/name shapes are sent, answers are clipped, and fetch problems resolve false', async () => {
  const t = env();
  const { post, sendAnswer } = t.ctx.PanelEvents;
  assert.equal(await post('Bad Scene', 'x', {}), false);
  assert.equal(await post('deck', 'Bad Name', {}), false);
  assert.equal(await post('', 'x', {}), false);
  assert.equal(await post('_other', 'x', {}), false);
  assert.equal(t.fetchLog.length, 0);
  assert.equal(await post('_ask', 'answer', { id: 'a' }), true);
  assert.equal(await post('a'.repeat(24), 'n', 1), true);
  assert.equal(await post('a'.repeat(25), 'n', 1), false);
  assert.equal(await sendAnswer({ id: 'i'.repeat(50), label: 'l'.repeat(80) }), true);
  assert.deepEqual(t.fetchLog.at(-1).body.data, { id: 'i'.repeat(24), label: 'l'.repeat(40) });
  t.fetchResult = { ok: false };
  assert.equal(await post('deck', 'x', {}), false);
  t.fetchResult = new Error('x');
  assert.equal(await post('deck', 'x', {}), false);
});

test('ui.html: labelled <aside> drawer, rail as the banner landmark, one visible <main>, live toast, stage before the drawer', () => {
  const html = readFileSync(join(HERE, 'ui.html'), 'utf8');
  assert.match(html, /<aside class="drawer" id="drawer" aria-label="[^"]+" tabindex="-1" hidden>/);
  assert.match(html, /<header class="stage-rail" id="rail" hidden>/);
  assert.doesNotMatch(html, /rail-tabs/, 'the stage tab row is gone: every scene is a tile of the workspace');
  assert.match(html, /<script src="workspace\/layout.js" defer><\/script>\n<script src="stage.js" defer>/);
  assert.match(html, /<main class="stage" id="stage" aria-label="Stage" hidden>/);
  assert.match(html, /<main id="main" aria-live="polite">/);
  assert.match(html, /<p class="toast" id="toast" role="status" aria-live="polite" hidden>/);
  assert.equal([...html.matchAll(/<main\b/g)].length, 2, 'the stage and the plain page; exactly one is visible at a time');
  assert.ok(html.indexOf('id="shell"') < html.indexOf('id="rail"') && html.indexOf('id="toast"') < html.indexOf('</div>\n</body>'), 'the toast lives inside the shell so fullscreen shows it');
  assert.doesNotMatch(html, /allow-same-origin/);
});

test('without stage.js and rail.js the page degrades to the v3 page: a stage scene shows as a card scene', () => {
  const t = loadBrowserScripts(['blocks.js', 'scenes.js', 'ui.js']);
  t.ctx.PanelUI.render(stateOf([stageScene()]));
  const doc = t.doc;
  assert.ok(!doc.body.classList.contains('stage-mode'));
  assert.equal(doc.getElementById('scenes').findAll(isIframe).length, 1);
  assert.equal(doc.getElementById('main').hidden, false);
});

test('the stage keeps exactly one iframe per scene id across updates', () => {
  const t = env();
  for (let i = 0; i < UPDATES; i++) t.render(stateOf([stageScene({ mtime: i })]));
  assert.equal(t.$('stage').findAll(isIframe).length, 1);
  assert.equal(t.iframeOf('deck').srcLog.length, UPDATES);
});
