// Every tunable of the fleet control plane in one place: names, paths, limits, intervals. Each number has a unit in its name
// and an env override (CLAUDE_FLEET_*), so nothing below is a magic value elsewhere. Pure data plus path helpers: no I/O.
import os from 'node:os';
import path from 'node:path';

const MS = 1000;
const MIN_MS = 60 * MS;
const HOUR_MS = 60 * MIN_MS;
const KIB = 1024;

const num = (name, fallback, env = process.env) => {
  const raw = env[`CLAUDE_FLEET_${name}`];
  const v = raw === undefined || raw === '' ? Number.NaN : Number(raw);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

/** Config from the environment; `env` is injectable for tests. */
export function fleetConfig(env = process.env) {
  const home = env.HOME || os.homedir();
  const claudeDir = env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
  const tmp = (env.TMPDIR || os.tmpdir()).replace(/\/+$/, '');
  const stateDir = env.CLAUDE_FLEET_DIR || path.join(tmp, 'claude-panel', 'fleet');
  return Object.freeze({
    // where things live
    sessionsDir: path.join(claudeDir, 'sessions'),
    projectsDir: path.join(claudeDir, 'projects'),
    stateDir,
    stateFile: path.join(stateDir, 'state.json'),
    commandsDir: path.join(stateDir, 'commands'),
    resultsDir: path.join(stateDir, 'results'),
    claimsDir: path.join(stateDir, 'claims'),
    auditFile: path.join(stateDir, 'audit.jsonl'),
    hubFile: path.join(stateDir, 'hub.json'),
    tokenFile: path.join(stateDir, 'token'),
    pidFile: path.join(stateDir, 'server.pid'),
    infoFile: path.join(stateDir, 'server.json'),
    logFile: path.join(stateDir, 'server.log'),
    // feed cadence and window
    pollMs: num('POLL_MS', 2 * MS, env),
    psEveryMs: num('PS_EVERY_MS', 4 * MS, env),
    discoverEveryMs: num('DISCOVER_EVERY_MS', 10 * MS, env),
    windowMs: num('WINDOW_HOURS', 24, env) * HOUR_MS,
    heartbeatMs: num('HEARTBEAT_MS', 10 * MS, env),
    // what "running" means
    runningWriteMs: num('RUNNING_WRITE_MS', 30 * MS, env), // a transcript written this recently counts as running
    waitingHintMs: num('WAITING_HINT_MS', 20 * MS, env), // an unanswered tool call this quiet reads "may be waiting"
    subagentActiveMs: num('SUBAGENT_ACTIVE_MS', 60 * MS, env),
    procStartToleranceMs: num('PROC_START_TOLERANCE_MS', 2 * MS, env),
    // transcript reading
    tailBytes: num('TAIL_KIB', 512, env) * KIB, // first read and the most one poll reads
    rowMaxBytes: num('ROW_MAX_KIB', 4096, env) * KIB, // a longer partial line is dropped
    maxTracked: num('MAX_TRACKED', 200, env), // sessions kept in state at most
    bucketMs: num('BUCKET_MIN', 15, env) * MIN_MS, // tokens-over-time resolution
    bucketsMax: num('BUCKETS_MAX', 96, env),
    seenIdsMax: num('SEEN_IDS_MAX', 4000, env), // message / tool ids remembered per session for de-duplication
    // texts kept per session in state.json
    titleChars: 160,
    promptChars: 600,
    errorChars: 240,
    toolLabelChars: 120,
    // drill-down (served on demand, not part of state.json)
    detailBytes: num('DETAIL_KIB', 768, env) * KIB,
    detailPageSize: num('DETAIL_PAGE', 30, env),
    detailTextChars: 1800,
    detailResultChars: 600,
    // send-message contract (the mod's hub enforces the same numbers: hooks/fleet-contract.ts)
    messageMaxChars: 2000,
    commandBodyMaxBytes: 8 * KIB,
    // server
    host: '127.0.0.1',
    defaultPort: num('PORT', 4727, env),
    portTries: 20,
    keepaliveMs: 15 * MS,
    resultWaitMs: num('RESULT_WAIT_MS', 60 * MS, env),
  });
}

export const STATE_SCHEMA = 1;
export const GROUPS = Object.freeze({ RUNNING: 'running', IDLE: 'idle', EARLIER: 'earlier' });
export const FILE_MODE = 0o600;
export const DIR_MODE = 0o700;
