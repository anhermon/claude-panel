import { expect, test } from 'claude-code/testing'
import { CONFIDENCE, jobOf, JOB_RULES, LONG_SESSION_CALLS, profileOf, stackOf, STACK_RULES } from '../hooks/session-context'

const JOB_CASES = [
  ['build', 'Implement a cache'], ['debug', 'Diagnose a failing test'], ['research', 'Research cache eviction'],
  ['review', 'Review the diff'], ['decide', 'Choose between two databases'], ['explain', 'Explain the event loop'],
  ['ops', 'Deploy the service'], ['chat', 'Thanks!'], ['chat', 'What time is it?'],
  ['chat', 'What is a bug?'], ['chat', 'What are sources?'], ['chat', 'Is production healthy?'],
] as const

test('jobOf covers every job and each named rule deterministically', () => {
  for (const [job, prompt] of JOB_CASES) {
    expect(jobOf(prompt).job, prompt).toBe(job)
    expect(jobOf(prompt)).toEqual(jobOf(prompt))
  }
  expect(new Set(JOB_CASES.map(([job]) => job)).size).toBe(JOB_RULES.length + 1)
  expect(jobOf('Review this build before we deploy').job).toBe('review')
  expect(jobOf('Fix it').confidence).toBe(CONFIDENCE.MATCH)
  expect(jobOf('')).toMatchObject({ job: 'chat' })
})

test('stackOf covers every marker, deduplicates labels and never echoes arbitrary entries or branches', () => {
  for (const rule of STACK_RULES) for (const marker of rule.markers) expect(stackOf([marker])).toEqual([rule.label])
  expect(stackOf(['pyproject.toml', 'requirements.txt', 'tests', '__tests__'])).toEqual(['Python', 'test suite'])
  expect(stackOf(['private-project', '/private/work'], 'feature/private-person')).toEqual(['git repo'])
  expect(stackOf(['.git'], 'main')).toEqual(['git repo'])
  expect(stackOf([])).toEqual([])
})

test('profileOf combines the job, generic stack and valid tool counts without retaining source text', () => {
  const profile = profileOf({ prompt: 'Build private-project', markers: ['tsconfig.json'], toolCounts: { Read: LONG_SESSION_CALLS, odd: NaN, negative: -1 } })
  expect(profile).toMatchObject({ job: 'build', stack: ['TypeScript'], totalCalls: LONG_SESSION_CALLS, isLong: true })
  expect(JSON.stringify(profile)).not.toContain('private-project')
})

const PASTE_FILLER = 'lorem ipsum dolor sit amet '
const LONG_LOG = `Error: connect ECONNREFUSED 127.0.0.1:5432 NODE_ENV=production what is wrong? ${PASTE_FILLER.repeat(40)}`
const LONG_TODO = `${PASTE_FILLER.repeat(40)} // TODO review later ${PASTE_FILLER.repeat(10)}`
const REAL_CASES = [
  ['build', 'Add a dark mode toggle to the settings page'], ['debug', 'fix the failing login test'],
  ['debug', 'why is the dashboard so slow?'], ['debug', 'why is the dashboard loading slowly on first paint, can you profile it'],
  ['decide', 'compare Postgres and MySQL for our workload'], ['ops', 'deploy it'], ['review', 'review this PR for security issues'],
  ['review', 'can you look at src/auth.ts and tell me if the token refresh is correct'],
  ['debug', "TypeError: Cannot read properties of undefined (reading 'id') at handler (src/app.js:10:5)"],
  ['build', 'Refactor the payment module to use the new client'], ['chat', 'is the build green?'],
  ['build', 'add a unit test for the parser and make sure CI passes'], ['debug', LONG_LOG],
  ['explain', LONG_TODO], ['decide', 'should we use Redis or an in-process LRU for the session cache?'],
  ['build', 'rename foo to bar across the repo'], ['ops', 'push it'], ['chat', 'can you check the time?'],
] as const

test('jobOf classifies realistic prompts: questions, symptoms, pastes, nouns and vague commands', () => {
  for (const [job, prompt] of REAL_CASES) expect(jobOf(prompt).job, prompt.slice(0, 60)).toBe(job)
  expect(jobOf(LONG_TODO).job).not.toBe('review')
})
