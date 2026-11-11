import test from 'node:test';
import assert from 'node:assert/strict';
import { block, maskSecrets, oneLine, REDACTED } from './global/redact.mjs';

// Built from fragments at run time so secret scanners (GitHub push protection) do not flag this file; the value is fake.
const AWS_KEY = 'AKIA' + 'ABCDEFGHIJKLMNOP';

const CASES = [
  ['sk-test-abcdefghijklmnopqrstuvwx', 'my key is sk-test-abcdefghijklmnopqrstuvwx ok'],
  ['hunter2hunter', 'password: hunter2hunter'],
  ['ghp_abcdefghijklmnopqrstuvwxyz0123', 'token ghp_abcdefghijklmnopqrstuvwxyz0123'],
  [AWS_KEY, `aws ${AWS_KEY} here`],
  ['s3cr3tvalue', 'export MY_API_KEY=s3cr3tvalue'],
  ['abc.def.ghi-jkl', 'Authorization: Bearer abc.def.ghi-jkl'],
  ['plainsecretvalue', 'Authorization: plainsecretvalue'],
  ['pw123456', 'curl https://admin:pw123456@host.example/x'],
  ['MIIEvQIBADANBgkqhkiG9w0BAQEFAASC', '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----'],
  ['MIIEvQIBADANBgkq', '-----BEGIN RSA PRIVATE KEY-----\nMIIEvQIBADANBgkq'], // unterminated block masks to the end
  ['x7Kq9Zp2Lm4Nv8Bc1Rd5Sf3Tg6Hj0Wy2Ue4Ia8Ok', 'blob x7Kq9Zp2Lm4Nv8Bc1Rd5Sf3Tg6Hj0Wy2Ue4Ia8Ok end'],
  ['eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc', 'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc'],
  ['--password hunter99', 'run login --password hunter99 now'],
];

test('every secret shape is masked and the surrounding words stay', () => {
  for (const [secret, text] of CASES) {
    const out = maskSecrets(text);
    assert.ok(!out.includes(secret.replace('--password ', '')) || secret.startsWith('--'), `leaked ${secret}: ${out}`);
    assert.ok(out.includes(REDACTED), out);
  }
  assert.ok(!maskSecrets('run login --password hunter99 now').includes('hunter99'));
});

test('ordinary text, paths, long words and newlines survive', () => {
  const text = 'Edit /Users/x/some/very/long/path/that/goes/on/and/on/forever/and/ever/file.ts\nsecond line, tokens are cheap';
  assert.equal(maskSecrets(text), text);
  assert.equal(maskSecrets('supercalifragilisticexpialidocious_and_more_letters_only_words'), 'supercalifragilisticexpialidocious_and_more_letters_only_words');
});

test('oneLine collapses and cuts; block keeps newlines; non-strings are empty', () => {
  assert.equal(oneLine('a\n  b\t c', 50), 'a b c');
  assert.equal(oneLine('x'.repeat(100), 10).length, 10);
  assert.equal(block('a\r\nb', 50), 'a\nb');
  assert.equal(maskSecrets(undefined), '');
  assert.equal(maskSecrets(12), '');
});

test('a transcript text with a secret never reaches the view output (end to end is in global-view.test.mjs)', () => {
  assert.equal(oneLine('deploy with --token abcdef123456 now', 80), `deploy with --token ${REDACTED} now`);
});
