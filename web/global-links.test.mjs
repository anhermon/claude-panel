import test from 'node:test';
import assert from 'node:assert/strict';
import { isPlaceholder, branchKeys, browsePrefixes, classify, jiraUrl, keepLatest, linksIn, safeLink, SEED_PREFIXES, ticketKeys } from './global/links.mjs';

const PREFIXES = new Set(SEED_PREFIXES);

test('safeLink keeps absolute http(s) only, strips trailing punctuation, drops a url with a secret in it', () => {
  assert.equal(safeLink('https://bitbucket.org/dealhubio/x/pull-requests/12).'), 'https://bitbucket.org/dealhubio/x/pull-requests/12');
  for (const bad of ['javascript:alert(1)', 'data:text/html,x', '/relative/path', '//evil.example/x', 'ftp://x.example/a', 'jav\tascript:alert(1)', '', undefined]) assert.equal(safeLink(bad), '', String(bad));
  assert.equal(safeLink('https://example.com/cb?token=abcdef123456'), ''); // a query-string secret is never shown
  assert.equal(safeLink('https://user:pw123456@host.example/x'), '');
});

test('classify and linksIn: PRs (with a number), Jira, Atlassian, artifacts; nothing else', () => {
  const text = [
    'PR https://bitbucket.org/dealhubio/aura-sre/pull-requests/17 and https://github.com/anhermon/claude-panel/pull/2.',
    'bare https://github.com/anhermon/claude-panel/pull/ no number, https://example.com/other',
    'ticket (https://dealhub.atlassian.net/browse/DEV-50428), page https://dealhub.atlassian.net/wiki/spaces/X/pages/1',
    'doc https://claude.ai/artifact/QpfjQdx5bYKc3gMx7nyMqw',
    'again https://github.com/anhermon/claude-panel/pull/2',
  ].join('\n');
  const got = linksIn(text);
  assert.deepEqual(got.map((l) => l.kind), ['pr', 'pr', 'jira', 'atlassian', 'artifact']);
  assert.equal(got[0].label, 'PR #17 aura-sre');
  assert.equal(got[2].label, 'DEV-50428');
  assert.equal(classify('https://github.com/a/b/issues/3'), null);
});

test('keepLatest: newest first, no repeats, capped', () => {
  const l = (n) => ({ url: `https://github.com/a/b/pull/${n}`, kind: 'pr', label: `PR #${n}` });
  let list = [];
  for (let i = 1; i <= 8; i++) list = keepLatest(list, [l(i)]);
  assert.equal(list.length, 6);
  assert.equal(list[0].label, 'PR #8');
  assert.equal(keepLatest(list, [l(5)])[0].label, 'PR #5');
  assert.equal(keepLatest(list, [l(5)]).filter((x) => x.label === 'PR #5').length, 1);
});

test('ticket keys: only prefixes seen in real links, INT-* is internal and kept whole, HEAD names none', () => {
  assert.deepEqual(branchKeys('feature/DEV-50428-mcp-evals-harness', PREFIXES), [{ key: 'DEV-50428', internal: false }]);
  assert.deepEqual(branchKeys('feature/INT-20261111-panel-global-view', PREFIXES), [{ key: 'INT-20261111-panel-global-view', internal: true }]);
  assert.notDeepEqual(branchKeys('feature/INT-20261111-a', PREFIXES), branchKeys('feature/INT-20261111-b', PREFIXES)); // two of one day stay two tickets
  assert.deepEqual(branchKeys('HEAD', PREFIXES), []);
  assert.deepEqual(branchKeys(null, PREFIXES), []);
  assert.deepEqual(ticketKeys('fix DEV-1 and CHR-22, see UTF-8 and SHA-256 and ZZZ-9, DEV-1 again', PREFIXES).map((k) => k.key), ['DEV-1', 'CHR-22']);
  assert.deepEqual(ticketKeys('AUT-5 is unknown until a link shows it', PREFIXES), []);
  assert.deepEqual(ticketKeys('AUT-5 now', new Set([...PREFIXES, 'AUT'])).map((k) => k.key), ['AUT-5']);
});

test('browse links teach the prefixes; the base url is the real one; internal keys get no link', () => {
  assert.deepEqual(browsePrefixes('see https://dealhub.atlassian.net/browse/AUT-12 and https://dealhub.atlassian.net/browse/DEV-3'), ['AUT', 'DEV']);
  assert.equal(jiraUrl('DEV-5', false), 'https://dealhub.atlassian.net/browse/DEV-5');
  assert.equal(jiraUrl('INT-20261111-x', true), null);
});

test('a browse link without a key is dropped, and the same page written two ways is one link', () => {
  assert.equal(classify('https://dealhub.atlassian.net/browse/'), null);
  assert.equal(classify('https://dealhub.atlassian.net/browse'), null);
  assert.deepEqual(linksIn('see https://dealhub.atlassian.net/browse/ and https://dealhub.atlassian.net/browse/DEV-1 and https://dealhub.atlassian.net/browse/DEV-1/ and https://dealhub.atlassian.net/browse/DEV-1#x').map((l) => l.label), ['DEV-1']);
  const l = (url) => ({ url, kind: 'pr', label: 'x' });
  assert.equal(keepLatest([l('https://github.com/a/b/pull/1')], [l('https://github.com/a/b/pull/1/')]).length, 1);
});

test('placeholder hosts: example.com/.org, subdomains and localhost; real hosts are not', () => {
  for (const u of ['https://example.com/1', 'http://www.example.org/x', 'http://localhost:3000/a', 'http://127.0.0.1/a']) assert.ok(isPlaceholder(u), u);
  for (const u of ['https://github.com/a/b/pull/1', 'https://notexample.com/x', 'https://example.com.evil.io/x']) assert.ok(!isPlaceholder(u), u);
});
