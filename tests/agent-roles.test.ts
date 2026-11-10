// The role of an agent in a router-kit run and the ticket it works on: pure, tolerant, never a guess for an ordinary agent.
import { expect, test } from 'claude-code/testing'

import { ROLES, ROLE_SHORT, badgeOf, plainTitle, roleOf, tagOf, ticketBadgeOf, ticketOf } from '../hooks/agent-roles'
import { buildRun, parseEvents, parseTicket } from '../hooks/router-state'
import type { RouterRun } from '../hooks/router-state'

const ticket = (id: string, over: Record<string, unknown> = {}) => parseTicket({ id, status: 'in_progress', ...over }, id)
const run = (ids: string[] = ['01-slugify', '02-is-palindrome']): RouterRun => buildRun(ids.map(id => ticket(id)), parseEvents(''))

test('ordinary agents have no role, with or without a run', () => {
  for (const hasRun of [false, true]) {
    expect(roleOf({ kind: 'subagent', type: 'general-purpose', label: 'Fix the lanes' }, hasRun)).toBeUndefined()
    expect(roleOf({ kind: 'subagent', type: 'Explore', label: 'Worker pool survey' }, hasRun)).toBeUndefined()
    expect(roleOf({ kind: 'subagent', type: 'example-tools:helper', label: 'T59 verifier chips' }, hasRun)).toBeUndefined()
    expect(roleOf({ kind: 'subagent' }, hasRun)).toBeUndefined()
  }
})

test('each role is found by its subagent type, also namespaced and in any case', () => {
  for (const role of ROLES.filter(r => r !== 'router')) {
    expect(roleOf({ kind: 'subagent', type: role, label: 'x' }, true)).toBe(role)
    expect(roleOf({ kind: 'subagent', type: `router-kit:${role}`, label: 'x' }, false)).toBe(role)
  }
  expect(roleOf({ kind: 'subagent', type: 'Verifier' }, true)).toBe('verifier')
  expect(roleOf({ kind: 'subagent', type: 'router' }, true)).toBe('router')
})

test('a description that starts with a role word names the role, only inside a run and only for an unspecialised type', () => {
  const generic = (label: string, type = 'general-purpose') => ({ kind: 'subagent', type, label })
  expect(roleOf(generic('Worker 01-slugify'), true)).toBe('worker')
  expect(roleOf(generic('verify 02-is-palindrome', ''), true)).toBe('verifier')
  expect(roleOf(generic('Verifier: 02'), true)).toBe('verifier')
  expect(roleOf(generic('codex worker 03'), true)).toBe('codex-worker')
  expect(roleOf({ kind: 'subagent', name: 'merger', label: 'x' }, true)).toBe('merger')
  expect(roleOf(generic('Worker 01-slugify'), false)).toBeUndefined()
  expect(roleOf(generic('Worker 01-slugify', 'Explore'), true)).toBeUndefined()
  expect(roleOf(generic('Workers pool'), true)).toBeUndefined()
})

test('the main session is the router only when the run has a .router/ folder', () => {
  expect(roleOf({ kind: 'main' }, true)).toBe('router')
  expect(roleOf({ kind: 'main' }, false)).toBeUndefined()
})

test('every role has a short word for tight places', () => {
  for (const role of ROLES) expect(ROLE_SHORT[role].length).toBeGreaterThan(0)
  expect(ROLE_SHORT['codex-worker']).toBe('codex')
})

test('ticketOf finds a ticket id of the run in the description, name or intent', () => {
  const r = run()
  expect(ticketOf({ label: 'Worker 01-slugify' }, r)).toBe('01-slugify')
  expect(ticketOf({ label: 'x', name: 'verify 02-is-palindrome' }, r)).toBe('02-is-palindrome')
  expect(ticketOf({ label: 'x', intent: 'ticket dir .router/tickets/02-is-palindrome/' }, r)).toBe('02-is-palindrome')
  expect(ticketOf({ label: 'WORKER 01-SLUGIFY' }, r)).toBe('01-slugify')
  expect(ticketOf({ label: 'both 02-is-palindrome and 01-slugify' }, r)).toBe('02-is-palindrome')
})

test('ticketOf accepts T01 / ticket 1 for a ticket that starts with that number, unless it is ambiguous', () => {
  const r = run()
  expect(ticketOf({ label: 'T01 worker' }, r)).toBe('01-slugify')
  expect(ticketOf({ label: 'verify ticket #2' }, r)).toBe('02-is-palindrome')
  expect(ticketOf({ label: 'T1' }, r)).toBe('01-slugify')
  expect(ticketOf({ label: 'T01 and T02' }, r)).toBeUndefined()
  expect(ticketOf({ label: 'T10 elsewhere' }, r)).toBeUndefined()
  const twins = run(['01-a', '1-b'])
  expect(ticketOf({ label: 'T1' }, twins)).toBeUndefined()
})

test('ticketOf is undefined without a run, without tickets, on a miss and on a partial id', () => {
  expect(ticketOf({ label: 'Worker 01-slugify' }, undefined)).toBeUndefined()
  expect(ticketOf({ label: 'Worker 01-slugify' }, run([]))).toBeUndefined()
  expect(ticketOf({ label: 'Fix the lanes' }, run())).toBeUndefined()
  expect(ticketOf({ label: '01-slugify-more' }, run())).toBeUndefined()
  expect(ticketOf({ label: '301-slugify' }, run())).toBeUndefined()
  expect(ticketOf({ label: '01' }, run())).toBeUndefined()
  expect(ticketOf({ label: 'T01-ish' }, run(['T01']))).toBeUndefined()
  expect(ticketOf({ label: 'worker T01' }, run(['T01']))).toBe('T01')
})

test('a ticket badge says the stage (done is verified) and the checks', () => {
  const verified = parseTicket({ id: '01-slugify', status: 'done', verdict: { result: 'PASS', checks: [{ item: 'a', pass: true }, { item: 'b', pass: true }, { item: 'c', pass: true }, { item: 'd', pass: true }] } }, 'x')
  expect(badgeOf({ ...verified, stage: 'done' })).toEqual({ id: '01-slugify', stage: 'verified', text: 'verified 4/4' })
  const partial = parseTicket({ id: '02', status: 'verifying', verdict: { checks: [{ item: 'a', pass: true }, { item: 'b', pass: false }, { item: 'c', pass: null }] } }, 'x')
  expect(badgeOf(partial).text).toBe('verifying 1/3')
  expect(badgeOf(ticket('03-x')).text).toBe('building')
  expect(badgeOf({ ...ticket('04-y'), stage: 'unverified' }).text).toBe('unverified')
})

test('ticketBadgeOf links an agent to its ticket badge, else undefined', () => {
  const r = run()
  expect(ticketBadgeOf({ label: 'verify 01-slugify' }, r)).toEqual({ id: '01-slugify', stage: 'building', text: 'building' })
  expect(ticketBadgeOf({ label: 'Fix the lanes' }, r)).toBeUndefined()
  expect(ticketBadgeOf({ label: 'verify 01-slugify' }, undefined)).toBeUndefined()
})

test('tagOf is the leading ticket number, else the first characters', () => {
  expect(tagOf('02-is-palindrome')).toBe('02')
  expect(tagOf('7')).toBe('7')
  expect(tagOf('login-form')).toBe('login-')
})

test('plainTitle reuses the canonical ticket cleaner', () => {
  expect(plainTitle('T64 · avatar redesign (sonnet/low)')).toBe('Avatar redesign')
  expect(plainTitle('T59: verifier chips')).toBe('Verifier chips')
  expect(plainTitle('t7 - fix lanes')).toBe('Fix lanes')
  expect(plainTitle('Redesign agent avatars')).toBe('Redesign agent avatars')
  expect(plainTitle('Fix (read/write path)')).toBe('Fix (read/write path)')
  expect(plainTitle('Tests for T64 fixes')).toBe('Tests for fixes')
  expect(plainTitle('T64')).toBe('')
  expect(plainTitle('')).toBe('')
})
