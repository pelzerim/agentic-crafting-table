import test from 'node:test';
import assert from 'node:assert/strict';
import { droppedPaths, pastedImage, pastedPath } from './terminal-input.ts';

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

test('dropped files are typed as their paths, one space apart', async () => {
  const shot = new File([], 'Shot 1.png', { type: 'image/png' }), notes = new File([], 'notes.txt', { type: 'text/plain' });
  const paths = new Map([[shot, '/Users/example/Desktop/Shot 1.png'], [notes, '/tmp/notes.txt']]);
  assert.equal(await droppedPaths([shot, notes], file => paths.get(file) ?? '', async () => assert.fail('a file on disk is not saved again')), '/Users/example/Desktop/Shot\\ 1.png /tmp/notes.txt');
});

test('a dropped image without a file behind it is saved like a paste', async () => {
  const image = new File([], 'image.png', { type: 'image/png' }), text = new File([], 'clip.txt', { type: 'text/plain' });
  assert.equal(await droppedPaths([image, text], () => '', async file => file === image ? '/tmp/saved.png' : assert.fail()), '/tmp/saved.png');
  assert.equal(await droppedPaths([], () => '', async () => ''), '');
});
