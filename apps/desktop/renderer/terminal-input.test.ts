import test from 'node:test';
import assert from 'node:assert/strict';
import { pastedImage, pastedPath } from './terminal-input.ts';

test('a pasted image path stays one shell word', () => {
  assert.equal(pastedPath('/tmp/a/b.png'), '/tmp/a/b.png');
  assert.equal(pastedPath('/Users/example/Library/Application Support/app/b.png'), '/Users/example/Library/Application\\ Support/app/b.png');
});

test('a paste is an image only when it has no text', () => {
  const file = new File([], 'image.png', { type: 'image/png' }), items = [{ kind: 'file', type: 'image/png', getAsFile: () => file }] as unknown as DataTransferItemList;
  assert.equal(pastedImage({ getData: () => '', items }), file);
  assert.equal(pastedImage({ getData: () => 'a table copied with its picture', items }), undefined);
  assert.equal(pastedImage({ getData: () => '', items: [] as unknown as DataTransferItemList }), undefined);
  assert.equal(pastedImage(null), undefined);
});
