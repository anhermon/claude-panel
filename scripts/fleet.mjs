#!/usr/bin/env node
// Launcher of the fleet control plane: one always-on local process (web/fleet/server.mjs).
//   node scripts/fleet.mjs start [--print-url]   start it (refuses when one already runs); --print-url also prints the URL
//   node scripts/fleet.mjs stop                  stop it (only a process that is really our server is signalled)
//   node scripts/fleet.mjs status                running / stopped, pid, port. Never prints the token or the URL.
//   node scripts/fleet.mjs url                   print the URL (for a person at a terminal; do not run it through a model)
// The token lives in <stateDir>/token (0600) and is read by the server from there: it is never on a command line.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fleetConfig, DIR_MODE, FILE_MODE } from '../web/fleet/config.mjs';

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web', 'fleet', 'server.mjs');
const SERVER_MARK = 'fleet/server.mjs';
const START_WAIT_MS = 8000;
const START_POLL_MS = 100;
const TOKEN_BYTES = 24;
const cfg = fleetConfig();

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The running server's pid, or null: pid file present, process alive, and its command line is our server. */
export function runningPid() {
  let pid;
  try { pid = Number(fs.readFileSync(cfg.pidFile, 'utf8').trim()); } catch { return null; }
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try { process.kill(pid, 0); } catch { return null; }
  try { return execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).includes(SERVER_MARK) ? pid : null; } catch { return null; }
}

function token() {
  try { const t = fs.readFileSync(cfg.tokenFile, 'utf8').trim(); if (t) return t; } catch { /* mint below */ }
  const t = crypto.randomBytes(TOKEN_BYTES).toString('hex');
  fs.mkdirSync(cfg.stateDir, { recursive: true, mode: DIR_MODE });
  fs.writeFileSync(cfg.tokenFile, `${t}\n`, { mode: FILE_MODE });
  return t;
}

const urlOf = (port) => `http://${cfg.host}:${port}/${token()}/`;

async function start(printUrl) {
  const existing = runningPid();
  if (existing !== null) { process.stderr.write(`fleet: already running (pid ${existing})\n`); if (printUrl) process.stdout.write(`${urlOf(readJson(cfg.infoFile)?.port)}\n`); return 0; }
  token();
  fs.mkdirSync(cfg.stateDir, { recursive: true, mode: DIR_MODE });
  fs.rmSync(cfg.infoFile, { force: true });
  const log = fs.openSync(cfg.logFile, 'a', FILE_MODE);
  const child = spawn(process.execPath, [SERVER], { detached: true, stdio: ['ignore', log, log], env: process.env });
  child.unref();
  for (let waited = 0; waited < START_WAIT_MS; waited += START_POLL_MS) {
    await sleep(START_POLL_MS);
    const info = readJson(cfg.infoFile);
    if (info?.pid === child.pid) { process.stderr.write(`fleet: started (pid ${info.pid}, port ${info.port})\n`); if (printUrl) process.stdout.write(`${urlOf(info.port)}\n`); return 0; }
  }
  process.stderr.write(`fleet: the server did not report a port within ${START_WAIT_MS} ms; see ${cfg.logFile}\n`);
  return 1;
}

function stop() {
  const pid = runningPid();
  if (pid === null) { process.stderr.write('fleet: not running\n'); fs.rmSync(cfg.pidFile, { force: true }); return 0; }
  process.kill(pid, 'SIGTERM');
  process.stderr.write(`fleet: stopped (pid ${pid})\n`);
  return 0;
}

function status() {
  const pid = runningPid();
  const info = readJson(cfg.infoFile);
  process.stdout.write(pid === null ? 'stopped\n' : `running pid ${pid} port ${info?.port ?? 'unknown'} state ${cfg.stateDir}\n`);
  return pid === null ? 3 : 0;
}

const [cmd, ...rest] = process.argv.slice(2);
const code = cmd === 'start' ? await start(rest.includes('--print-url'))
  : cmd === 'stop' ? stop()
    : cmd === 'status' ? status()
      : cmd === 'url' ? (() => { const info = readJson(cfg.infoFile); if (runningPid() === null || !info) { process.stderr.write('fleet: not running\n'); return 3; } process.stdout.write(`${urlOf(info.port)}\n`); return 0; })()
        : (process.stderr.write('usage: fleet.mjs start [--print-url] | stop | status | url\n'), 2);
process.exit(code);
