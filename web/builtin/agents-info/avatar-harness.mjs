// The harness registry: which character an agent is drawn as. ONE table (HARNESS: id -> label, colour, character, how to recognise it);
// a harness that comes along later needs no code change: an unknown harness name gets the neutral generic character in a hue taken from
// a stable hash of its name (kept clear of the known hues, so two unknown harnesses differ from each other and from the known ones).
// The harness is read from what the panel knows of an agent: an explicit `harness` field (the agent record, else its router ticket), the
// model id, the delegation-kit worker role (codex-worker, agy-worker); nothing known = claude (the session itself). Pure; tested by
// avatar-harness.test.mjs.
import { hash01 } from './avatar-model.mjs';
import { CHARACTERS, CLAUDE_COLOR, CODEX_COLOR } from './mascot-grid.mjs';

export const DEFAULT_HARNESS = 'claude';
export const HARNESS = Object.freeze({
  claude: { label: 'Claude', color: CLAUDE_COLOR, character: 'claude', match: /claude|sonnet|haiku|opus|fable/i },
  codex: { label: 'Codex', color: CODEX_COLOR, character: 'codex', match: /codex|chatgpt|gpt|\bo[1-9](?:[-\s.]|$)/i },
  agy: { label: 'Agy', color: '#7C6CF2', character: 'agy', match: /\bagy\b|agy-|gemini/i },
});
const KNOWN_HUES = Object.freeze([16, 236]); // the hue of claude, and the middle of codex (225) and agy (247), which sit together; in degrees
const HUE_CLEARANCE = 52;
const DEG = 360;
const UNKNOWN_SAT = 0.55;
const UNKNOWN_LIGHT = 0.52;
const NAME_CHARS = 16;

const clean = (v) => (typeof v === 'string' ? v.trim().toLowerCase().replace(/\s+/g, '-').slice(0, NAME_CHARS) : '');
/** The known harness a piece of text names, else null. */
export const knownIn = (text) => Object.keys(HARNESS).find((id) => HARNESS[id].match.test(text ?? '')) ?? null;

/** The id of an agent's harness: a known one, or the (cleaned) name an explicit `harness` field gave. */
export function harnessOf(agent) {
  const explicit = clean(agent?.harness ?? agent?.ticket?.harness);
  if (explicit !== '') return knownIn(explicit) ?? explicit;
  for (const text of [agent?.model, agent?.role]) { const id = knownIn(text); if (id !== null) return id; }
  return DEFAULT_HARNESS;
}

/** A hue in degrees from a name, outside the clearance windows around the known hues. */
export function unknownHue(name) {
  const windows = [...KNOWN_HUES].sort((a, b) => a - b);
  const free = DEG - windows.length * 2 * HUE_CLEARANCE;
  let p = hash01(name) * free;
  let at = windows[0] + HUE_CLEARANCE;
  for (let i = 0; i < windows.length; i++) { // walk the free arcs between the windows
    const next = windows[(i + 1) % windows.length] + (i === windows.length - 1 ? DEG : 0) - HUE_CLEARANCE;
    const arc = next - at;
    if (p < arc) return (at + p) % DEG;
    p -= arc;
    at = next + 2 * HUE_CLEARANCE;
  }
  return at % DEG;
}
const hslHex = (h, s, l) => {
  const a = s * Math.min(l, 1 - l);
  const f = (n) => { const k = (n + h / 30) % 12; return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)))); };
  return `#${[f(0), f(8), f(4)].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
};

/** { id, label, color, character } for a harness id: the registry row, or the generic character in a hashed hue. */
export function harnessInfo(id) {
  const row = HARNESS[id];
  if (row) return { id, label: row.label, color: row.color, character: CHARACTERS[row.character] };
  const name = clean(id) || 'unknown';
  return { id: name, label: name[0].toUpperCase() + name.slice(1), color: hslHex(unknownHue(name), UNKNOWN_SAT, UNKNOWN_LIGHT), character: CHARACTERS.generic };
}

/** "Codex · gpt-6.1-sol · high": the harness, the model and the effort the agent runs with (what is known). Never an id. */
export const harnessLine = (agent) => [harnessInfo(harnessOf(agent)).label, agent?.model, agent?.effort].filter((x) => typeof x === 'string' && x !== '').join(' · ');
