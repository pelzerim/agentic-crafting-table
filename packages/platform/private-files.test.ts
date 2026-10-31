import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isPrivateFile } from './private-files.ts';

const posixOnly = { skip: process.platform === 'win32' };
test('only an owner-only regular file is private', posixOnly, async () => {
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

test('Windows reports no permission bits, so only the file kind and owner decide', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-private-win-'));
  try {
    const file = join(directory, 'token');
    await writeFile(file, 'secret', { mode: 0o666 });
    await chmod(file, 0o666);
    assert.equal(isPrivateFile(file, 'win32'), true);
    assert.equal(isPrivateFile(file, 'linux'), false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
