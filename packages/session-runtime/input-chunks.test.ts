import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_SESSION_INPUT, sessionInputChunks } from './input-chunks.ts';

test('input under the runtime limit stays one write', () => {
  assert.deepEqual(sessionInputChunks('short'), ['short']);
  assert.equal(sessionInputChunks('x'.repeat(MAX_SESSION_INPUT)).length, 1);
});

test('large input splits in order inside the limit', () => {
  const text = 'abcdefghij'.repeat(30_000), chunks = sessionInputChunks(text);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every(chunk => chunk.length <= MAX_SESSION_INPUT));
  assert.equal(chunks.join(''), text);
});

test('a chunk boundary never splits a surrogate pair', () => {
  const text = 'a' + '😀'.repeat(10), chunks = sessionInputChunks(text, 4);
  assert.equal(chunks.join(''), text);
  assert.ok(chunks.every(chunk => !/[\ud800-\udbff]$/.test(chunk)));
});
