import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isPrivateFile } from './private-files.ts';

test('only an owner-only regular file is private', async () => {
  const root = await mkdtemp(join(tmpdir(), 'craft-private-file-'));
  try {
    const owned = join(root, 'owned'), shared = join(root, 'shared'), link = join(root, 'link');
    await writeFile(owned, '', { mode: 0o600 });
    await writeFile(shared, '', { mode: 0o644 });
    await symlink(owned, link);
    assert.equal(isPrivateFile(owned), true);
    assert.equal(isPrivateFile(shared), false);
    assert.equal(isPrivateFile(link), false);
    assert.equal(isPrivateFile(root), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
