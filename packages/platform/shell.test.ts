import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { findExecutable, resolveShellPath } from './shell.ts';

test('Dock-style launch finds hook runtimes in the login shell PATH without importing shell output', async () => {
  const home = await mkdtemp(join(tmpdir(), 'craft-shell-path-'));
  try {
    const shell = join(home, 'shell'), node = join(home, 'node');
    await writeFile(shell, '#!/bin/sh\nprintf "profile noise\\n"\nexport PATH="'+home+':/usr/bin:/bin"\nexec /bin/sh -c "$2"\n', { mode: 0o700 });
    await writeFile(node, '#!/bin/sh\nprintf HOOK_NODE_OK\n', { mode: 0o700 });
    const path = await resolveShellPath({ PATH: '/usr/bin:/bin', SHELL: shell }, home);
    assert.equal(path.split(':').filter(p => p === '/usr/bin').length, 1);
    assert.ok(!path.includes('profile noise'));
    const result = await promisify(execFile)('/bin/sh', ['-c', 'node'], { env: { PATH: path } });
    assert.equal(result.stdout, 'HOOK_NODE_OK');
    const fallback = await resolveShellPath({ PATH: 'relative::/bin:/bin', SHELL: '/missing-shell' }, home);
    assert.ok(fallback.includes(join(home, '.local/bin')));
    assert.ok(!fallback.includes('relative')); assert.equal(fallback.split(':').filter(p => p === '/bin').length, 1);
    await writeFile(shell, '#!/bin/sh\nexec /bin/sleep 10\n', { mode: 0o700 });
    const start = Date.now();
    assert.ok((await resolveShellPath({ SHELL: shell }, home, 80)).includes('/usr/bin'));
    assert.ok(Date.now() - start < 2000, 'slow shell profiles are bounded');
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('findExecutable takes the first executable file on the path, then the fallback directories', async () => {
  const root = await mkdtemp(join(tmpdir(), 'craft-find-executable-'));
  try {
    const plain = join(root, 'plain'), folder = join(root, 'folder'), first = join(root, 'first'), second = join(root, 'second'), fallback = join(root, 'fallback');
    await Promise.all([plain, folder, first, second, fallback].map(directory => mkdir(directory)));
    await writeFile(join(plain, 'tool'), '', { mode: 0o600 });
    await mkdir(join(folder, 'tool'));
    await writeFile(join(fallback, 'tool'), '', { mode: 0o700 });
    assert.equal(findExecutable('tool', [plain, folder, first].join(delimiter), [fallback]), join(fallback, 'tool'));
    await writeFile(join(second, 'tool'), '', { mode: 0o700 });
    assert.equal(findExecutable('tool', ['', plain, second].join(delimiter), [fallback]), join(second, 'tool'));
    assert.equal(findExecutable('missing', second, [fallback]), undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});
