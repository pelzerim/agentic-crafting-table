import test from 'node:test';
import assert from 'node:assert/strict';
import { scanText } from './public-safety.mjs';

const word = (...parts: string[]) => parts.join('');
const rules = (text: string) => scanText(text).map((hit: { rule: string }) => hit.rule);

test('credentials, account ids, personal paths, internal hosts, real emails and session links are found', () => {
  assert.deepEqual(rules(`token ${word('gh', 'p_')}${'a'.repeat(36)}`), ['credential']);
  assert.deepEqual(rules(`key ${word('sk-', 'ant-')}api03-${'b'.repeat(20)}`), ['credential']);
  assert.deepEqual(rules(`${word('AK', 'IA')}${'C'.repeat(16)}`), ['credential']);
  assert.deepEqual(rules(word('-----BEGIN OPENSSH ', 'PRIVATE KEY-----')), ['credential']);
  assert.deepEqual(rules(`arn:aws:iam::${'1'.repeat(12)}:role/x`), ['aws-account']);
  assert.deepEqual(rules(`cwd ${word('/Us', 'ers/')}alice/work`), ['home-path']);
  assert.deepEqual(rules('cwd /Users/example/work and /Users/me'), []);
  assert.deepEqual(rules(`build.${word('co', 'rp')} and api.${word('inter', 'nal')}`), ['internal-host']);
  assert.deepEqual(rules(`mail alice${word('@', 'acme-mail.io')}`), ['email']);
  assert.deepEqual(rules('fixture@example.com, a@example.invalid, x@users.noreply.github.com, git@github.com, noreply@anthropic.com'), []);
  assert.deepEqual(rules(`https://${word('claude.ai/code/', 'session')}_01`), ['session-link']);
});

test('a fake credential in a test is allowed on a line marked as fake; the mark allows nothing else', () => {
  const fake = `${word('AK', 'IA')}${'C'.repeat(16)}`, mark = word('public-safety', ': fake');
  assert.deepEqual(rules(`'${fake}', // ${mark}`), []);
  assert.deepEqual(rules(`'${fake}' cwd ${word('/Us', 'ers/')}alice // ${mark}`), ['home-path']);
});

test('the scan names nothing private: no word list, hashed or not', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('./public-safety.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /[0-9a-f]{64}/);
});
