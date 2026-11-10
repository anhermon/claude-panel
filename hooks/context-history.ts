// Only generic jobs/forms and an opaque session key are persisted, never prompts, paths or branch names.
import type { EngineInterface } from 'claude-code'
import { JOBS } from './session-context'
import type { Job } from './session-context'

export const HISTORY_KEY = 'panel.history'
export const HISTORY_MAX = 8
export const STALE_WINDOW = 5
export const STALE_MIN_SESSIONS = 3
export const FORMS_MAX = 64
export const FORM_PATTERN = /^[a-z][a-z0-9-]{0,31}$/
const UNKNOWN_AT = 0
const UNKNOWN_JOB: Job = 'chat'
export type HistorySession = { sessionKey: string; job: Job; forms: string[]; at: number }
export type ContextHistory = readonly HistorySession[]

const formsOf = (raw: unknown): string[] => Array.isArray(raw)
  ? [...new Set(raw.filter((f): f is string => typeof f === 'string' && FORM_PATTERN.test(f)))].slice(-FORMS_MAX) : []

/** Junk-safe, bounded restoration. The key lets a reloaded session update its own row instead of adding another. */
export function restoreHistory(raw: unknown): HistorySession[] {
  if (!Array.isArray(raw)) return []
  const sessions = new Map<string, HistorySession>()
  for (const value of raw) {
    if (value === null || typeof value !== 'object') continue
    const { sessionKey, job, forms, at } = value as Record<string, unknown>
    if (typeof sessionKey !== 'string' || sessionKey === '' || !JOBS.includes(job as Job) || typeof at !== 'number' || !Number.isFinite(at) || at < 0) continue
    sessions.delete(sessionKey)
    sessions.set(sessionKey, { sessionKey, job: job as Job, forms: formsOf(forms), at })
  }
  return [...sessions.values()].slice(-HISTORY_MAX)
}

/** Start once; job changes refine the row without changing its time or losing forms. */
export function startSession(history: ContextHistory, sessionKey: string, job: Job, at: number): HistorySession[] {
  const found = history.some(s => s.sessionKey === sessionKey)
  return (found ? history.map(s => s.sessionKey === sessionKey ? { ...s, job } : s)
    : [...history, { sessionKey, job, forms: [], at }]).slice(-HISTORY_MAX)
}

export function pushForm(history: ContextHistory, sessionKey: string, form: string): HistorySession[] {
  if (!FORM_PATTERN.test(form)) return [...history]
  return startSession(history, sessionKey, history.find(s => s.sessionKey === sessionKey)?.job ?? UNKNOWN_JOB, UNKNOWN_AT)
    .map(s => s.sessionKey === sessionKey ? { ...s, forms: formsOf([...s.forms, form]) } : s)
}

/** Count sessions, not posts: one repeated form in a session only votes once. */
export function staleForms(history: ContextHistory): string[] {
  const counts = new Map<string, number>()
  for (const session of history.slice(-STALE_WINDOW)) for (const form of new Set(session.forms)) counts.set(form, (counts.get(form) ?? 0) + 1)
  return [...counts].filter(([, n]) => n >= STALE_MIN_SESSIONS).map(([form]) => form)
}

export async function readHistory($: Pick<EngineInterface, 'store'>): Promise<HistorySession[]> {
  return restoreHistory(await $.store.get(HISTORY_KEY).catch(() => undefined))
}

export async function writeHistory($: Pick<EngineInterface, 'store'>, history: ContextHistory): Promise<void> {
  await $.store.set(HISTORY_KEY, history).catch(() => undefined)
}
