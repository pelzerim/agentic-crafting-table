import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inputSchema } from './protocol.ts';

test('terminal input preserves Unicode by default and validates explicit binary byte strings', () => {
  const unicode = { sessionId: 'fixture', data: '你好 · ✓' };
  assert.deepEqual(inputSchema.parse(unicode), unicode);
  const binary = { sessionId: 'fixture', data: '\x1b[M\x60\xa2\xff', encoding: 'binary' };
  assert.deepEqual(inputSchema.parse(binary), binary);
  assert.equal(inputSchema.safeParse({ ...binary, data: '你好' }).success, false);
  assert.equal(inputSchema.safeParse({ ...binary, data: 'x'.repeat(65537) }).success, false);
  assert.equal(inputSchema.safeParse({ ...binary, encoding: 'unsupported' }).success, false);
});
