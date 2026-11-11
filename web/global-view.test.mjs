import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGlobalView, heuristicNeeds, jiraGroups, stateOf, STALL_MS } from './global/view.mjs';
import { parsePs } from './global/registry.mjs';
import { itemsFromHtml } from './global/board.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'global-view-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));
const HOUR = 3600_000;
const sid = (n) => `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`;
// Built from fragments so secret scanners do not flag this file; the value is fake.
const FAKE_TOKEN = 'ghp_' + 'abcdefghijklmnopqrstuvwxyz0123';

let fixture = 0;
/** A fresh claude dir + state dir. */
function env() {
  const dir = path.join(root, `f${fixture++}`);
  const claude = path.join(dir, 'claude');
  const state = path.join(dir, 'state');
  fs.mkdirSync(path.join(claude, 'projects'), { recursive: true });
  fs.mkdirSync(path.join(claude, 'sessions'), { recursive: true });
  fs.mkdirSync(state, { recursive: true });
  return { claude, state, now: Date.now() };
}
const ts = (ms) => new Date(ms).toISOString();
const user = (text, at, extra = {}) => ({ type: 'user', timestamp: ts(at), message: { role: 'user', content: text }, ...extra });
const say = (text, at, extra = {}) => ({ type: 'assistant', timestamp: ts(at), message: { role: 'assistant', model: 'claude-x', content: [{ type: 'text', text }] }, ...extra });
const tool = (id, name, input, at) => ({ type: 'assistant', timestamp: ts(at), message: { role: 'assistant', model: 'claude-x', content: [{ type: 'tool_use', id, name, input }] } });
const result = (id, at, extra = {}) => ({ type: 'user', timestamp: ts(at), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] }, ...extra });

/** Writes a session transcript whose mtime is `ageMs` before now. */
function transcript(e, n, rows, { ageMs = 0, slug = '-Users-u-proj', cwd = '/Users/u/proj', branch = 'main' } = {}) {
  const dir = path.join(e.claude, 'projects', slug);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sid(n)}.jsonl`);
  fs.writeFileSync(file, rows.map((r) => JSON.stringify({ cwd, gitBranch: branch, sessionId: sid(n), ...r })).join('\n') + '\n');
  const t = new Date(e.now - ageMs);
  fs.utimesSync(file, t, t);
  return { file, dir };
}
function subagent(e, n, agent, rows, meta, ageMs = 0, slug = '-Users-u-proj') {
  const dir = path.join(e.claude, 'projects', slug, sid(n), 'subagents');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `agent-${agent}.jsonl`);
  fs.writeFileSync(file, rows.map((r) => JSON.stringify({ isSidechain: true, ...r })).join('\n') + '\n');
  fs.writeFileSync(path.join(dir, `agent-${agent}.meta.json`), JSON.stringify(meta));
  const t = new Date(e.now - ageMs);
  fs.utimesSync(file, t, t);
}
/** Registers `pids` as live Claude processes: { n: status }. */
function live(e, map) {
  const lines = [];
  for (const [n, status] of Object.entries(map)) {
    const pid = 1000 + Number(n);
    fs.writeFileSync(path.join(e.claude, 'sessions', `${pid}.json`), JSON.stringify({ pid, sessionId: sid(Number(n)), status, cwd: '/Users/u/proj', startedAt: e.now - HOUR }));
    lines.push(` ${pid}     1 Thu Nov  5 09:34:30 2026 /x/bin/claude --session-id ${sid(Number(n))}`);
  }
  return () => Promise.resolve(parsePs(lines.join('\n')));
}
const view = (e, scan, opts = {}) => createGlobalView({ claudeDir: e.claude, stateDir: e.state, scan: scan ?? (() => Promise.resolve(new Map())), now: () => e.now, ...opts });
const byId = (state, n) => state.sessions.find((s) => s.id === sid(n));

test('discovery: only the last 48 hours, newest file wins a duplicate id, subagents group under their parent', async () => {
  const e = env();
  transcript(e, 1, [user('fresh work', e.now - 1000), say('Working on it.', e.now - 500)], { ageMs: 1000 });
  transcript(e, 2, [user('three days ago', e.now - 72 * HOUR)], { ageMs: 72 * HOUR });
  transcript(e, 3, [user('old copy', e.now - 30 * HOUR)], { ageMs: 30 * HOUR, slug: '-Users-u-a' });
  transcript(e, 3, [user('new copy', e.now - 1 * HOUR)], { ageMs: 1 * HOUR, slug: '-Users-u-b', cwd: '/Users/u/b' });
  subagent(e, 1, 'a1', [tool('t1', 'Bash', { command: 'npm test', description: 'Run the suite' }, e.now - 2000)], { agentType: 'Explore', description: 'Check the tests', finished: false }, 1000);
  subagent(e, 1, 'a2', [say('All done.', e.now - 9000)], { agentType: 'Plan', description: 'Plan it', finished: true }, 9000);
  fs.writeFileSync(path.join(e.claude, 'projects', '-Users-u-proj', 'not-a-session.jsonl'), '{}\n');
  fs.writeFileSync(path.join(e.claude, 'projects', 'stray.txt'), 'x');
  const s = await view(e).state();
  assert.deepEqual(s.sessions.map((x) => x.id).sort(), [sid(1), sid(3)].sort()); // the 72 h one is out
  assert.equal(s.totals.sessions, 2);
  assert.equal(byId(s, 3).project, 'b'); // the newest copy
  const one = byId(s, 1);
  assert.equal(one.agents.length, 2); // grouped under the parent, not rows of their own
  const [a1, a2] = ['a1', 'a2'].map((id) => one.agents.find((a) => a.id === `agent-${id}`));
  assert.deepEqual([a1.type, a1.desc, a1.state], ['Explore', 'Check the tests', 'running']);
  assert.match(a1.doing, /^Bash: Run the suite/);
  assert.deepEqual([a2.state, a2.doing], ['done', 'All done.']);
});

test('ranking: waiting first, then busy, then the most recent; the cap comes after ranking and the lists see every session', async () => {
  const e = env();
  // 45 quiet ended sessions, newer than the one that is waiting
  for (let n = 10; n < 55; n++) transcript(e, n, [user(`ended ${n}`, e.now - 1000), say('Done.', e.now - 900)], { ageMs: 60_000 + n * 1000, branch: `feature/DEV-${n}-x` });
  transcript(e, 1, [user('go', e.now - 100_000), tool('t1', 'Bash', { command: 'rm -rf build' }, e.now - 90_000)], { ageMs: 90_000 }); // waiting: unanswered call, quiet 90 s
  transcript(e, 2, [user('go', e.now - 5000), say('Running.', e.now - 4000)], { ageMs: 4000 }); // busy by recent write
  transcript(e, 3, [user('go', e.now - 50_000), say('Finished.', e.now - 45_000)], { ageMs: 40_000 }); // idle: quiet 40 s, more recent than the ended ones
  const s = await view(e, live(e, { 1: 'busy', 2: 'busy', 3: 'idle' })).state();
  assert.equal(s.totals.sessions, 48);
  assert.equal(s.sessions.length, 40);
  assert.deepEqual(s.sessions.slice(0, 3).map((x) => [x.id, x.state]), [[sid(1), 'waiting'], [sid(2), 'busy'], [sid(3), 'idle']]);
  const ended = s.sessions.filter((x) => x.state === 'ended');
  assert.deepEqual(ended.map((x) => x.lastActive), ended.map((x) => x.lastActive).sort((a, b) => b - a)); // recent first
  assert.equal(s.jira.length, 45); // the Jira groups cover the sessions the cap cut off
  assert.deepEqual([s.totals.waiting, s.totals.busy, s.totals.idle, s.totals.ended], [1, 1, 1, 45]);
});

test('stateOf is the sessions frame heuristic: pending and quiet is waiting, a recent write or a busy registry is busy', () => {
  const now = 1_000_000;
  const f = (o) => ({ live: { status: 'idle' }, pending: 0, mainMs: now - 60_000, lastWriteMs: now - 60_000, ...o });
  assert.equal(stateOf(f({ pending: 1 }), now), 'waiting');
  assert.equal(stateOf(f({ pending: 1, mainMs: now - 5000, lastWriteMs: now - 5000 }), now), 'busy');
  assert.equal(stateOf(f({ live: { status: 'busy' } }), now), 'busy');
  assert.equal(stateOf(f(), now), 'idle');
  assert.equal(stateOf(f({ live: undefined }), now), 'ended');
});

test('a foreground subagent that is writing keeps its parent out of "may be waiting"', async () => {
  const e = env();
  transcript(e, 1, [user('go', e.now - 120_000), tool('a1', 'Agent', { description: 'Long job' }, e.now - 100_000)], { ageMs: 100_000 });
  subagent(e, 1, 'w1', [say('Still going.', e.now - 2000)], { agentType: 'Explore', description: 'Long job', finished: false }, 2000);
  transcript(e, 2, [user('go', e.now - 120_000), tool('a1', 'Agent', { description: 'Long job' }, e.now - 100_000)], { ageMs: 100_000 });
  const s = await view(e, live(e, { 1: 'busy', 2: 'busy' })).state();
  assert.equal(byId(s, 1).state, 'busy');
  assert.equal(byId(s, 2).state, 'waiting');
  assert.deepEqual(s.needsYou.map((n) => [n.sessionId, n.kind]), [[sid(2), 'waiting']]);
});

test('needs-you heuristics: a pending AskUserQuestion, a closing question, an API error, a stall; all labelled may, live sessions only', async () => {
  const e = env();
  const q = { questions: [{ header: 'Target', question: 'Which budget should the replays use?' }] };
  transcript(e, 1, [user('plan it', e.now - 120_000), tool('q1', 'AskUserQuestion', q, e.now - 100_000)], { ageMs: 100_000 });
  transcript(e, 2, [user('do it', e.now - 120_000), say('I changed the file. Should I also update the docs?', e.now - 100_000)], { ageMs: 100_000 });
  transcript(e, 3, [user('do it', e.now - 9000), say('API Error: 529 overloaded', e.now - 8000, { isApiErrorMessage: true, message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: 'API Error: 529 overloaded' }] } })], { ageMs: 8000 });
  transcript(e, 4, [user('long job', e.now - STALL_MS - 5000), say('Started.', e.now - STALL_MS - 4000)], { ageMs: STALL_MS + 4000 });
  transcript(e, 5, [user('old', e.now - HOUR), say('Is this right?', e.now - HOUR)], { ageMs: HOUR }); // ended: no heuristic item
  const s = await view(e, live(e, { 1: 'busy', 2: 'idle', 3: 'idle', 4: 'busy' })).state();
  const kinds = Object.fromEntries(s.needsYou.map((n) => [n.sessionId, n.kind]));
  assert.deepEqual(kinds, { [sid(1)]: 'ask', [sid(2)]: 'question', [sid(3)]: 'error', [sid(4)]: 'stall' });
  assert.ok(s.needsYou.every((n) => n.may === true && n.link === ''));
  const ask = s.needsYou.find((n) => n.kind === 'ask');
  assert.equal(ask.title, 'Which budget should the replays use?');
  assert.match(ask.why, /Target/);
  assert.equal(s.needsYou.find((n) => n.sessionId === sid(5)), undefined);
  assert.deepEqual(byId(s, 2).needs, [s.needsYou.find((n) => n.kind === 'question').id]); // the card keeps ids only
});

test('heuristicNeeds: a closing question says nothing while the session is busy or a tool call is pending', () => {
  const acc = (o) => ({ pending: new Map(), endsQuestion: true, said: 'Is this right?', saidTs: 1, turnError: null, turnErrorTs: null, ...o });
  const f = (o) => ({ acc: acc(o), live: { status: 'idle' }, mainMs: 0 });
  assert.deepEqual(heuristicNeeds(f(), 'busy', 1e9), []);
  assert.deepEqual(heuristicNeeds(f({ pending: new Map([['t', { name: 'Bash', label: 'Bash', ts: 1 }]]) }), 'busy', 1e9), []);
  assert.deepEqual(heuristicNeeds(f({ endsQuestion: false }), 'idle', 1e9), []);
  assert.equal(heuristicNeeds(f(), 'idle', 1e9)[0].kind, 'question');
});

test('board needs-you: html frames and the board ask, links through the safe-link rule, files older than the window ignored', async () => {
  const e = env();
  transcript(e, 1, [user('x', e.now - 1000), say('ok', e.now - 900)], { ageMs: 900 });
  transcript(e, 2, [user('x', e.now - 1000), say('ok', e.now - 900)], { ageMs: 900 });
  const board = (n, frames, panel) => {
    fs.mkdirSync(path.join(e.state, 'board', sid(n), 'live'), { recursive: true });
    fs.writeFileSync(path.join(e.state, 'board', sid(n), 'live', 'board-model.json'), JSON.stringify({ frames }));
    fs.writeFileSync(path.join(e.state, `panel-${sid(n)}.json`), JSON.stringify(panel));
  };
  board(1, [
    { id: 'needs-you', type: 'html', title: 'Needs you (2)', html: '<ol><li><b>Approve the draft</b><br>Queued feedback waits. <a href="https://bitbucket.org/dealhubio/x/pull-requests/9">PR 9</a></li><li>Item 1: review <a href=\"https://example.com/1\">x</a></li><li><b>Click me</b><br><a href="javascript:alert(1)">bad</a> <a href="/relative">rel</a> <script>alert(1)</script></li></ol>' },
    { id: 'notes', type: 'html', title: 'Notes', html: '<p>not a needs list</p>' },
    { id: 'today', type: 'steps', items: [{ t: 'First', state: 'done' }, { t: 'Second', state: 'doing' }] },
    { id: 'q', type: 'ask', q: 'Ship it?', options: ['yes', 'no'] },
  ], { task: { title: 'Board task', why: 'Because' }, ask: 'Pick a route', choices: [{ id: 'a', label: 'Fast' }, { id: 'b', label: 'Safe' }] });
  board(2, [{ id: 'needs-you', type: 'html', title: 'Needs you', html: '<ol><li><b>Stale</b></li></ol>' }], {});
  const old = new Date(e.now - 80 * HOUR);
  fs.utimesSync(path.join(e.state, 'board', sid(2), 'live', 'board-model.json'), old, old);
  fs.utimesSync(path.join(e.state, `panel-${sid(2)}.json`), old, old);
  const s = await view(e).state();
  const mine = s.needsYou.filter((n) => n.sessionId === sid(1));
  assert.deepEqual(mine.map((n) => n.title).sort(), ['Approve the draft', 'Click me', 'Pick a route', 'Ship it?'].sort());
  const approve = mine.find((n) => n.title === 'Approve the draft');
  assert.deepEqual([approve.why, approve.link, approve.may], ['Queued feedback waits. PR 9', 'https://bitbucket.org/dealhubio/x/pull-requests/9', false]);
  assert.equal(mine.find((n) => n.title === 'Click me').link, ''); // javascript: and relative links are gone
  assert.ok(!JSON.stringify(s).includes('alert(1)'));
  assert.equal(s.needsYou.some((n) => n.title.includes('example.com')), false); // placeholder-only items are fixtures
  assert.equal(s.needsYou.some((n) => n.sessionId === sid(2)), false); // a leftover board of an old session
  const card = byId(s, 1);
  assert.equal(card.task.title, 'Board task');
  assert.deepEqual([card.progress.source, card.progress.done, card.progress.total], ['board', 1, 2]);
  assert.deepEqual(mine.find((n) => n.title === 'Pick a route').why, 'Options: Fast / Safe');
});

test('itemsFromHtml: a frame without a list is one item; markup never survives', () => {
  const [one] = itemsFromHtml('<div><b>Decide</b> <i>soon</i> <img src=x onerror=alert(1)> <a href="http://git.corp.io/a?x=1&amp;y=2">link</a></div>');
  assert.equal(one.title, 'Decide');
  assert.equal(one.link, 'http://git.corp.io/a?x=1&y=2');
  assert.ok(!/[<>]/.test(`${one.title}${one.why}`));
  assert.deepEqual(itemsFromHtml(''), []);
  assert.deepEqual(itemsFromHtml('<ul><li>Item 1: review <a href="https://git.corp.io/1">x</a></li></ul>').map((i) => [i.title, i.why, i.link]), [['Item 1: review x', '', 'https://git.corp.io/1']]);
  assert.deepEqual(itemsFromHtml('<ul><li>Item 1: review <a href="https://example.com/1">x</a></li><li>Item 2: <a href="http://localhost:3000/">y</a></li><li>No link here</li></ul>').map((i) => i.title), ['No link here']);
});

test('todos: TodoWrite, TaskCreate/TaskUpdate and the checklist tool each give the current task and progress', async () => {
  const e = env();
  transcript(e, 1, [
    user('plan', e.now - 5000),
    tool('w1', 'TodoWrite', { todos: [{ content: 'Read', status: 'completed', activeForm: 'Reading' }, { content: 'Write', status: 'in_progress', activeForm: 'Writing it' }, { content: 'Test', status: 'pending', activeForm: 'Testing' }] }, e.now - 4000),
  ], { ageMs: 4000 });
  transcript(e, 2, [
    user('plan', e.now - 5000),
    tool('c1', 'TaskCreate', { subject: 'First' }, e.now - 4000), { ...result('c1', e.now - 3900), toolUseResult: { task: { id: '1', subject: 'First' } } },
    tool('c2', 'TaskCreate', { subject: 'Second' }, e.now - 3800), { ...result('c2', e.now - 3700), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c2', content: 'Task #2 created successfully: Second' }] } },
    tool('u1', 'TaskUpdate', { taskId: '1', status: 'completed' }, e.now - 3000),
    tool('u2', 'TaskUpdate', { taskId: '2', status: 'in_progress' }, e.now - 2000),
  ], { ageMs: 2000 });
  transcript(e, 3, [user('plan', e.now - 5000), tool('k1', 'mcp__subagent-progress__checklist', { items: [{ content: 'One', status: 'completed' }, { content: 'Two', status: 'in_progress' }] }, e.now - 4000)], { ageMs: 4000 });
  const s = await view(e).state();
  const p1 = byId(s, 1);
  assert.deepEqual([p1.progress.source, p1.progress.done, p1.progress.total, p1.task.title, p1.task.source], ['todos', 1, 3, 'Writing it', 'todos']);
  const p2 = byId(s, 2).progress;
  assert.deepEqual([p2.done, p2.total, p2.items.map((i) => i.state)], [1, 2, ['done', 'doing']]);
  assert.deepEqual([byId(s, 3).progress.done, byId(s, 3).progress.total], [1, 2]);
});

test('Jira: keys from the branch and the prompts for prefixes seen in links, INT-* internal and unlinked, groups by key', async () => {
  const e = env();
  transcript(e, 1, [user('Work on DEV-100 and see CHR-7, also UTF-8 and ZZZ-1', e.now - 2000), say('Opened https://dealhub.atlassian.net/browse/AUT-55 for you.', e.now - 1000)], { ageMs: 1000, branch: 'feature/DEV-100-thing' });
  transcript(e, 2, [user('same ticket', e.now - 3000)], { ageMs: 3000, branch: 'feature/DEV-100-other' });
  transcript(e, 3, [user('internal', e.now - 3000)], { ageMs: 3000, branch: 'feature/INT-20261111-panel-global-view' });
  transcript(e, 4, [user('internal two', e.now - 3000)], { ageMs: 3000, branch: 'feature/INT-20261111-other-thing' });
  transcript(e, 5, [user('mentions AUT-55 which the link in session 1 taught us', e.now - 3000)], { ageMs: 3000, branch: 'HEAD' });
  const s = await view(e).state();
  const keys = Object.fromEntries(s.jira.map((g) => [g.key, g]));
  assert.deepEqual(Object.keys(keys).sort(), ['AUT-55', 'CHR-7', 'DEV-100', 'INT-20261111-other-thing', 'INT-20261111-panel-global-view']);
  assert.equal(keys['DEV-100'].url, 'https://dealhub.atlassian.net/browse/DEV-100');
  assert.equal(keys['DEV-100'].sessions.length, 2);
  assert.equal(keys['INT-20261111-panel-global-view'].url, null);
  assert.equal(keys['INT-20261111-panel-global-view'].internal, true);
  assert.equal(keys['AUT-55'].sessions.length, 2); // the prefix AUT was learned from a real browse link
  assert.deepEqual(byId(s, 1).tickets.map((k) => k.key), ['DEV-100', 'CHR-7', 'AUT-55']);
});

test('a subagent\'s branch, brief and links count for its parent session', async () => {
  const e = env();
  transcript(e, 1, [user('orchestrate', e.now - 5000), say('Delegated.', e.now - 4000)], { ageMs: 4000, branch: 'HEAD' });
  subagent(e, 1, 'w1', [
    { ...user('Ticket: DEV-9. Implement it.', e.now - 4500), gitBranch: 'feature/DEV-9-x' },
    { ...say('Opened https://github.com/anhermon/claude-panel/pull/9 for review.', e.now - 3500), gitBranch: 'feature/DEV-9-x' },
  ], { agentType: 'general-purpose', description: 'Implement DEV-9', finished: true }, 3500);
  subagent(e, 1, 'w2', [{ ...user('<background-rules>Ticket: INT-20261111-panel-global-view. Work on it.</background-rules>', e.now - 4600), gitBranch: 'HEAD' }, say('ok', e.now - 4000)], { agentType: 'general-purpose', description: 'brief only', finished: true }, 4000);
  const s = await view(e).state();
  const card = byId(s, 1);
  assert.deepEqual(card.tickets.map((k) => k.key).sort(), ['DEV-9', 'INT-20261111-panel-global-view']); // a brief that opens with a tag still names its ticket
  assert.deepEqual(s.jira.map((g) => g.key).sort(), ['DEV-9', 'INT-20261111-panel-global-view']);
  assert.deepEqual(card.links.map((l) => l.url), ['https://github.com/anhermon/claude-panel/pull/9']);
  assert.deepEqual(Object.keys(card.agents[0]).sort(), ['desc', 'doing', 'id', 'lastMs', 'progress', 'state', 'type']); // the inherited parts are not sent to the page
});

test('links: the latest PRs, Jira and artifacts from assistant text; a link with a token in it is dropped', async () => {
  const e = env();
  transcript(e, 1, [
    user('go', e.now - 5000),
    say('PR: https://bitbucket.org/dealhubio/aura/pull-requests/17 and doc https://claude.ai/artifact/AbCdEfGhIjKlMnOpQrStUv.', e.now - 4000),
    say(`Callback https://example.com/cb?token=${FAKE_TOKEN} and https://github.com/anhermon/claude-panel/pull/2)`, e.now - 3000),
  ], { ageMs: 3000 });
  const links = byId(await view(e).state(), 1).links;
  assert.deepEqual(links.map((l) => l.url), ['https://github.com/anhermon/claude-panel/pull/2', 'https://claude.ai/artifact/AbCdEfGhIjKlMnOpQrStUv', 'https://bitbucket.org/dealhubio/aura/pull-requests/17']);
});

test('redaction: no secret from a transcript, a title or a board reaches the output; *.key registry files are never read', async () => {
  const e = env();
  transcript(e, 1, [
    { type: 'ai-title', aiTitle: `Rotate ${FAKE_TOKEN} today` },
    user(`please use password: hunter2hunter and ${FAKE_TOKEN}`, e.now - 4000),
    say(`I ran curl -H "Authorization: Bearer abc.def.ghi-jkl" https://admin:pw123456@host.example/x`, e.now - 3000),
    tool('t1', 'Bash', { command: `export MY_API_KEY=s3cr3tvalue && deploy --token ${FAKE_TOKEN}` }, e.now - 2000),
  ], { ageMs: 2000 });
  fs.mkdirSync(path.join(e.state, 'board', sid(1), 'live'), { recursive: true });
  fs.writeFileSync(path.join(e.state, 'board', sid(1), 'live', 'board-model.json'), JSON.stringify({ frames: [{ id: 'needs-you', type: 'html', title: 'n', html: `<ol><li><b>Use ${FAKE_TOKEN}</b><br>password: hunter2hunter</li></ol>` }] }));
  fs.writeFileSync(path.join(e.claude, 'sessions', '1.abcdef0123456789.key'), 'PEER-SECRET-VALUE');
  const out = JSON.stringify(await view(e, live(e, { 1: 'busy' })).state());
  for (const secret of [FAKE_TOKEN, 'hunter2hunter', 'abc.def.ghi-jkl', 'pw123456', 's3cr3tvalue', 'PEER-SECRET-VALUE']) assert.ok(!out.includes(secret), `leaked ${secret}`);
  assert.match(out, /\[redacted\]/);
});

test('the answer is cached for about 2 s and overlapping asks share one computation', async () => {
  const e = env();
  transcript(e, 1, [user('one', e.now - 1000)], { ageMs: 1000 });
  let t = e.now;
  let scans = 0;
  const v = createGlobalView({ claudeDir: e.claude, stateDir: e.state, now: () => t, scan: () => { scans += 1; return Promise.resolve(new Map()); } });
  const [a, b] = await Promise.all([v.state(), v.state()]);
  assert.equal(a, b);
  assert.equal(scans, 1);
  t += 1000;
  assert.equal(await v.state(), a); // still cached
  transcript(e, 2, [user('two', e.now - 500)], { ageMs: 500 });
  t += 2000;
  const c = await v.state();
  assert.notEqual(c, a);
  assert.equal(c.totals.sessions, 2);
  assert.equal(typeof (await v.json()), 'string');
});

test('an empty or missing ~/.claude gives an empty, valid answer', async () => {
  const e = env();
  const s = await createGlobalView({ claudeDir: path.join(e.claude, 'nope'), stateDir: path.join(e.state, 'nope'), now: () => e.now, scan: () => Promise.resolve(null) }).state();
  assert.deepEqual([s.sessions, s.needsYou, s.jira, s.totals.sessions], [[], [], [], 0]);
});

test('jiraGroups: a session once per key, keys with a live session first', () => {
  const sess = (id, lastActive, state, keys) => ({ id, title: id, state, lastActive, tickets: keys.map((key) => ({ key, internal: false, url: `u/${key}` })) });
  const groups = jiraGroups([sess('a', 50, 'ended', ['DEV-1']), sess('b', 10, 'idle', ['DEV-2']), sess('a', 50, 'ended', ['DEV-1', 'DEV-1'])]);
  assert.deepEqual(groups.map((g) => g.key), ['DEV-2', 'DEV-1']); // DEV-2 has the only live session although DEV-1 is newer
  assert.equal(groups[1].sessions.length, 1);
});

test('jiraGroups: newest ticket first, its sessions newest first', () => {
  const sess = (id, lastActive, keys) => ({ id, title: id, state: 'idle', lastActive, tickets: keys.map((key) => ({ key, internal: false, url: `u/${key}` })) });
  const groups = jiraGroups([sess('a', 10, ['DEV-1']), sess('b', 30, ['DEV-2']), sess('c', 20, ['DEV-1'])]);
  assert.deepEqual(groups.map((g) => g.key), ['DEV-2', 'DEV-1']);
  assert.deepEqual(groups[1].sessions.map((x) => x.id), ['c', 'a']);
  assert.deepEqual(jiraGroups([]), []);
});
