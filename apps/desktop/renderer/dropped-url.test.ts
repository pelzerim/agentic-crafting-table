import test from 'node:test';
import assert from 'node:assert/strict';
import { droppedUrl, mayContainUrl } from './dropped-url.ts';

const transfer = (values: Record<string, string>, files = false) => ({ types: [...Object.keys(values), ...(files ? ['Files'] : [])], getData: (type: string) => values[type] ?? '' });

test('external link payloads prefer URI identity and handle browser comments, titles and plain URL text', () => {
  assert.equal(droppedUrl(transfer({ 'text/uri-list': '# source\r\nhttps://github.com/acme/repo/pull/42\r\nhttps://example.org', 'text/plain': 'Pull request title' })), 'https://github.com/acme/repo/pull/42');
  assert.equal(droppedUrl(transfer({ 'text/x-moz-url': 'https://linear.app/acme/issue/APP-1\nIssue title' })), 'https://linear.app/acme/issue/APP-1');
  assert.equal(droppedUrl(transfer({ 'text/plain': '  https://acme.slack.com/archives/C01/p1234567890123456  ' })), 'https://acme.slack.com/archives/C01/p1234567890123456');
  assert.equal(droppedUrl(transfer({ 'text/uri-list': 'file:///tmp/one\nhttps://example.org/valid' })), 'https://example.org/valid');
  assert.equal(mayContainUrl({ types: ['text/uri-list'], getData() { throw new Error('Drag-over must not read protected payloads'); } }), true);
});

test('external drops reject files, unsafe schemes, credentials and non-URL text', () => {
  for (const value of ['not a link', 'Read https://example.org', 'https://one.test\nhttps://two.test', 'https://a.test/path with spaces', 'javascript:alert(1)', 'file:///tmp/file', 'data:text/html,hi', 'mailto:a@example.org', 'https://user:secret@example.org', `https://example.org/${'x'.repeat(8192)}`]) {
    assert.equal(droppedUrl(transfer({ 'text/plain': value })), undefined);
  }
  assert.equal(droppedUrl(transfer({ 'text/uri-list': 'https://example.org' }, true)), undefined);
  assert.equal(droppedUrl(transfer({ 'text/html': '<a href="https://example.org">Title</a>' })), undefined);
  assert.equal(droppedUrl(transfer({ 'text/x-moz-url': 'invalid\nhttps://title-is-not-the-link.test' })), undefined);
  assert.equal(mayContainUrl(transfer({ 'text/uri-list': 'https://example.org' }, true)), false);
});
