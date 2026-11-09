// The numbers and words shared by the page's server (commands.mjs, config.mjs) and the mod's hub (hooks/fleet-contract.ts)
// must be the same. A plugin test cannot import() an .mjs, so this test reads the TypeScript source as text.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ORIGIN, ORIGIN_PREFIX, COMMAND_ID, STATUS } from './commands.mjs';
import { fleetConfig } from './config.mjs';

const TS = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'hooks', 'fleet-contract.ts'), 'utf8');
const quoted = (name) => new RegExp(`export const ${name} = '([^']*)'`).exec(TS)?.[1];
const number = (name) => Number(new RegExp(`export const ${name} = ([0-9_*\\s]+)\\n`).exec(TS)?.[1]?.split('*').reduce((a, n) => a * Number(n.replace(/_/g, '').trim()), 1));

test('the words match', () => {
  assert.equal(quoted('FLEET_ORIGIN'), ORIGIN);
  assert.equal(quoted('FLEET_ORIGIN_PREFIX'), ORIGIN_PREFIX);
  const idSource = /FLEET_COMMAND_ID = \/(.*)\//.exec(TS)?.[1];
  assert.equal(idSource, COMMAND_ID.source);
  const status = /FLEET_STATUS = \{([^}]*)\}/.exec(TS)?.[1] ?? '';
  for (const [key, value] of Object.entries(STATUS)) assert.match(status, new RegExp(`${key}: '${value}'`));
});

test('the numbers match', () => {
  const cfg = fleetConfig({ HOME: '/h', TMPDIR: '/t' });
  assert.equal(number('FLEET_MESSAGE_MAX_CHARS'), cfg.messageMaxChars);
});

test('the shared folder is <TMPDIR>/claude-panel/fleet with the same sub-names', () => {
  const cfg = fleetConfig({ HOME: '/h', TMPDIR: '/t' });
  const parts = /FLEET_STATE_PARTS = \[([^\]]*)\]/.exec(TS)?.[1].replace(/['\s]/g, '').split(',');
  assert.equal(path.join('/t', ...parts), cfg.stateDir);
  const names = Object.fromEntries([...TS.matchAll(/(COMMANDS|RESULTS|CLAIMS|AUDIT|HUB|HUB_CONFIG): '([^']+)'/g)].map((m) => [m[1], m[2]]));
  assert.equal(path.join(cfg.stateDir, names.COMMANDS), cfg.commandsDir);
  assert.equal(path.join(cfg.stateDir, names.RESULTS), cfg.resultsDir);
  assert.equal(path.join(cfg.stateDir, names.CLAIMS), cfg.claimsDir);
  assert.equal(path.join(cfg.stateDir, names.AUDIT), cfg.auditFile);
  assert.equal(path.join(cfg.stateDir, names.HUB), cfg.hubFile);
});

test('the hub is online for the server only while hub.json is younger than the server limit', () => {
  const server = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'server.mjs'), 'utf8');
  const fresh = Number(/HUB_FRESH_MS = (\d+)/.exec(server)?.[1]);
  const beat = number('HUB_BEAT_MS');
  assert.ok(fresh >= 2 * beat, `server tolerance ${fresh} ms must cover at least two beats of ${beat} ms`);
});
