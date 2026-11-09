// The `$.fs` half of the router-kit reader: `<session cwd>/.router/tickets/*/ticket.json` and the tail of
// `.router/events.jsonl`, bounded in count and size, parsed by ./router-state.ts. Cheap: every read starts with a listing and a
// stat per file, and the files are only read again when that signature changed. Safe: no `.router/` gives undefined (nothing is
// shown), and nothing here throws.
import type { EngineInterface } from 'claude-code'

import { buildRun, parseEvalItems, parseEvents, parseTicket } from './router-state'
import type { RouterRun, RouterTicket } from './router-state'

type Dollar = EngineInterface

export const ROUTER_IO = {
  DIR: '.router',
  TICKETS_DIR: 'tickets',
  TICKET_FILE: 'ticket.json',
  EVAL_FILE: 'eval.md',
  VERDICT_FILE: 'verdict.md',
  EVENTS_FILE: 'events.jsonl',
  /** Ticket folders read at most. */
  MAX_TICKETS: 60,
  /** A ticket.json or eval.md over this is not read (the ticket is shown unreadable). */
  MAX_FILE_BYTES: 256 * 1024,
  /** An events file over this is read through `tail`, its last TAIL_BYTES only. */
  MAX_EVENTS_BYTES: 512 * 1024,
  TAIL_BYTES: 64 * 1024,
  TAIL_TIMEOUT_MS: 5000,
  /** The poll that notices a change while no other event wakes the board. */
  POLL_MS: 3000,
} as const

const UNREADABLE_NOTE = 'ticket.json could not be read'
const SIG_MISSING = '-'
const SIG_JOIN = '|'

/** What the last read saw (`sig`) and made of it (`run`: undefined when there is no `.router/`). */
export type RouterRead = { sig: string; run: RouterRun | undefined }

const join = (...parts: string[]): string => parts.join('/')

async function readText($: Dollar, path: string): Promise<string | undefined> {
  try {
    const text = await $.fs.read(path)
    return typeof text === 'string' ? text : undefined
  } catch {
    return undefined
  }
}

/** `size:mtime` of a file, or `-` when it is not there. */
async function statSig($: Dollar, path: string): Promise<string> {
  try {
    const s = await $.fs.stat(path)
    return `${s.size}:${s.mtimeMs}`
  } catch {
    return SIG_MISSING
  }
}

/** `sig`: ticket.json; `proofSig`: eval.md and verdict.md (the proof files change a ticket's stage too). */
type Folder = { name: string; sig: string; proofSig: string }

/** The ticket folders (sorted, at most MAX_TICKETS) with the signature of their ticket.json; undefined when there is no `.router/tickets`. */
async function ticketFolders($: Dollar, root: string): Promise<Folder[] | undefined> {
  let entries
  try {
    entries = await $.fs.list(join(root, ROUTER_IO.TICKETS_DIR))
  } catch {
    return undefined
  }
  const names = entries
    .filter(e => e.kind === 'dir')
    .map(e => e.name)
    .sort()
    .slice(0, ROUTER_IO.MAX_TICKETS)
  const at = (name: string, file: string): string => join(root, ROUTER_IO.TICKETS_DIR, name, file)
  return Promise.all(
    names.map(async name => ({
      name,
      sig: await statSig($, at(name, ROUTER_IO.TICKET_FILE)),
      proofSig: [await statSig($, at(name, ROUTER_IO.EVAL_FILE)), await statSig($, at(name, ROUTER_IO.VERDICT_FILE))].join(SIG_JOIN),
    })),
  )
}

/** A small text file of a ticket folder, or undefined when it is missing, too big or unreadable. */
async function readProofFile($: Dollar, root: string, name: string, file: string): Promise<string | undefined> {
  const path = join(root, ROUTER_IO.TICKETS_DIR, name, file)
  const size = Number((await statSig($, path)).split(':')[0])
  return Number.isNaN(size) || size > ROUTER_IO.MAX_FILE_BYTES ? undefined : readText($, path)
}

async function readTicket($: Dollar, root: string, f: Folder): Promise<RouterTicket | undefined> {
  if (f.sig === SIG_MISSING) return undefined // a folder with a spec and no ticket.json yet is no ticket
  const size = Number(f.sig.split(':')[0])
  const text = size > ROUTER_IO.MAX_FILE_BYTES ? undefined : await readText($, join(root, ROUTER_IO.TICKETS_DIR, f.name, ROUTER_IO.TICKET_FILE))
  const files = { evalText: await readProofFile($, root, f.name, ROUTER_IO.EVAL_FILE), verdictText: await readProofFile($, root, f.name, ROUTER_IO.VERDICT_FILE) }
  try {
    if (text === undefined) throw new Error(UNREADABLE_NOTE)
    return parseTicket(JSON.parse(text), f.name, files)
  } catch {
    return parseTicket({ title: UNREADABLE_NOTE }, f.name, files)
  }
}

/** The text of events.jsonl, or only its end when the file is big. */
async function readEvents($: Dollar, root: string): Promise<string> {
  const path = join(root, ROUTER_IO.EVENTS_FILE)
  const sig = await statSig($, path)
  if (sig === SIG_MISSING) return ''
  if (Number(sig.split(':')[0]) <= ROUTER_IO.MAX_EVENTS_BYTES) return (await readText($, path)) ?? ''
  try {
    const out = await $.process.run(['tail', '-c', String(ROUTER_IO.TAIL_BYTES), path], { timeoutMs: ROUTER_IO.TAIL_TIMEOUT_MS })
    // the first line of a tail is cut in the middle: it fails to parse and is skipped
    return out.exitCode === 0 ? out.stdout : ''
  } catch {
    return ''
  }
}

/**
 * The run in `<cwd>/.router/`. With the previous read it only re-reads files when the listing or a file's size/mtime changed
 * (the same `sig` returns `prev` untouched). `run` is undefined when there is no `.router/tickets` folder.
 */
export async function readRouter($: Dollar, cwd: string, prev?: RouterRead): Promise<RouterRead> {
  const root = join(cwd.replace(/\/+$/, ''), ROUTER_IO.DIR)
  const folders = await ticketFolders($, root)
  if (folders === undefined) return { sig: SIG_MISSING, run: undefined }
  const eventsSig = await statSig($, join(root, ROUTER_IO.EVENTS_FILE))
  const sig = [eventsSig, ...folders.map(f => `${f.name}=${f.sig}${SIG_JOIN}${f.proofSig}`)].join(SIG_JOIN)
  if (prev !== undefined && prev.sig === sig) return prev
  const read = await Promise.all(folders.map(f => readTicket($, root, f)))
  const tickets = read.filter((t): t is RouterTicket => t !== undefined)
  const only = tickets[0]
  if (tickets.length === 1 && only !== undefined && only.checks.length === 0) {
    const name = folders.find(f => f.sig !== SIG_MISSING)?.name ?? ''
    const text = await readText($, join(root, ROUTER_IO.TICKETS_DIR, name, ROUTER_IO.EVAL_FILE))
    if (text !== undefined && text.length <= ROUTER_IO.MAX_FILE_BYTES) only.evalItems = parseEvalItems(text)
  }
  return { sig, run: buildRun(tickets, parseEvents(await readEvents($, root))) }
}
