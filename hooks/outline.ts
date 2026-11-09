// The slide outline of a stage scene's entry page, for the terminal pane: one title per `<section>` slide (the deck
// engine's convention: its `data-title`, else the first heading inside it). A page with no `<section` has NO outline
// (a dashboard is not a deck). A cheap regex, not an HTML parser: a page it cannot read simply has no outline.
// Titles are decoded (entities), stripped of tags, whitespace-collapsed; empty ones are dropped. Pure, no `$`.
export const OUTLINE_MAX_TITLES = 8
export const OUTLINE_TITLE_CHARS = 60
/** Entry pages larger than this are not read for an outline. */
export const OUTLINE_MAX_BYTES = 512 * 1024

const SECTION_OPEN = /<section\b([^>]*)>/gi
const DATA_TITLE = /\sdata-title\s*=\s*(?:"([^"]*)"|'([^']*)')/i
const HEADING = /<h[1-3]\b[^>]*>([\s\S]*?)<\/h[1-3]>/i
const TAG = /<[^>]*>/g
const ENTITIES: Readonly<Record<string, string>> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', middot: '·', mdash: '—', ndash: '–', hellip: '…',
}
const ENTITY = /&(#x[0-9a-f]+|#\d+|[a-z]+);/gi
const HEX_PREFIX = 2
const DEC_PREFIX = 1
const MAX_CODE_POINT = 0x10ffff

function decode(s: string): string {
  return s.replace(ENTITY, (whole, name: string) => {
    const lower = name.toLowerCase()
    if (lower.startsWith('#')) {
      const cp = lower.startsWith('#x') ? parseInt(lower.slice(HEX_PREFIX), 16) : parseInt(lower.slice(DEC_PREFIX), 10)
      return Number.isInteger(cp) && cp > 0 && cp <= MAX_CODE_POINT ? String.fromCodePoint(cp) : whole
    }
    return ENTITIES[lower] ?? whole
  })
}

const tidy = (s: string): string => {
  const flat = decode(s.replace(TAG, ' ')).replace(/\s+/g, ' ').trim()
  return flat.length <= OUTLINE_TITLE_CHARS ? flat : flat.slice(0, OUTLINE_TITLE_CHARS - 1) + '…'
}

/** Up to OUTLINE_MAX_TITLES slide titles of `html`; [] when it has no `<section` or names none. */
export function outlineOf(html: string): string[] {
  const opens = Array.from(html.matchAll(SECTION_OPEN))
  const out: string[] = []
  for (let i = 0; i < opens.length && out.length < OUTLINE_MAX_TITLES; i++) {
    const open = opens[i] as RegExpMatchArray
    const attr = DATA_TITLE.exec(open[1] ?? '')
    // Without data-title the title is the first heading before the next section opens.
    const from = (open.index ?? 0) + open[0].length
    const to = opens[i + 1]?.index ?? html.length
    const title = tidy(attr?.[1] ?? attr?.[2] ?? HEADING.exec(html.slice(from, to))?.[1] ?? '')
    if (title !== '') out.push(title)
  }
  return out
}
