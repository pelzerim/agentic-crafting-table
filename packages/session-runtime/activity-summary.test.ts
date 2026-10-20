import test from 'node:test';
import assert from 'node:assert/strict';
import { summaryEvidence } from './activity-summary.ts';

test('summary evidence strips terminal escapes and known credentials before truncating', () => {
  const evidence = summaryEvidence('\x1b[32mRunning tests\x1b[0m\n' + [
    'Authorization: Bearer private-value', 'api_key="private-key"', 'password=private-password',
    'Bearer abcdefghijklmnop', 'ghp_abcdefghijklmnopqrstu', 'sk-ant-abcdefghijklmnopqrstuvwxyz',
    'AKIA1234567890ABCDEF', 'eyJhbGciOiJIUzI1NiJ9.payload.signature',
    'https://login:credential@example.com/path', '/Users/someone/project/test.ts',
    '-----BEGIN RSA PRIVATE KEY-----\n' + 'private'.repeat(1500) + '\n-----END RSA PRIVATE KEY-----',
    'Tests passed for billing',
  ].join('\n'));
  assert.ok(evidence.includes('Running tests')); assert.ok(evidence.includes('Tests passed for billing'));
  for (const secret of ['private-value', 'private-key', 'private-password', 'abcdefghijklmnop', 'AKIA123', 'eyJ', 'login:credential', 'someone', 'privateprivate']) assert.ok(!evidence.includes(secret), secret);
  assert.ok(evidence.includes('~/project/test.ts')); assert.ok(!evidence.includes('\x1b'));
  assert.equal(summaryEvidence('x'.repeat(20_000) + 'latest').length, 6000);
  assert.ok(summaryEvidence('x'.repeat(20_000) + 'latest').endsWith('latest'));
});

test('summary evidence redacts credentials in echoed commands with literal escaped line separators', () => {
  for (const separator of ['\\n', '\\r', '\\t']) {
    const evidence = summaryEvidence(`$ printf 'Running tests${separator}password=FAKE_PRIVATE_CREDENTIAL${separator}'\r\nRunning tests\r\npassword=FAKE_PRIVATE_CREDENTIAL\r\n`);
    assert.ok(!evidence.includes('FAKE_PRIVATE_CREDENTIAL'));
    assert.ok(evidence.includes('Running tests'));
    assert.equal(evidence.match(/\[redacted credential\]/g)?.length, 2);
  }
  const json = summaryEvidence(String.raw`{"text":"Starting\napi_key=private-value\n"}`);
  assert.ok(!json.includes('private-value'));
});

test('desktop tests cannot invoke the installed AI helper without an explicit fixture', async () => {
  const previous = process.env.ACT_TEST_DATA_DIR, fixture = process.env.ACT_SUMMARY_FIXTURE_LOG;
  process.env.ACT_TEST_DATA_DIR = '/isolated-test'; delete process.env.ACT_SUMMARY_FIXTURE_LOG;
  try {
    const { nativeSummaryClient } = await import('./activity-summary.ts');
    await assert.rejects(nativeSummaryClient('/unused').complete({ model: 'haiku', max_tokens: 64, thinking: { type: 'disabled' }, system: 'test', messages: [{ role: 'user', content: 'test' }] }, AbortSignal.timeout(1000)), /disabled in desktop tests/);
  } finally {
    if (previous === undefined) delete process.env.ACT_TEST_DATA_DIR; else process.env.ACT_TEST_DATA_DIR = previous;
    if (fixture === undefined) delete process.env.ACT_SUMMARY_FIXTURE_LOG; else process.env.ACT_SUMMARY_FIXTURE_LOG = fixture;
  }
});
