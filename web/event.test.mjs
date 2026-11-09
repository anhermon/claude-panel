// POST /<token>/event: the return channel (spec v4 section 4 + addenda), the events file, and the stage fixture in /state.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  eventsFileFor, createEventLog, createRateLimiter, MAX_BODY_BYTES, MAX_DATA_BYTES, RATE_LIMIT_PER_WINDOW, TRIM_ABOVE_LINES, KEEP_LINES, CLIPPED_DATA,
} from './scene-events.mjs';
import { startServer, sleep, HERE, TEST_TOKEN } from './testkit.mjs';

const RATE_SETTLE_MS = 1100; // a little over the 1 s rate window
const dir = mkdtempSync(join(tmpdir(), 'panel-event-'));
const procs = [];
after(() => { for (const p of procs) p.kill(); rmSync(dir, { recursive: true, force: true }); });

const JSON_HEADERS = { 'content-type': 'application/json' };
const lines = (file) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

// A fresh server per group of tests (the rate limit is global per server): scenes `deck` and `lab`.
async function fresh(name, { seed = '' } = {}) {
  const stateFile = join(dir, `${name}.json`);
  const sceneDir = join(dir, `${name}-scene`);
  mkdirSync(sceneDir, { recursive: true });
  writeFileSync(join(sceneDir, 'index.html'), '<p>x</p>');
  writeFileSync(stateFile, JSON.stringify({ v: 4, rev: 1, scenes: [{ id: 'deck', dir: sceneDir, alt: 'd', rev: 1 }, { id: 'lab', dir: sceneDir, alt: 'l', rev: 1 }] }));
  const events = join(dir, `${name}.events.jsonl`);
  if (seed) writeFileSync(events, seed);
  const s = await startServer(stateFile, { procs });
  const post = (body, { headers = JSON_HEADERS, origin = s.origin, ...rest } = {}) =>
    s.api('/event', { method: 'POST', headers: { ...(origin === null ? {} : { origin }), ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body), ...rest });
  return { s, post, events, stateFile };
}
const ok = (scene = 'deck', name = 'clicked', data = { a: 1 }) => ({ scene, name, data });

test('eventsFileFor: a trailing .json becomes .events.jsonl', () => {
  assert.equal(eventsFileFor('/x/panel-abc.json'), '/x/panel-abc.events.jsonl');
  assert.equal(eventsFileFor('/x/state'), '/x/state.events.jsonl');
  assert.equal(eventsFileFor('/x/a.json.json'), '/x/a.json.events.jsonl');
});

test('happy path: 200 {n}, one JSON line {n,t,scene,name,data} appended, n counts up; _ask is accepted', async () => {
  const { s, post, events } = await fresh('happy');
  const before = Date.now();
  const r = await post(ok('deck', 'quiz.answer', { pick: 'b', nested: { list: [1, 2] } }));
  assert.equal(r.status, 200);
  assert.deepEqual(JSON.parse(r.text), { n: 1 });
  assert.match(r.headers['content-type'], /^application\/json/);
  assert.equal((await post(ok('lab', 'x'))).text, '{"n":2}');
  assert.equal(JSON.parse((await post({ scene: '_ask', name: 'answer', data: { id: 'both', label: 'Retry 429 and 503' } })).text).n, 3);
  const got = lines(events);
  assert.equal(got.length, 3);
  assert.deepEqual(Object.keys(got[0]), ['n', 't', 'scene', 'name', 'data']);
  assert.deepEqual(got.map((e) => e.n), [1, 2, 3]);
  assert.ok(got[0].t >= before && got[0].t <= Date.now());
  assert.deepEqual(got[0].data, { pick: 'b', nested: { list: [1, 2] } });
  assert.deepEqual(got[2], { n: 3, t: got[2].t, scene: '_ask', name: 'answer', data: { id: 'both', label: 'Retry 429 and 503' } });
  assert.equal((await post({ scene: 'deck', name: 'no-data' })).status, 200);
  assert.equal(lines(events).at(-1).data, null, 'a missing data field is stored as null');
  s.kill();
});

test('Origin rule: exactly the server origin passes; Origin null, other origins, localhost and a cross-site fetch are 403 and write nothing', async () => {
  const { s, post, events } = await fresh('origin');
  assert.equal((await post(ok())).status, 200, 'Origin = ORIGIN (the host page)');
  assert.equal((await post(ok(), { origin: null })).status, 200, 'no Origin and no fetch metadata (curl)');
  assert.equal((await post(ok(), { origin: null, headers: { ...JSON_HEADERS, 'sec-fetch-site': 'same-origin' } })).status, 200);
  const count = lines(events).length;
  for (const origin of ['null', 'http://evil.example', `http://localhost:${s.port}`, `${s.origin}/`, `${s.origin}.evil.example`, 'https://127.0.0.1:1', '']) {
    const r = await post(ok(), { origin });
    assert.equal(r.status, 403, JSON.stringify(origin));
    assert.equal(r.headers['access-control-allow-origin'], undefined);
  }
  for (const site of ['cross-site', 'same-site', 'none']) {
    assert.equal((await post(ok(), { origin: null, headers: { ...JSON_HEADERS, 'sec-fetch-site': site } })).status, 403, `no Origin + Sec-Fetch-Site ${site}`);
  }
  assert.equal(lines(events).length, count, 'rejected requests append nothing');
  s.kill();
});

test('Content-Type must be application/json (charset parameter fine); anything else is 415', async () => {
  const { s, post, events } = await fresh('ctype');
  assert.equal((await post(ok(), { headers: { 'content-type': 'application/json; charset=utf-8' } })).status, 200);
  assert.equal((await post(ok(), { headers: { 'content-type': 'Application/JSON' } })).status, 200);
  for (const ct of ['text/plain', 'application/x-www-form-urlencoded', 'application/jsonx', 'multipart/form-data; boundary=x', 'text/json']) {
    assert.equal((await post(ok(), { headers: { 'content-type': ct } })).status, 415, ct);
  }
  assert.equal((await post(ok(), { headers: {} })).status, 415, 'no Content-Type');
  assert.equal(lines(events).length, 2);
  s.kill();
});

test('body size: <= 4096 bytes passes, more is 413 (declared or streamed); data over 2048 bytes is replaced by {"_clipped":true}', async () => {
  assert.equal(MAX_BODY_BYTES, 4096);
  assert.equal(MAX_DATA_BYTES, 2048);
  const { s, post, events } = await fresh('size');
  const envelope = JSON.stringify({ scene: 'deck', name: 'big', data: '' }).length;
  const exact = JSON.stringify({ scene: 'deck', name: 'big', data: 'x'.repeat(MAX_BODY_BYTES - envelope) });
  assert.equal(Buffer.byteLength(exact), MAX_BODY_BYTES);
  const atLimit = await post(exact);
  assert.equal(atLimit.status, 200);
  assert.deepEqual(lines(events).at(-1).data, CLIPPED_DATA, 'a 4 KiB payload is accepted but its data is clipped');
  const over = await post(JSON.stringify({ scene: 'deck', name: 'big', data: 'x'.repeat(MAX_BODY_BYTES) }));
  assert.equal(over.status, 413);
  assert.equal(over.headers['access-control-allow-origin'], undefined);
  assert.equal((await post(exact + ' '.repeat(10))).status, 413);
  assert.equal(lines(events).length, 1, '413 writes nothing');
  const edge = (len) => post({ scene: 'deck', name: 'edge', data: 'y'.repeat(len) });
  const justFits = MAX_DATA_BYTES - 2; // the two JSON quotes count
  assert.equal((await edge(justFits)).status, 200);
  assert.equal(lines(events).at(-1).data.length, justFits, 'exactly 2048 bytes of data is kept');
  assert.equal((await edge(justFits + 1)).status, 200);
  assert.deepEqual(lines(events).at(-1).data, CLIPPED_DATA, '2049 bytes is clipped');
  s.kill();
});

test('validation: bad JSON / shape / name / scene id are 400, an unknown scene is 404; nothing is written', async () => {
  const { s, post, events } = await fresh('valid');
  const calm = () => sleep(RATE_SETTLE_MS); // the 20/s limit is global: keep each batch under it
  for (const body of ['', 'not json', '{"scene":', '[]', '"deck"', 'null', '42']) assert.equal((await post(body)).status, 400, JSON.stringify(body));
  for (const name of ['', 'Upper', 'has space', 'a/b', 'x'.repeat(41), 'ünï', 'new\nline', 5, null, ['a'], { a: 1 }, undefined]) {
    assert.equal((await post({ scene: 'deck', name })).status, 400, `name ${JSON.stringify(name)}`);
  }
  await calm();
  for (const name of ['a', 'x'.repeat(40), 'deck.slide_3-4', '0.1']) assert.equal((await post({ scene: 'deck', name })).status, 200, `name ${name}`);
  for (const scene of [undefined, null, 5, '', 'DECK', 'a b', '../deck', 'x'.repeat(25), '_other', ['deck']]) {
    assert.equal((await post({ scene, name: 'ok' })).status, 400, `scene ${JSON.stringify(scene)}`);
  }
  await calm();
  for (const scene of ['nope', 'deck2', 'a'.repeat(24)]) assert.equal((await post({ scene, name: 'ok' })).status, 404, `scene ${scene}`);
  assert.equal(lines(events).length, 4, 'only the four valid names were written');
  s.kill();
});

test('rate limit: 20 events per second globally, then 429; the window slides open again', async () => {
  assert.equal(RATE_LIMIT_PER_WINDOW, 20);
  const { s, post, events } = await fresh('rate');
  const results = await Promise.all(Array.from({ length: 30 }, () => post(ok())));
  const statuses = results.map((r) => r.status);
  assert.equal(statuses.filter((c) => c === 200).length, 20, JSON.stringify(statuses));
  assert.equal(statuses.filter((c) => c === 429).length, 10);
  assert.ok(results.find((r) => r.status === 429).headers['retry-after']);
  assert.equal(lines(events).length, 20);
  assert.deepEqual(lines(events).map((e) => e.n), Array.from({ length: 20 }, (_, i) => i + 1), 'n is gapless even under concurrency');
  await sleep(RATE_SETTLE_MS);
  assert.equal((await post(ok())).status, 200);
  s.kill();

  let t = 0;
  const allow = createRateLimiter({ limit: 2, windowMs: 100, now: () => t });
  assert.deepEqual([allow(), allow(), allow()], [true, true, false]);
  t = 99; assert.equal(allow(), false);
  t = 100; assert.equal(allow(), true);
});

test('no CORS surface on the route: no ACAO on any answer, OPTIONS is 405, other methods are 405 with Allow: POST', async () => {
  const { s, post } = await fresh('cors');
  const answers = [await post(ok()), await post(ok(), { origin: 'null' }), await post('{', {}), await post(ok(), { headers: {} }), await s.api('/event', { method: 'OPTIONS' })];
  for (const r of answers) {
    for (const h of Object.keys(r.headers)) assert.doesNotMatch(h, /^access-control-/, `${r.status} ${h}`);
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
  }
  const preflight = await s.api('/event', { method: 'OPTIONS', headers: { origin: 'http://evil.example', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' } });
  assert.equal(preflight.status, 405);
  assert.equal(preflight.headers['access-control-allow-origin'], undefined);
  for (const method of ['GET', 'HEAD', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']) {
    const r = await s.api('/event', { method });
    assert.equal(r.status, 405, method);
    assert.equal(r.headers.allow, 'POST', method);
  }
  // the rest of the server keeps its rules: other routes are still GET/HEAD only
  const other = await s.api('/state', { method: 'POST' });
  assert.equal(other.status, 405);
  assert.equal(other.headers.allow, 'GET, HEAD');
  s.kill();
});

test('token and Host come first: no/wrong token is 404, wrong Host is 421, for every method; /event/ and /event/x are not the route', async () => {
  const { s, post, events } = await fresh('gate');
  const body = JSON.stringify(ok());
  const opts = { method: 'POST', headers: { ...JSON_HEADERS, origin: s.origin }, body };
  for (const p of ['/event', '/wrong/event', `/${TEST_TOKEN}x/event`, `//${TEST_TOKEN}/event`, '/%74esttoken0123456789/event']) {
    assert.equal((await s.get(p, opts)).status, 404, p);
    assert.equal((await s.get(p, { method: 'OPTIONS', headers: opts.headers })).status, 404, `OPTIONS ${p}`);
  }
  assert.equal((await post(ok(), { host: 'evil.example' })).status, 421);
  assert.equal((await post(ok(), { host: `localhost:${s.port}` })).status, 200, 'localhost Host passes the Host check (Origin still has to be the server origin)');
  for (const p of ['/event/', '/event/x', '/events', '/Event', '/event%2f']) {
    const r = await s.api(p, opts);
    assert.ok([404, 405].includes(r.status), `${p} -> ${r.status}`);
    assert.equal(r.headers['access-control-allow-origin'], undefined);
  }
  assert.equal(lines(events).length, 1);
  s.kill();
});

test('events file: counter continues from the existing file, picks up lines the mod appended itself, never glues lines', async () => {
  const seed = [1, 2, 3].map((n) => JSON.stringify({ n, t: 1, scene: '_ask', name: 'answer', data: null })).join('\n') + '\n';
  const { s, post, events } = await fresh('continue', { seed });
  assert.equal(JSON.parse((await post(ok())).text).n, 4, 'continues after the 3 existing lines');
  appendFileSync(events, JSON.stringify({ n: 5, t: 2, scene: '_ask', name: 'answer', data: { id: 'x' } }) + '\n'); // the mod's own writer
  assert.equal(JSON.parse((await post(ok())).text).n, 6, 'sees the line another writer added');
  appendFileSync(events, JSON.stringify({ n: 7, t: 3, scene: '_ask', name: 'answer', data: null })); // no trailing newline
  assert.equal(JSON.parse((await post(ok())).text).n, 8);
  assert.deepEqual(lines(events).map((e) => e.n), [1, 2, 3, 4, 5, 6, 7, 8], 'every line is separate valid JSON');
  s.kill();
});

test('events file trimming: past 1000 lines it is cut to the last 200, n keeps counting, over HTTP and in the unit', async () => {
  assert.equal(TRIM_ABOVE_LINES, 1000);
  assert.equal(KEEP_LINES, 200);
  const seed = Array.from({ length: TRIM_ABOVE_LINES }, (_, i) => JSON.stringify({ n: i + 1, t: 1, scene: 'deck', name: 'seed', data: null })).join('\n') + '\n';
  const { s, post, events } = await fresh('trim', { seed });
  assert.equal(lines(events).length, TRIM_ABOVE_LINES, 'exactly 1000 lines is not past the limit');
  assert.equal(JSON.parse((await post(ok())).text).n, TRIM_ABOVE_LINES + 1);
  const trimmed = lines(events);
  assert.equal(trimmed.length, KEEP_LINES);
  assert.equal(trimmed[0].n, TRIM_ABOVE_LINES + 1 - (KEEP_LINES - 1), 'the last 200 lines survive');
  assert.equal(trimmed.at(-1).n, TRIM_ABOVE_LINES + 1, 'the new event is the last line');
  assert.equal(JSON.parse((await post(ok())).text).n, TRIM_ABOVE_LINES + 2, 'n does not restart after the trim');
  assert.ok(!existsSync(`${events}.tmp`), 'no temp file is left behind');
  s.kill();

  // a restarted server continues from the last line's n, not from the (smaller) line count
  const again = await startServer(join(dir, 'trim.json'), { procs });
  const r = await again.api('/event', { method: 'POST', headers: { ...JSON_HEADERS, origin: again.origin }, body: JSON.stringify(ok()) });
  assert.equal(JSON.parse(r.text).n, TRIM_ABOVE_LINES + 3);
  again.kill();

  const file = join(dir, 'unit.events.jsonl');
  const log = createEventLog(file, { now: () => 42 });
  for (let i = 1; i <= TRIM_ABOVE_LINES + 5; i++) log.append({ scene: 'deck', name: 'tick', data: i });
  const all = lines(file);
  assert.ok(all.length <= TRIM_ABOVE_LINES && all.length >= KEEP_LINES, `${all.length}`);
  assert.equal(all.at(-1).n, TRIM_ABOVE_LINES + 5);
  assert.deepEqual(all.at(-1), { n: TRIM_ABOVE_LINES + 5, t: 42, scene: 'deck', name: 'tick', data: TRIM_ABOVE_LINES + 5 });
  assert.deepEqual(all.map((e) => e.n), all.map((_, i) => all[0].n + i), 'surviving lines are contiguous');
});

test('an unwritable events file is a 500 for that request only; the server keeps serving', async () => {
  const { s, post, stateFile } = await fresh('nowrite');
  rmSync(join(dir, 'nowrite.events.jsonl'), { force: true });
  mkdirSync(join(dir, 'nowrite.events.jsonl')); // a directory where the file should be
  const r = await post(ok());
  assert.equal(r.status, 500);
  assert.doesNotMatch(r.text, new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'no path in the error');
  assert.equal((await s.api('/state')).status, 200);
  assert.ok(stateFile);
  s.kill();
});

test('/state and /events for the stage fixture: scene layout and top-level choices reach the page, dir never does', async () => {
  const s = await startServer(join(HERE, 'sample-stage-state.json'), { procs });
  const state = JSON.parse((await s.api('/state')).text);
  assert.equal(state.v, 4);
  assert.deepEqual(state.scenes.map((x) => [x.id, x.layout]), [['deck', 'stage']]);
  assert.deepEqual(state.choices.map((c) => c.id), ['both', 'only503']);
  assert.equal(state.ask, 'Should retries also cover 429 responses, or only 503?');
  const raw = (await s.api('/state')).text;
  for (const forbidden of ['"dir"', '"entry"', 'sample-scenes', '"image"', '"html"']) assert.ok(!raw.includes(forbidden), forbidden);
  s.kill();
});
