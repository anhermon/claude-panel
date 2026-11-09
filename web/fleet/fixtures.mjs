// Synthetic registries and transcripts for the fleet tests. Nothing here is copied from a real session.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const SID = { A: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', B: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', C: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', D: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' };
export const FAKE_KEY = 'sk-test-FAKEFAKEFAKEFAKEFAKE1234';
export const mkTmp = (prefix = 'fleet-t-') => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
export const jl = (rows) => `${rows.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n')}\n`;

const ts = (ms) => new Date(ms).toISOString();
export const userRow = (text, at, extra = {}) => ({ type: 'user', timestamp: ts(at), cwd: '/Users/alice/proj', message: { role: 'user', content: text }, ...extra });
export const assistantRow = (blocks, at, { id = 'msg_1', usage, model = 'claude-test-1' } = {}) => ({
  type: 'assistant', timestamp: ts(at), message: { id, model, role: 'assistant', content: blocks, usage: usage ?? { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 100, cache_creation_input_tokens: 5 } },
});
export const toolUse = (id, name, input) => ({ type: 'tool_use', id, name, input });
export const toolResult = (id, content, isError = false, at = 0) => ({ type: 'user', timestamp: ts(at), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, ...(isError ? { is_error: true } : {}) }] } });

/** A typical transcript body: title, prompt with a secret, a split assistant message, an error, a turn duration, odd rows. */
export function sampleRows(now) {
  return [
    { type: 'ai-title', aiTitle: 'Fix the flaky login test' },
    userRow(`please use key ${FAKE_KEY} to fix <img src=x onerror=alert(1)>`, now - 60_000),
    assistantRow([{ type: 'text', text: 'Looking at the tests.' }], now - 50_000, { id: 'msg_1' }),
    assistantRow([toolUse('tu_1', 'Read', { file_path: '/Users/alice/proj/web/a.js' })], now - 49_000, { id: 'msg_1' }),
    toolResult('tu_1', 'file body', false, now - 48_000),
    assistantRow([toolUse('tu_2', 'Bash', { command: `cd /x && npm test -- --token ${FAKE_KEY}` })], now - 40_000, { id: 'msg_2', usage: { input_tokens: 5, output_tokens: 7, cache_read_input_tokens: 50, cache_creation_input_tokens: 0 } }),
    toolResult('tu_2', 'FAIL 3 tests\nmore', true, now - 30_000),
    { type: 'system', subtype: 'turn_duration', durationMs: 33_000, timestamp: ts(now - 29_000) },
    { type: 'brand-new-row-type', timestamp: ts(now - 28_000) },
    '{"type":"assistant","message": this is not json',
    { type: 'last-prompt', lastPrompt: `latest prompt with password: hunter22secret` },
    assistantRow([toolUse('tu_3', 'Edit', { file_path: '/Users/alice/proj/web/a.js' })], now - 5_000, { id: 'msg_3' }),
  ];
}

export const cfgFor = (over = {}) => ({
  tailBytes: 512 * 1024, rowMaxBytes: 4 * 1024 * 1024, bucketMs: 15 * 60_000, bucketsMax: 96, seenIdsMax: 4000, titleChars: 160, promptChars: 600, errorChars: 240, toolLabelChars: 120, ...over,
});
export const newCounters = () => ({ rowsParsed: 0, rowsUnparsed: 0, rowsSkipped: 0, rowsDropped: 0, filesRead: 0, filesSkipped: 0, bytesRead: 0 });
