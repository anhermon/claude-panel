import { expect, test } from 'claude-code/testing'
import { profileOf, LONG_SESSION_CALLS } from '../hooks/session-context'
import { pushForm, staleForms, startSession } from '../hooks/context-history'
import type { HistorySession } from '../hooks/context-history'
import { JOB_FORMS, MOTION_FORMS, suggestFor, SUGGEST_LIMIT } from '../hooks/suggest'

const profile = (prompt = 'Build a cache') => profileOf({ prompt, markers: [], toolCounts: {} })

test('suggestFor rotates deterministically, stays bounded and filters stale forms', () => {
  const first = suggestFor(profile(), ['steps'], 0)
  expect(first.forms).not.toContain('steps')
  expect(first.note).toContain('steps')
  expect(first.forms.length).toBeLessThanOrEqual(SUGGEST_LIMIT)
  expect(suggestFor(profile(), [], 0)).toEqual(suggestFor(profile(), [], 0))
  expect(suggestFor(profile(), [], 0).forms).not.toEqual(suggestFor(profile(), [], 1).forms)
  expect(suggestFor(profile(), [], -1).forms[0]).toBe(JOB_FORMS.build.at(-1))
})

test('all stale falls back to fitting candidates; chat offers nothing', () => {
  expect(suggestFor(profile(), JOB_FORMS.build, 0).forms.length).toBeGreaterThan(0)
  expect(suggestFor({ ...profile(), isLong: true }, JOB_FORMS.build, 0).forms).toEqual(['limits'])
  expect(suggestFor({ ...profile(), isLong: true }, ['limits'], 0).forms).not.toContain('limits')
  expect(suggestFor(profile('Thanks'), [], 0)).toEqual({ forms: [], note: '' })
})

test('all six new forms appear for their jobs and limits fits any long work session', () => {
  const cases = [['Build it', 'testresults'], ['Deploy it', 'testresults'], ['Debug it', 'hypotheses'],
    ['Choose an option', 'decisionmatrix'], ['Research it', 'sources'], ['Review it', 'riskgrid']] as const
  for (const [prompt, form] of cases) expect(suggestFor(profile(prompt), [], 0).forms).toContain(form)
  for (const job of Object.keys(JOB_FORMS).filter(job => job !== 'chat')) {
    expect(suggestFor({ ...profile(), job: job as keyof typeof JOB_FORMS, isLong: true, totalCalls: LONG_SESSION_CALLS }, [], 1).forms).toContain('limits')
  }
})

test('stack evidence changes the candidates while forms stay generic', () => {
  const plain = suggestFor(profile('Review it'), [], 0)
  const tested = suggestFor({ ...profile('Review it'), stack: ['test suite'] }, [], 0)
  expect(tested.forms).toContain('testresults')
  expect(tested.forms).not.toEqual(plain.forms)
})

test('motion and media prompts put the motion kinds first; other prompts do not', () => {
  const motion = suggestFor(profile('Build a beat-synced particle animation'), [], 0)
  expect(motion.forms.every(f => (MOTION_FORMS as readonly string[]).includes(f))).toBe(true)
  expect(profile('Sync the cuts of the video to the audio beat').motion).toBe(true)
  expect(profile('Build a cache').motion).toBe(false)
  expect(suggestFor(profile('Build a cache'), [], 0).forms.some(f => (MOTION_FORMS as readonly string[]).includes(f))).toBe(false)
  expect(suggestFor(profile('Thanks for the animation'), [], 0).forms).toEqual([])
})

const SIMULATED_SESSIONS = 12
const WINDOW = 5
const MAX_PER_WINDOW = 2

test('across many sessions of the same job the suggested lead form changes: no form leads in more than two of any five sessions', () => {
  for (const prompt of ['Build a cache', 'Debug a failing test', 'Compare two queues', 'Review this module']) {
    let history: HistorySession[] = []
    const leads: string[] = []
    for (let i = 0; i < SIMULATED_SESSIONS; i++) {
      const p = profile(prompt)
      const lead = suggestFor(p, staleForms(history), i).forms[0]!
      leads.push(lead)
      history = pushForm(startSession(history, `s${i}`, p.job, i), `s${i}`, lead)
    }
    for (let i = 0; i + WINDOW <= leads.length; i++) {
      const window = leads.slice(i, i + WINDOW)
      for (const form of new Set(window)) expect(window.filter(f => f === form).length).toBeLessThanOrEqual(MAX_PER_WINDOW)
    }
    expect(new Set(leads).size).toBeGreaterThanOrEqual(3)
  }
})
