// router-frames-logic.test.mjs - tickets / checks: what the page keeps, which look a ticket gets (verified vs claimed), heights, grid.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROUTER_CAPS, afterText, evalChipOf, fixRoundText, lookOf, normalizeChecks, normalizeTickets, proofText, roundText, routerBodyPx, verifiedText } from './router-frames-logic.mjs';
import { LIST_TYPES, listBodyPx, minSizeFor } from './grid-plan.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => JSON.parse(readFileSync(join(here, 'fixtures', `${name}.json`), 'utf8'));

test('only done + PASS + a passed eval is verified; a bare done is flagged, not trusted', () => {
  assert.equal(lookOf('done', 'PASS', 'pass', true), 'verified');
  assert.equal(lookOf('done', 'PASS'), 'unproven'); // a PASS without an eval is never plainly done
  assert.equal(lookOf('done', 'PASS', 'pass', false), 'unproven');
  assert.equal(lookOf('done', 'PASS', 'fail', true), 'unproven');
  assert.equal(lookOf('unproven', 'PASS'), 'unproven');
  assert.equal(lookOf('done', null), 'done');
  assert.equal(lookOf('done', 'FAIL'), 'done');
  assert.equal(lookOf('unverified', 'PASS'), 'unverified');
  assert.equal(lookOf('nonsense', null), 'draft');
});

test('normalizeTickets cleans items and keeps the mod summary', () => {
  const t = normalizeTickets({ summary: { total: 9, verified: 2 }, items: [
    { id: '01', title: 'A', stage: 'done', verdict: 'PASS', eval: { present: true, what: 'Tests pass', result: 'pass' }, checks: { pass: 9, total: 4 }, dependsOn: ['00'] },
    { id: '02', title: 'B', stage: 'fixing', round: 1, maxRounds: 2, agent: 'worker' }, 'junk', { id: '', title: '' },
  ] });
  assert.equal(t.items.length, 2);
  assert.deepEqual(t.items[0].checks, { pass: 4, total: 4 }); // pass is capped at total
  assert.equal(t.items[0].look, 'verified');
  assert.equal(verifiedText(t.summary), '2 of 9 verified');
  assert.equal(roundText(t.items[1]), 'round 1/2');
  assert.equal(roundText(t.items[0]), '');
  assert.equal(afterText(t.items[0]), 'after 00');
  assert.equal(t.items.length <= ROUTER_CAPS.items, true);
});

test('summary falls back to counting the items', () => {
  const t = normalizeTickets({ items: [{ id: '1', title: 'a', stage: 'unverified' }, { id: '2', title: 'b', stage: 'blocked' }, { id: '3', title: 'c', stage: 'verifying' }] });
  assert.deepEqual(t.summary, { total: 3, verified: 0, unproven: 0, unverified: 1, blocked: 1, inflight: 1 });
});

test('normalizeChecks: tri-state marks, counts, round text', () => {
  const c = normalizeChecks({ result: 'FAIL', round: 1, maxRounds: 2, items: [{ item: 'a', pass: true }, { item: 'b', pass: false, evidence: 'x'.repeat(999) }, { item: 'c' }, { item: '' }] });
  assert.deepEqual(c.items.map((i) => i.pass), [true, false, null]);
  assert.equal(c.passed, 1);
  assert.ok(c.items[1].evidence.length <= ROUTER_CAPS.evidence);
  assert.equal(fixRoundText(c), 'fix round 1 of 2');
  assert.equal(normalizeChecks({ result: 'maybe', items: [] }).result, null);
});

test('heights and grid: list types, compact is shorter, size grows with rows', () => {
  const f = fixture('router-run');
  for (const type of ['tickets', 'checks']) {
    const frame = f.frames.find((x) => x.type === type);
    assert.ok(LIST_TYPES.has(type));
    assert.ok(routerBodyPx(frame) > routerBodyPx(frame, { compact: true }) && routerBodyPx(frame, { compact: true }) > 0);
    assert.equal(listBodyPx(frame), routerBodyPx(frame));
  }
  assert.equal(routerBodyPx({ type: 'text' }), 0);
  assert.equal(minSizeFor({ type: 'tickets', items: [{}, {}] }), 'm');
  assert.equal(minSizeFor({ type: 'tickets', items: [{}, {}, {}, {}, {}] }), 'l');
});

test('a dependency is named by its ticket title, not its id', () => {
  const { items } = normalizeTickets({ items: [{ id: '01-schema', title: 'Booking tables', stage: 'done' }, { id: '02-api', title: 'API', stage: 'ready', dependsOn: ['01-schema', 'x'] }] });
  assert.deepEqual(items[1].after, ['Booking tables', 'x']);
  assert.equal(afterText(items[1]), 'after Booking tables, x');
});

const row = (over) => normalizeTickets({ items: [{ id: 'x', title: 'Login', stage: 'done', verdict: 'PASS', ...over }] }).items[0];

test('proof: a done row with a passed eval shows "Eval passed: <what>", no chip', () => {
  const it = row({ eval: { present: true, what: 'Magic link signs in', result: 'pass', evidence: '4 of 4' } });
  assert.equal(it.look, 'verified');
  assert.equal(proofText(it), 'Eval passed: Magic link signs in');
  assert.equal(evalChipOf(it), null);
});

test('proof: done without an eval is unproven with a "no eval" warn chip and no proof line', () => {
  for (const it of [row({}), row({ eval: { present: false, result: 'none' } }), row({ eval: { present: true, what: '', result: 'pass' } })]) {
    assert.equal(it.look, 'unproven');
    assert.deepEqual(evalChipOf(it), { text: 'no eval', tone: 'warn' });
    assert.equal(proofText(it), '');
  }
});

test('proof: an eval that failed or did not run is "eval not passed" (failed: danger, not run: warn); never a proof line', () => {
  const failed = row({ stage: 'unproven', eval: { present: true, what: 'Fits one page', result: 'fail' } });
  assert.deepEqual(evalChipOf(failed), { text: 'eval not passed', tone: 'danger' });
  assert.equal(proofText(failed), '');
  const stale = row({ eval: { present: true, what: 'Fits one page', result: 'none' } });
  assert.equal(stale.look, 'unproven');
  assert.deepEqual(evalChipOf(stale), { text: 'eval not passed', tone: 'warn' });
  const claimed = row({ stage: 'unverified', eval: { present: true, what: 'Fits one page', result: 'fail' } });
  assert.deepEqual(evalChipOf(claimed), { text: 'eval not passed', tone: 'danger' });
});

test('proof: a row that is still in flight carries no proof chip; an odd eval is "no eval"', () => {
  assert.equal(evalChipOf(row({ stage: 'building', verdict: null })), null);
  assert.deepEqual(evalChipOf(row({ eval: 'junk' })), { text: 'no eval', tone: 'warn' });
  const long = row({ eval: { present: true, what: 'w'.repeat(200), result: 'pass' } });
  assert.ok(long.proof.what.length <= ROUTER_CAPS.evalWhat);
});

test('proof: the unproven count is the mod\'s, else counted; the proof fixture shows all three states', () => {
  const t = normalizeTickets(fixture('router-proof').frames.find((f) => f.type === 'tickets'));
  assert.equal(t.summary.unproven, 2);
  assert.equal(t.summary.verified, 1);
  const byTitle = Object.fromEntries(t.items.map((it) => [it.title, it]));
  assert.equal(proofText(byTitle['Login with email link']), 'Eval passed: Magic link signs in and expires after use');
  assert.equal(evalChipOf(byTitle['Export bookings to CSV']).text, 'no eval');
  assert.equal(evalChipOf(byTitle['Invoice PDF layout']).text, 'eval not passed');
  assert.equal(normalizeTickets({ items: [{ id: 'a', title: 'a', stage: 'done', verdict: 'PASS' }] }).summary.unproven, 1);
});
