// The server's view of the state file's `scenes`: what is routable, what the page may see, and live-reload mtimes.
//
// Whitelist, never blacklist: the page gets {id,title,span,height,pin,layout,builtin,slot,alt,term:{art}?,rev,mtime} and nothing else
// (never `dir`, `entry`, `term.image`, or any key the mod might add later). The server alone knows the directories.
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_ENTRY, isWithin } from './scene-files.mjs';

export const SCENE_ID_RE = /^[a-z0-9-]{1,24}$/;
export const MTIME_SCAN_INTERVAL_MS = 1000;
export const MAX_SCAN_ENTRIES = 200;
export const MAX_SCAN_DEPTH = 4;
const SPANS = [1, 2, 3];
const LAYOUTS = ['card', 'stage'];
const SLOTS = ['big', 'side', 'auto'];
const MIN_HEIGHT = 120;
const MAX_HEIGHT = 1200;
const MAX_ALT_CHARS = 300;
const MAX_TITLE_CHARS = 60;
const MAX_ART_LINES = 24;
const MAX_ART_COLUMNS = 100;
const DOT = '.';

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const cap = (s, n) => (s.length > n ? s.slice(0, n) : s);

/** One state-file scene -> the server's record (with the private `dir`/`entry`), or null if unusable. */
function toRecord(raw, baseDir) {
  if (!isObj(raw) || typeof raw.id !== 'string' || !SCENE_ID_RE.test(raw.id)) return null;
  if (typeof raw.dir !== 'string' || raw.dir === '' || raw.dir.includes('\0')) return null;
  const pub = { id: raw.id };
  if (typeof raw.title === 'string') pub.title = cap(raw.title, MAX_TITLE_CHARS);
  if (SPANS.includes(raw.span)) pub.span = raw.span;
  if (Number.isFinite(raw.height)) pub.height = Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.round(raw.height)));
  if (raw.pin === true) pub.pin = true;
  if (LAYOUTS.includes(raw.layout)) pub.layout = raw.layout; // absent = card; the page decides the default
  if (raw.builtin === true) pub.builtin = true; // the page tells the board (always a tile) from the model's own scenes
  if (SLOTS.includes(raw.slot)) pub.slot = raw.slot;
  pub.alt = typeof raw.alt === 'string' ? cap(raw.alt, MAX_ALT_CHARS) : '';
  if (isObj(raw.term) && Array.isArray(raw.term.art)) {
    pub.term = { art: raw.term.art.filter((l) => typeof l === 'string').slice(0, MAX_ART_LINES).map((l) => cap(l, MAX_ART_COLUMNS)) };
  }
  pub.rev = Number.isFinite(raw.rev) ? Math.trunc(raw.rev) : 0;
  return {
    id: raw.id,
    dir: path.resolve(baseDir, raw.dir), // relative dirs (the fixture) resolve against the state file's directory
    entry: typeof raw.entry === 'string' && raw.entry !== '' ? raw.entry : DEFAULT_ENTRY,
    pub,
    mtime: 0,
  };
}

// A top-level folder with this name is served like any scene file but never triggers a live reload: the place for data
// a running scene polls (agent status, metrics) so that updating it does not restart the scene.
export const LIVE_DATA_DIR = 'live';

/** Newest mtime (ms) in the dir tree: dirs included (so deletions show), dotfiles and the top-level `live/` data folder skipped, symlinks not followed. */
export function scanMtime(root) {
  let newest = 0;
  let seen = 0;
  const touch = (st) => { newest = Math.max(newest, Math.floor(st.mtimeMs)); };
  const walk = (dir, depth) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(DOT)) continue;
      if (depth === 1 && e.name === LIVE_DATA_DIR) continue;
      if (seen >= MAX_SCAN_ENTRIES) return;
      seen++;
      const full = path.join(dir, e.name);
      let st;
      try {
        st = fs.lstatSync(full);
      } catch {
        continue;
      }
      touch(st);
      if (st.isDirectory() && depth < MAX_SCAN_DEPTH) walk(full, depth + 1);
    }
  };
  try {
    touch(fs.lstatSync(root));
  } catch {
    return 0;
  }
  walk(root, 1);
  return newest;
}

/**
 * `roots`: realpath'd allowed roots for scene dirs; null = unrestricted (the standalone fixture), [] = nothing allowed.
 * ponytail: the scan is synchronous and capped at 200 entries per scene, 6 scenes, once a second: a few ms at
 * worst. Move it to fs.promises if the cap ever grows.
 */
export function createSceneRegistry({ stateFile, roots = null, now = Date.now }) {
  const baseDir = path.dirname(path.resolve(stateFile));
  let scenes = new Map();
  const scanned = new Map(); // dir -> { at, mtime }

  const allowed = (dir) => {
    try {
      const real = fs.realpathSync(dir);
      return { real, ok: !roots || roots.some((r) => isWithin(r, real, true)) };
    } catch {
      return { real: null, ok: false };
    }
  };

  const publicScenes = () => [...scenes.values()].map((s) => ({ ...s.pub, mtime: s.mtime }));

  return {
    /** Replace the scene set from the (raw) state object. */
    load(state) {
      const next = new Map();
      for (const raw of isObj(state) && Array.isArray(state.scenes) ? state.scenes : []) {
        const rec = toRecord(raw, baseDir);
        if (!rec || next.has(rec.id)) continue;
        rec.mtime = scanned.has(rec.dir) ? scanned.get(rec.dir).mtime : 0; // a rewritten state must not reset it
        next.set(rec.id, rec);
      }
      scenes = next;
      for (const dir of [...scanned.keys()]) if (![...next.values()].some((s) => s.dir === dir)) scanned.delete(dir);
    },
    /** Server-side record (with `dir`/`entry`) for routing, or undefined. */
    get: (id) => scenes.get(id),
    /** Re-stat scene dirs, at most once per interval each (new dirs at once). True when any mtime changed. */
    refresh() {
      let changed = false;
      const t = now();
      for (const s of scenes.values()) {
        let cur = scanned.get(s.dir);
        if (!cur || t - cur.at >= MTIME_SCAN_INTERVAL_MS) {
          const { real, ok } = allowed(s.dir);
          cur = { at: t, mtime: real && ok ? scanMtime(real) : 0 };
          scanned.set(s.dir, cur);
        }
        if (cur.mtime !== s.mtime) { s.mtime = cur.mtime; changed = true; }
      }
      return changed;
    },
    /** What the page may see. */
    publicScenes,
    /** The state object for the page: `scenes` replaced by its public form (`[]` if it was not an array). */
    publicState: (state) => {
      if (!isObj(state) || !Object.hasOwn(state, 'scenes')) return state;
      return { ...state, scenes: publicScenes() };
    },
  };
}
