// Pure logic of the Agents scene: node --test web/builtin/agents-info/*.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CAPS, elapsedMs, formatDuration, formatTokens, layoutFor, legendOf, maxEventId, moodOf, moodOfAgent, newEvents, normalizeData, satellitesOf, shareOf, sortAgents, summaryOf, waitingLabelOf } from './agents-info-logic.mjs';
import { feedOf } from './list-view.js';

const agent = (over = {}) => ({ id: 'a', isMain: false, name: 'A', short: 'A', state: 'working', pct: 10, startedAt: 0, endedAt: null, tokens: 100, kind: 'logic', kindLabel: 'Logic', kindColor: '#7c9cff', kindGlyph: 'ƒ', headline: 'h', files: [], ...over });
const data = (over = {}) => ({ overall: 'working', mainKind: null, agents: [], events: [], updatedAt: 0, ...over });

test('normalizeData: garbage is "no agents, working", never a throw', () => {
  for (const raw of [null, undefined, 42, 'x', [], { agents: 'no' }, { agents: [null, 1, {}] }]) {
    const d = normalizeData(raw);
    assert.deepEqual(d.agents, []);
    assert.equal(d.overall, 'working');
  }
});

test('normalizeData: states, colors, percentages and caps are checked', () => {
  const d = normalizeData({
    overall: 'blocked',
    agents: [
      { id: 'x', state: 'working', pct: 250, kindColor: 'red', tokens: -5, files: ['a', 'b', 'c', 'd', 'e'] },
      { id: 'y', state: 'exploding' },
      { id: 'z', state: 'done', pct: -3, kindColor: '#12abEF', tokens: 1234.6 },
    ],
  });
  assert.equal(d.overall, 'blocked');
  assert.equal(d.agents.length, 2);
  const [x, z] = d.agents;
  assert.equal(x.pct, 100);
  assert.equal(x.kindColor, '#64748b');
  assert.equal(x.tokens, null);
  assert.equal(x.files.length, CAPS.files);
  assert.equal(z.pct, 0);
  assert.equal(z.kindColor, '#12abEF');
  assert.equal(z.tokens, 1235);
  const many = normalizeData({ agents: Array.from({ length: 30 }, (_, i) => ({ id: `a${i}`, state: 'working' })), events: Array.from({ length: 50 }, (_, i) => ({ id: i + 1, agent: 'a', kind: 'state' })) });
  assert.equal(many.agents.length, CAPS.agents);
  assert.equal(many.events.length, CAPS.events);
  assert.equal(many.events.at(-1).id, 50);
});

test('waiting with agents still running is "waiting for N agents", not "waiting for you"', () => {
  const d = data({ overall: 'waiting', agents: [agent({ id: 'a' }), agent({ id: 'b', state: 'testing' }), agent({ id: 'c', state: 'done' })] });
  assert.equal(waitingLabelOf(d), 'Waiting for 2 agents');
  assert.equal(moodOf(d), 'thinking');
  assert.equal(waitingLabelOf(data({ overall: 'waiting', agents: [agent({ id: 'a' })] })), 'Waiting for 1 agent');
  assert.equal(waitingLabelOf(data({ overall: 'waiting', agents: [agent({ state: 'done' })] })), '');
  assert.equal(moodOf(data({ overall: 'waiting', agents: [agent({ state: 'done' })] })), 'waiting');
});

test('moodOf: overall wins unless working; working needs something making calls, else thinking', () => {
  assert.equal(moodOf(data({ overall: 'blocked' })), 'blocked');
  assert.equal(moodOf(data({ overall: 'waiting' })), 'waiting');
  assert.equal(moodOf(data({ overall: 'done' })), 'done');
  assert.equal(moodOf(data({ agents: [agent({ kind: 'tests' })] })), 'working');
  assert.equal(moodOf(data({ agents: [agent({ state: 'testing', kind: 'ui' })] })), 'working');
  assert.equal(moodOf(data({ agents: [agent({ kind: 'thinking' })] })), 'thinking');
  assert.equal(moodOf(data({ agents: [agent({ state: 'waiting', kind: 'logic' })] })), 'thinking');
  assert.equal(moodOf(data({ agents: [agent({ state: 'done', kind: 'logic' })] })), 'thinking');
  assert.equal(moodOf(data({ agents: [agent({ kind: 'thinking' })], mainKind: 'delegating' })), 'working');
  assert.equal(moodOf(data()), 'thinking');
});

test('sortAgents: blocked, running, waiting, done; ties by start; the input is untouched', () => {
  const list = [agent({ id: 'd', state: 'done' }), agent({ id: 'w', state: 'waiting' }), agent({ id: 'r2', startedAt: 5 }), agent({ id: 'b', state: 'blocked' }), agent({ id: 'r1', state: 'testing', startedAt: 1 })];
  assert.deepEqual(sortAgents(list).map((a) => a.id), ['b', 'r1', 'r2', 'w', 'd']);
  assert.equal(list[0].id, 'd');
});

test('legendOf: only the kinds present, most agents first, agents without a kind left out', () => {
  const l = legendOf([agent({ kind: 'ui' }), agent({ kind: 'logic' }), agent({ kind: 'logic' }), agent({ kind: null })]);
  assert.deepEqual(l.map((k) => [k.kind, k.n]), [['logic', 2], ['ui', 1]]);
  assert.deepEqual(legendOf([agent({ kind: 'working' }), agent({ kind: 'thinking' })]), []);
  assert.deepEqual(legendOf([]), []);
});

test('formatDuration / formatTokens / elapsedMs', () => {
  assert.equal(formatDuration(42_000), '42 s');
  assert.equal(formatDuration(180_000), '3 min');
  assert.equal(formatDuration(200_000), '3 min 20 s');
  assert.equal(formatDuration(7_500_000), '2 h 05 min');
  assert.equal(formatDuration(-1), '');
  assert.equal(formatDuration(Number.NaN), '');
  assert.equal(formatTokens(850), '850');
  assert.equal(formatTokens(4250), '4.3k');
  assert.equal(formatTokens(42_400), '42k');
  assert.equal(formatTokens(1_200_000), '1.2M');
  assert.equal(formatTokens(0), '');
  assert.equal(formatTokens(null), '');
  assert.equal(elapsedMs(agent({ startedAt: 100, endedAt: 600 }), 9999), 500);
  assert.equal(elapsedMs(agent({ startedAt: 100 }), 1100), 1000);
  assert.equal(elapsedMs(agent({ startedAt: 100 }), 50), 0);
});

test('events: a first read marks all seen, later reads give only the new ones in order', () => {
  const ev = (id) => ({ id, agent: 'a', kind: 'state' });
  const events = [ev(5), ev(3), ev(9)];
  assert.equal(maxEventId(events), 9);
  assert.equal(maxEventId([]), 0);
  assert.deepEqual(newEvents(events, maxEventId(events)), []);
  assert.deepEqual(newEvents(events, 3).map((e) => e.id), [5, 9]);
});

test('layoutFor: side by side only on a wide pane', () => {
  assert.equal(layoutFor(1280, 900), 'side');
  assert.equal(layoutFor(720, 1280), 'stack');
  assert.equal(layoutFor(600, 300), 'stack');
  assert.equal(layoutFor(900, 900), 'stack');
});

test('summaryOf and feedOf', () => {
  assert.equal(summaryOf([agent(), agent({ state: 'testing' }), agent({ state: 'blocked' }), agent({ state: 'done' })]), '2 working · 1 blocked · 1 done');
  assert.equal(summaryOf([]), '');
  assert.equal(feedOf(agent({ headline: 'Writing UI', files: ['board.css'] })), 'Writing UI: board.css');
  assert.equal(feedOf(agent({ headline: 'Editing logic: a.ts', files: ['a.ts', 'b.ts'] })), 'Editing logic: a.ts, b.ts');
  assert.equal(feedOf(agent({ headline: 'Waiting', files: [] })), 'Waiting');
  assert.equal(feedOf(agent({ headline: '', kindLabel: 'Docs', files: ['x.md'] })), 'Docs: x.md');
});

test('the main session ("Me") is a row but not a satellite: first in the list whatever its state, left out of the crew counts', () => {
  const me = agent({ id: 'main', isMain: true, state: 'done', startedAt: 99 });
  const rows = [agent({ id: 'x', state: 'blocked' }), me, agent({ id: 'y', state: 'working' })];
  assert.deepEqual(sortAgents(rows).map((a) => a.id), ['main', 'x', 'y']);
  assert.deepEqual(satellitesOf(rows).map((a) => a.id), ['x', 'y']);
  assert.equal(summaryOf(rows), '1 working · 1 blocked');
  assert.equal(normalizeData({ agents: [{ id: 'main', isMain: true, state: 'working' }, { id: 'q', state: 'working', isMain: 'yes' }] }).agents.map((a) => a.isMain).join(), 'true,false');
});

test('moodOfAgent: the open agent drives the head: running (working or testing) is working, the rest as it is', () => {
  assert.equal(moodOfAgent(agent({ state: 'testing' })), 'working');
  for (const state of ['working', 'waiting', 'blocked', 'done']) assert.equal(moodOfAgent(agent({ state })), state === 'working' ? 'working' : state);
});

test('shareOf: relative to the largest, by tokens when any agent has them (none counts as 0), else by time; nothing at all is 0', () => {
  const rows = [agent({ id: 'a', tokens: 100 }), agent({ id: 'b', tokens: 50 }), agent({ id: 'c', tokens: null })];
  const byTokens = shareOf(rows, 1000);
  assert.deepEqual([byTokens.get('a'), byTokens.get('b'), byTokens.get('c')], [1, 0.5, 0]);
  const byTime = shareOf([agent({ id: 'a', tokens: null, startedAt: 0, endedAt: 100 }), agent({ id: 'b', tokens: null, startedAt: 0, endedAt: 25 })], 1000);
  assert.deepEqual([byTime.get('a'), byTime.get('b')], [1, 0.25]);
  assert.equal(shareOf([agent({ tokens: null, startedAt: 5, endedAt: 5 })], 5).get('a'), 0);
});

test('normalizeData: a ticket title and the call count are optional', () => {
  const d = normalizeData({ agents: [agent({ id: 'a', calls: 12.4, ticket: { id: '01-x', stage: 's', text: 't', title: 'Slugify text' } }), agent({ id: 'b', calls: -1 })] });
  assert.equal(d.agents[0].calls, 12);
  assert.equal(d.agents[0].ticket.title, 'Slugify text');
  assert.equal(d.agents[1].calls, null);
});

test('normalizeData: role and ticket are optional, cut to size, and null when absent or odd', () => {
  const [plain, withRole, odd] = normalizeData({
    agents: [
      agent({ id: 'p' }),
      agent({ id: 'r', role: 'verifier', ticket: { id: '01-slugify', stage: 'done', text: 'verified 4/4' } }),
      agent({ id: 'o', role: 7, ticket: { id: '', text: 'x' } }),
    ],
  }).agents;
  assert.equal(plain.role, null);
  assert.equal(plain.ticket, null);
  assert.equal(withRole.role, 'verifier');
  assert.deepEqual(withRole.ticket, { id: '01-slugify', stage: 'done', text: 'verified 4/4', title: '', harness: null });
  assert.equal(odd.role, null);
  assert.equal(odd.ticket, null);
  assert.equal(normalizeData({ agents: [agent({ role: 'x'.repeat(40) })] }).agents[0].role.length <= CAPS.role, true);
});

test('normalizeData: harness, model and effort are optional strings (agent, and the ticket for the harness)', () => {
  const d = normalizeData({ agents: [agent({ id: 'a', harness: ' codex ', model: 'gpt-6.1-sol', effort: 'high', ticket: { id: 'x', stage: 's', text: 't', harness: 'agy' } }), agent({ id: 'b' }), agent({ id: 'c', harness: 7, model: '' })] });
  assert.deepEqual([d.agents[0].harness, d.agents[0].model, d.agents[0].effort, d.agents[0].ticket.harness], ['codex', 'gpt-6.1-sol', 'high', 'agy']);
  assert.deepEqual([d.agents[1].harness, d.agents[1].model, d.agents[1].effort], [null, null, null]);
  assert.deepEqual([d.agents[2].harness, d.agents[2].model], [null, null]);
});
