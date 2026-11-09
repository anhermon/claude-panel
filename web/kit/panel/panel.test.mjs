// Unit tests for the scene SDK (panel.js, a classic script) run inside a vm context with a hand-made window.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SRC = readFileSync(new URL('./panel.js', import.meta.url), 'utf8');
const MAX_DATA_BYTES = 2048;

/** Run panel.js against a fake window. `posted` collects what the SDK sends to the parent. */
function boot({ docHeight = 500 } = {}) {
  const posted = [];
  const listeners = [];
  const attrs = {};
  // JSON copy: objects made inside the vm have foreign prototypes, which deepStrictEqual rejects
  const parent = { postMessage: (m, origin) => posted.push({ m: JSON.parse(JSON.stringify(m)), origin }) };
  const documentElement = { scrollHeight: docHeight, setAttribute: (k, v) => { attrs[k] = v; } };
  const win = {
    parent,
    addEventListener: (t, fn) => listeners.push({ t, fn }),
    removeEventListener: (t, fn) => { const i = listeners.findIndex((l) => l.fn === fn); if (i >= 0) listeners.splice(i, 1); },
  };
  const errors = [];
  const ctx = {
    window: win, document: { documentElement, body: { scrollHeight: docHeight }, readyState: 'complete', fonts: { ready: Promise.resolve() } },
    console: { error: (...a) => errors.push(a.join(' ')) }, TextEncoder, JSON, Math, Promise, isFinite,
  };
  vm.runInNewContext(SRC, ctx);
  const deliver = (data, source = parent) => listeners.filter((l) => l.t === 'message').forEach((l) => l.fn({ data, source }));
  return { panel: win.panel, posted, errors, deliver, win, attrs, listeners, ctx };
}

test('emit: valid name posts {type:panel-emit,name,data} to the parent', () => {
  const { panel, posted } = boot();
  assert.equal(panel.emit('quiz.answer', { id: 3, ok: true }), true);
  assert.deepEqual(posted[0].m, { type: 'panel-emit', name: 'quiz.answer', data: { id: 3, ok: true } });
  assert.equal(posted[0].origin, '*');
});

test('emit: rejects names outside [a-z0-9._-]{1,40}', () => {
  const { panel, posted, errors } = boot();
  for (const bad of ['', 'Upper', 'has space', 'x'.repeat(41), 'a/b', null, 5, undefined]) assert.equal(panel.emit(bad, 1), false, String(bad));
  assert.equal(posted.length, 0);
  assert.equal(errors.length, 8);
  assert.equal(panel.emit('x'.repeat(40)), true);
  assert.equal(panel.emit('a-b_c.d9', 1), true);
});

test('emit: data over 2 KB is replaced by a valid-JSON preview that fits', () => {
  const { panel, posted } = boot();
  panel.emit('big', { text: 'é'.repeat(5000) });
  const sent = posted[0].m.data;
  assert.equal(sent.clipped, true);
  assert.ok(sent.bytes > MAX_DATA_BYTES);
  assert.ok(Buffer.byteLength(JSON.stringify(sent)) <= MAX_DATA_BYTES);
  panel.emit('edge', 'a'.repeat(MAX_DATA_BYTES - 2)); // exactly 2048 bytes once quoted: not clipped
  assert.equal(posted[1].m.data.length, MAX_DATA_BYTES - 2);
});

test('emit: unserialisable data is refused, undefined becomes null', () => {
  const { panel, posted, errors } = boot();
  const loop = {}; loop.self = loop;
  assert.equal(panel.emit('loop', loop), false);
  assert.match(errors[0], /serialisable/);
  assert.equal(panel.emit('nothing'), true);
  assert.equal(posted[0].m.data, null);
});

test('fit: clamps to 120..1200 and accepts an explicit height', () => {
  const { panel, posted } = boot({ docHeight: 40 });
  panel.fit(); panel.fit(5000); panel.fit(333.2); panel.fit(NaN);
  assert.deepEqual(posted.map((p) => p.m.height), [120, 1200, 334, 120]);
  assert.equal(posted[0].m.type, 'panel-fit');
});

test('on: only messages from the parent, with type panel-host and the same name, reach the handler; off unsubscribes', () => {
  const { panel, deliver } = boot();
  const got = [];
  const off = panel.on('key', (d) => got.push(d));
  deliver({ type: 'panel-host', name: 'key', data: { key: 'ArrowRight' } });
  deliver({ type: 'panel-host', name: 'visible', data: { visible: false } });
  deliver({ type: 'panel-emit', name: 'key', data: 1 });
  deliver({ type: 'panel-host', name: 'key', data: { key: 'x' } }, { not: 'the parent' });
  deliver(null);
  assert.deepEqual(got, [{ key: 'ArrowRight' }]);
  off();
  deliver({ type: 'panel-host', name: 'key', data: { key: 'y' } });
  assert.equal(got.length, 1);
});

test('on: a throwing handler does not break delivery to others', () => {
  const { panel, deliver, errors } = boot();
  let ok = 0;
  panel.on('visible', () => { throw new Error('boom'); });
  panel.on('visible', () => { ok++; });
  deliver({ type: 'panel-host', name: 'visible', data: {} });
  assert.equal(ok, 1);
  assert.equal(errors.length, 1);
});

test('theme host message sets data-theme on the root element', () => {
  const { deliver, attrs } = boot();
  deliver({ type: 'panel-host', name: 'theme', data: { dark: false } });
  assert.equal(attrs['data-theme'], 'light');
  deliver({ type: 'panel-host', name: 'theme', data: { dark: true } });
  assert.equal(attrs['data-theme'], 'dark');
});

test('canEmit: true until the host says channel {emit:false}; a later channel {emit:true} restores it', () => {
  const { panel, deliver } = boot();
  assert.equal(panel.canEmit(), true);
  deliver({ type: 'panel-host', name: 'channel', data: { emit: false } });
  assert.equal(panel.canEmit(), false);
  deliver({ type: 'panel-host', name: 'channel', data: { emit: false } }, { not: 'the parent' });
  deliver({ type: 'panel-host', name: 'channel', data: { emit: true } });
  assert.equal(panel.canEmit(), true);
  deliver({ type: 'panel-host', name: 'channel', data: null });
  assert.equal(panel.canEmit(), true, 'a message without emit:false changes nothing for the worse');
});

test('running the script twice keeps the first object and adds no listeners', () => {
  const { panel, ctx, listeners } = boot();
  const before = listeners.length;
  vm.runInNewContext(SRC, ctx);
  assert.equal(ctx.window.panel, panel);
  assert.equal(listeners.length, before);
});

test('ready resolves and reports the height once', async () => {
  const { panel, posted } = boot({ docHeight: 700 });
  await panel.ready();
  assert.equal(posted.length, 1);
  assert.equal(posted[0].m.height, 700);
});

test('panel.mjs re-exports the same object the classic script created', async () => {
  const { panel } = boot();
  globalThis.panel = panel; // pretend the classic script already ran in this realm
  const mod = await import(pathToFileURL(fileURLToPath(new URL('./panel.mjs', import.meta.url))).href);
  assert.equal(mod.default, panel);
  assert.equal(mod.emit, panel.emit);
  assert.equal(typeof mod.on, 'function');
  delete globalThis.panel;
});

test('the SDK touches no storage API', () => {
  assert.doesNotMatch(SRC, /localStorage|sessionStorage|indexedDB|document\.cookie/);
});
