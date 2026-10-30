import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { savePastedImage } from './pasted-images.ts';

test('a pasted image is private and old pastes are removed', () => {
  const directory = join(mkdtempSync(join(tmpdir(), 'act-pasted-')), 'images');
  try {
    const first = savePastedImage(directory, new Uint8Array([1, 2]));
    assert.deepEqual([...readFileSync(first)], [1, 2]);
    assert.equal(statSync(first).mode & 0o777, 0o600);
    assert.equal(statSync(directory).mode & 0o777, 0o700);
    const old = join(directory, 'old.png'); writeFileSync(old, 'x'); utimesSync(old, new Date(0), new Date(0));
    const second = savePastedImage(directory, new Uint8Array([3]));
    assert.deepEqual(readdirSync(directory).sort(), [first, second].map(path => path.slice(directory.length + 1)).sort());
  } finally { rmSync(join(directory, '..'), { recursive: true, force: true }); }
});

test('empty and oversized images are refused', () => {
  assert.throws(() => savePastedImage('/unused', new Uint8Array()), /under 32 MB/);
  assert.throws(() => savePastedImage('/unused', new Uint8Array(32 * 1024 * 1024 + 1)), /under 32 MB/);
});
