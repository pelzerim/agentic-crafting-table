import test from 'node:test';
import assert from 'node:assert/strict';
import { browserUrl, clipboardUrls } from './browser-url.ts';

test('browser links preserve destinations and reject non-browser schemes, credentials, control bytes and oversized input', () => {
  assert.equal(browserUrl('https://example.com/pr/42?a=1&b=two#review'), 'https://example.com/pr/42?a=1&b=two#review');
  assert.equal(browserUrl('https://example.com/a b'), 'https://example.com/a%20b');
  assert.equal(browserUrl('http://localhost:3000'), 'http://localhost:3000/');
  for (const input of [null, {}, '', 'javascript:alert(1)', 'data:text/html,test', 'file:///etc/passwd', 'mailto:a@b.c', 'https://user:password@example.com', 'https://exa\nmple.com', 'https://example.com/\x1b[2J', 'https://example.com/' + 'a'.repeat(8192)]) assert.throws(() => browserUrl(input));
});

test('Copy URL takes one browser link or a short list, one per line, and refuses the list if any entry is not one', () => {
  assert.equal(clipboardUrls('https://example.com/pr/42'), 'https://example.com/pr/42');
  assert.equal(clipboardUrls(['https://example.com/a b', 'http://localhost:3000']), 'https://example.com/a%20b\nhttp://localhost:3000/');
  for (const input of [[], null, ['https://example.com/', 'javascript:alert(1)'], [['https://example.com/']], Array(201).fill('https://example.com/')]) assert.throws(() => clipboardUrls(input));
  assert.equal(clipboardUrls(Array(200).fill('https://example.com/')).split('\n').length, 200);
});
