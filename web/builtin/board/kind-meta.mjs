// The kinds of work an agent row can show: label, strip letter, one glyph, fixed color, headline. The page's copy of
// KIND_META in hooks/work-kinds.ts (the mod works the kind out; the page only draws it): tests/work-kinds.test.ts fails when
// the two tables differ. Pure data, no DOM.

export const KIND_META = Object.freeze({
  ui: { label: 'UI', letter: 'u', glyph: '▣', color: '#f472b6', headline: 'Writing UI' },
  logic: { label: 'Logic', letter: 'l', glyph: 'λ', color: '#34d399', headline: 'Writing logic' },
  tests: { label: 'Tests', letter: 't', glyph: '✓', color: '#fbbf24', headline: 'Running tests' },
  visual: { label: 'Visual', letter: 'v', glyph: '◉', color: '#22d3ee', headline: 'Checking visually' },
  docs: { label: 'Docs', letter: 'd', glyph: '¶', color: '#fb923c', headline: 'Writing docs' },
  research: { label: 'Research', letter: 'r', glyph: '?', color: '#bef264', headline: 'Researching' },
  reading: { label: 'Reading', letter: 'x', glyph: '∷', color: '#60a5fa', headline: 'Reading code' },
  delegating: { label: 'Delegating', letter: 'g', glyph: '⇉', color: '#a78bfa', headline: 'Delegating' },
  working: { label: 'Working', letter: 'w', glyph: '•', color: '#64748b', headline: 'Working' },
  thinking: { label: 'Thinking', letter: 'k', glyph: '…', color: '#94a3b8', headline: 'Thinking' },
  waiting: { label: 'Waiting', letter: 'q', glyph: '‖', color: '#475569', headline: 'Waiting' },
  done: { label: 'Done', letter: 'z', glyph: '■', color: '#475569', headline: 'Finished' },
});

export const KIND_IDS = Object.freeze(Object.keys(KIND_META));
/** Kinds of work a call can be (the others are states of the agent). */
export const WORK_KIND_IDS = Object.freeze(KIND_IDS.slice(0, KIND_IDS.indexOf('thinking')));
/** The strip letter of a bucket nothing happened in. */
export const STRIP_NONE = '.';

export const isKind = (v) => typeof v === 'string' && Object.hasOwn(KIND_META, v);
export const kindMeta = (kind) => (isKind(kind) ? KIND_META[kind] : KIND_META.working);
const KIND_OF_LETTER = Object.freeze(Object.fromEntries(KIND_IDS.map((k) => [KIND_META[k].letter, k])));
/** A strip letter -> its kind ('none' for the empty bucket or an unknown letter). */
export const kindOfLetter = (letter) => (Object.hasOwn(KIND_OF_LETTER, letter) ? KIND_OF_LETTER[letter] : 'none');
