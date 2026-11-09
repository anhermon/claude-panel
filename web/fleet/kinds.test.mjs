import test from 'node:test';
import assert from 'node:assert/strict';
import { kindOfCall, targetOf } from './kinds.mjs';

// The same expectations as tests/work-kinds.test.ts, through raw tool inputs.
test('kindOfCall follows the mod rules', () => {
  assert.equal(kindOfCall('Edit', { file_path: '/a/b/board.css' }), 'ui');
  assert.equal(kindOfCall('Write', { file_path: '/p/web/lanes.js' }), 'ui');
  assert.equal(kindOfCall('Edit', { file_path: '/p/hooks/x.ts' }), 'logic');
  assert.equal(kindOfCall('Edit', { file_path: '/p/x/a.test.ts' }), 'tests');
  assert.equal(kindOfCall('Edit', { file_path: '/p/tests/helper.ts' }), 'tests');
  assert.equal(kindOfCall('Write', { file_path: '/p/README.md' }), 'docs');
  assert.equal(kindOfCall('Read', { file_path: '/p/a.ts' }), 'reading');
  assert.equal(kindOfCall('Read', { file_path: '/p/a.png' }), 'visual');
  assert.equal(kindOfCall('Grep', { pattern: 'x' }), 'reading');
  assert.equal(kindOfCall('WebFetch', {}), 'research');
  assert.equal(kindOfCall('Agent', {}), 'delegating');
  assert.equal(kindOfCall('mcp__claude-in-chrome__navigate', {}), 'visual');
  assert.equal(kindOfCall('mcp__panel__panel', {}), undefined);
  assert.equal(kindOfCall('TodoWrite', {}), undefined);
  assert.equal(kindOfCall('SomethingNew', {}), 'working');
});

test('Bash kinds come from the program and verb only', () => {
  assert.equal(kindOfCall('Bash', { command: 'cd /x && npm run test -- --foo' }), 'tests');
  assert.equal(kindOfCall('Bash', { command: 'node --test web/' }), 'tests');
  assert.equal(kindOfCall('Bash', { command: '/opt/homebrew/bin/tsc -p .' }), 'tests');
  assert.equal(kindOfCall('Bash', { command: 'node scripts/render-board.mjs' }), 'visual');
  assert.equal(kindOfCall('Bash', { command: 'grep -n x file' }), 'reading');
  assert.equal(kindOfCall('Bash', { command: 'FOO=secret git push' }), 'working');
  assert.equal(targetOf('Bash', { command: 'FOO=secret /usr/bin/git push --force' }), 'git');
});
