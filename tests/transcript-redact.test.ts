// What may reach the page from a transcript: secrets, home folders and control characters are gone, texts are cut, tool calls show a
// short safe label, an error shows its first line only.
import { expect, test } from 'claude-code/testing'

import { callLabel, clip, errorLine, excerpt, scrubText, TEXT_CAPS } from '../hooks/transcript-redact'

const REDACTED = '[redacted]'

// Built from fragments at run time so secret scanners (GitHub push protection) do not flag this file; the values are fake.
const AWS_KEY = 'AKIA' + 'ABCDEFGHIJKLMNOP'
const PEM_BEGIN = '-----BEGIN RSA ' + 'PRIVATE KEY-----'
const PEM_END = '-----END RSA ' + 'PRIVATE KEY-----'

test('scrubText: tokens, auth headers, URL passwords, named secrets and key blocks are replaced', () => {
  const dirty = [
    'curl -H "Authorization: Bearer abcdef1234567890abcdef" https://user:hunter2@example.com/x',
    'export API_KEY=supersecretvalue and password: "p4ss w0rd"',
    'key sk-abcdefghijklmnop1234 and ghp_abcdefghijklmnopqrstuvwx and ' + AWS_KEY,
    PEM_BEGIN + '\nMIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf9Cnzj4p4WGeKLs1Pt8Qu\n' + PEM_END,
  ].join('\n')
  const clean = scrubText(dirty)
  for (const secret of ['abcdef1234567890abcdef', 'hunter2', 'supersecretvalue', 'p4ss', 'sk-abcdefghijklmnop1234', 'ghp_abcdefghijklmnopqrstuvwx', AWS_KEY, 'MIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf9Cnzj4p4WGeKLs1Pt8Qu'])
    expect(clean).not.toContain(secret)
  expect(clean).toContain(REDACTED)
})

test('scrubText: prose that only mentions tokens or authors is left alone; the home folder becomes ~; control characters and long blobs go', () => {
  expect(scrubText('tokens: 1200 and author: Ada')).toBe('tokens: 1200 and author: Ada')
  expect(scrubText('open /Users/alice/work/app.ts and /home/bob/x')).toBe('open ~/work/app.ts and ~/x')
  expect(scrubText('a\u0000b\u001b[31mc\n\n d')).not.toMatch(/[\u0000-\u0008\u000b-\u001f]/)
  expect(scrubText(`blob ${'A1b2'.repeat(15)} end`)).toBe(`blob ${REDACTED} end`)
})

test('clip and excerpt: cut with an ellipsis at the cap, scrub before cutting', () => {
  expect(clip('abcdef', 4)).toBe('abc…')
  expect(clip('abc', 4)).toBe('abc')
  const said = excerpt(`password=hunter2 ${'x '.repeat(500)}`, TEXT_CAPS.SAY_CHARS)
  expect(said.length).toBeLessThanOrEqual(TEXT_CAPS.SAY_CHARS)
  expect(said).not.toContain('hunter2')
})

test('callLabel: a file shows its basename, a command its first line without the cd lead, an agent its description; secrets in them are scrubbed', () => {
  expect(callLabel('Read', { file_path: '/Users/me/proj/src/deep/board.ts' })).toBe('board.ts')
  expect(callLabel('Bash', { command: 'cd /Users/me/proj && npm test -- board\nsecond line' })).toBe('npm test -- board')
  expect(callLabel('Bash', { command: 'curl -H "Authorization: Bearer abcdef1234567890abcdef" https://x.io' })).not.toContain('abcdef1234567890abcdef')
  expect(callLabel('Agent', { description: 'T43 classifier (sonnet/low)' })).toBe('T43 classifier (sonnet/low)')
  expect(callLabel('Grep', { pattern: 'agentInsight' })).toBe('agentInsight')
  expect(callLabel('Skill', { skill: 'panel:panel-guide' })).toBe('panel:panel-guide')
  expect(callLabel('Bash', { command: 'x'.repeat(500) }).length).toBeLessThanOrEqual(TEXT_CAPS.COMMAND_CHARS)
})

test('errorLine: only the first line of the result, from a string or text blocks, scrubbed and cut; none -> empty', () => {
  expect(errorLine('Error: boom\n  at stack line 1\n  at stack line 2')).toBe('Error: boom')
  expect(errorLine([{ type: 'text', text: '\n\nENOENT: no such file /Users/me/x\nmore' }])).toBe('ENOENT: no such file ~/x')
  expect(errorLine(undefined)).toBe('')
  expect(errorLine('token=abcdefgh12345678 failed')).not.toContain('abcdefgh12345678')
  expect(errorLine('e'.repeat(1000)).length).toBeLessThanOrEqual(TEXT_CAPS.ERROR_CHARS)
})
