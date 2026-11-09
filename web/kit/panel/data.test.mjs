// panel.data(): the live/data.json poll, run inside a vm with a fake fetch, fake timers and a fake document (no DOM, no network).
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('./panel.js', import.meta.url), 'utf8');
const EVERY_DEFAULT = 1000;
const EVERY_MIN = 250;
const EVERY_MAX = 10000;

/** `replies`: a queue of fetch answers: a string (200 + text), a number (that status) or an Error (network failure). */
function boot(replies = []) {
  const timers = new Map(); // id -> {fn, ms}
  const fetched = [];
  const doc = { hidden: false, handlers: [], readyState: 'complete', documentElement: {}, body: {}, fonts: { ready: Promise.resolve() } };
  doc.addEventListener = (t, fn) => doc.handlers.push({ t, fn });
  doc.removeEventListener = (t, fn) => { doc.handlers = doc.handlers.filter((h) => h.fn !== fn); };
  let nextId = 1;
  const ctx = {
    window: { parent: { postMessage() {} }, addEventListener() {}, removeEventListener() {} },
    document: doc, console: { error() {} }, TextEncoder, JSON, Math, Promise, isFinite, Number, Date,
    fetch: async (url, init) => {
      fetched.push({ url, init });
      const r = replies.shift();
      if (r instanceof Error) throw r;
      if (typeof r === 'number') return { ok: false, status: r, text: async () => '' };
      return { ok: true, status: 200, text: async () => r };
    },
    setTimeout: (fn, ms) => { const id = nextId++; timers.set(id, { fn, ms }); return id; },
    clearTimeout: (id) => { timers.delete(id); },
  };
  vm.runInNewContext(SRC, ctx);
  /** Run the pending timer(s) and let the promise chains settle. */
  const fire = async () => {
    const due = [...timers.entries()];
    due.forEach(([id]) => timers.delete(id));
    due.forEach(([, t]) => t.fn());
    await settle();
  };
  const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
  const setHidden = async (hidden) => { doc.hidden = hidden; doc.handlers.filter((h) => h.t === 'visibilitychange').forEach((h) => h.fn()); await settle(); };
  const delays = () => [...timers.values()].map((t) => t.ms);
  return { panel: ctx.window.panel, fetched, replies, fire, settle, setHidden, delays, timers, doc };
}

test('the first successful read calls back at once; later reads only when the JSON text changed', async () => {
  const t = boot(['{"n":1}', '{"n":1}', '{"n":2}', '{"n":2}']);
  const got = [];
  t.panel.data((v) => got.push(v));
  await t.settle();
  assert.deepEqual(JSON.parse(JSON.stringify(got)), [{ n: 1 }]);
  await t.fire(); // same text
  assert.equal(got.length, 1);
  await t.fire(); // changed
  await t.fire(); // same again
  assert.deepEqual(JSON.parse(JSON.stringify(got)), [{ n: 1 }, { n: 2 }]);
  assert.equal(JSON.stringify(t.panel.data.last()), '{"n":2}');
});

test('the request is live/data.json?t=<ms> with cache no-store', async () => {
  const t = boot(['1']);
  t.panel.data(() => {});
  await t.settle();
  assert.match(t.fetched[0].url, /^live\/data\.json\?t=\d+$/);
  assert.equal(t.fetched[0].init.cache, 'no-store');
});

test('404, a network error and invalid JSON keep the last value and keep polling', async () => {
  const t = boot([404, '{"a":1}', 500, new Error('offline'), '{"a":', '{"a":2}']);
  const got = [];
  assert.equal(t.panel.data.last(), undefined);
  t.panel.data((v) => got.push(v.a));
  await t.settle();
  assert.deepEqual(got, []); // 404: nothing written yet
  assert.equal(t.panel.data.last(), undefined);
  await t.fire();
  assert.deepEqual(got, [1]);
  await t.fire(); // 500
  await t.fire(); // offline
  await t.fire(); // half-written JSON
  assert.deepEqual(got, [1]);
  assert.equal(t.panel.data.last().a, 1);
  await t.fire();
  assert.deepEqual(got, [1, 2]);
  assert.equal(t.timers.size, 1, 'still scheduled');
});

test('opts.every: default 1000 ms, clamped to 250..10000, junk falls back to the default', async () => {
  const delayFor = async (opts) => {
    const t = boot(['1']);
    t.panel.data(() => {}, opts);
    await t.settle();
    return t.delays();
  };
  assert.deepEqual(await delayFor(undefined), [EVERY_DEFAULT]);
  assert.deepEqual(await delayFor({}), [EVERY_DEFAULT]);
  assert.deepEqual(await delayFor({ every: 2000 }), [2000]);
  assert.deepEqual(await delayFor({ every: 10 }), [EVERY_MIN]);
  assert.deepEqual(await delayFor({ every: 0 }), [EVERY_MIN]);
  assert.deepEqual(await delayFor({ every: 99999 }), [EVERY_MAX]);
  assert.deepEqual(await delayFor({ every: 'fast' }), [EVERY_DEFAULT]);
  assert.deepEqual(await delayFor({ every: null }), [EVERY_DEFAULT]);
  assert.deepEqual(await delayFor({ every: NaN }), [EVERY_DEFAULT]);
});

test('it pauses while the document is hidden and resumes (with an immediate read) when it is shown', async () => {
  const t = boot(['{"v":1}', '{"v":2}', '{"v":3}']);
  const got = [];
  t.panel.data((v) => got.push(v.v));
  await t.settle();
  await t.setHidden(true);
  assert.equal(t.timers.size, 0, 'the timer is cleared');
  await t.fire();
  assert.equal(t.fetched.length, 1, 'nothing fetched while hidden');
  await t.setHidden(false);
  assert.deepEqual(got, [1, 2], 'an immediate read on return');
  assert.equal(t.timers.size, 1);
});

test('a request that ends while hidden does not reschedule', async () => {
  const t = boot(['{"v":1}']);
  t.panel.data(() => {});
  t.doc.hidden = true; // hidden before the answer lands (the first tick was already sent)
  await t.settle();
  assert.equal(t.timers.size, 0);
});

test('stop() ends the polling and the visibility listener; a second subscription starts fresh', async () => {
  const t = boot(['{"v":1}', '{"v":1}']);
  const got = [];
  const stop = t.panel.data((v) => got.push(v.v));
  await t.settle();
  stop();
  assert.equal(t.timers.size, 0);
  assert.equal(t.doc.handlers.length, 0);
  await t.fire();
  assert.equal(t.fetched.length, 1);
  t.panel.data((v) => got.push(v.v * 10)); // new subscription: its first read calls back even with the same text
  await t.settle();
  assert.deepEqual(got, [1, 10]);
});

test('a throwing callback does not stop the polling', async () => {
  const t = boot(['{"v":1}', '{"v":2}']);
  const got = [];
  t.panel.data((v) => { got.push(v.v); throw new Error('boom'); });
  await t.settle();
  await t.fire();
  assert.deepEqual(got, [1, 2]);
});

test('panel.mjs exports data', () => {
  assert.match(readFileSync(new URL('./panel.mjs', import.meta.url), 'utf8'), /export const \{[^}]*\bdata\b[^}]*\} = sdk/);
});
