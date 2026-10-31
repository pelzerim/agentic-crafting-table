import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { defaultShell, envCommand, executableName, findExecutable, isShadowedPath, resolveShellPath, terminalShellArgs } from './shell.ts';

const posixOnly = { skip: process.platform === 'win32' };
test('Dock-style launch finds hook runtimes in the login shell PATH without importing shell output', posixOnly, async () => {
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

test('findExecutable takes the first executable file on the path, then the fallback directories', posixOnly, async () => {
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

test('Windows starts PowerShell unless a Windows shell is configured', () => {
  assert.match(defaultShell(undefined, 'win32'), /System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/);
  assert.match(defaultShell('/usr/bin/bash', 'win32'), /powershell\.exe$/);
  assert.equal(defaultShell('C:\\Program Files\\PowerShell\\7\\pwsh.exe', 'win32'), 'C:\\Program Files\\PowerShell\\7\\pwsh.exe');
  assert.deepEqual(terminalShellArgs('win32'), []);
});

test('Windows assigns variables through cmd.exe and refuses words cmd.exe would read as syntax', () => {
  assert.deepEqual(envCommand(['ELECTRON_RUN_AS_NODE=1'], ['C:\\App Dir\\act.exe', 'hook.cjs'], 'win32'), { command: 'cmd.exe', args: ['/d', '/c', 'set', 'ELECTRON_RUN_AS_NODE=1&&', 'C:\\App Dir\\act.exe', 'hook.cjs'] });
  assert.deepEqual(envCommand([], ['C:\\node.exe', 'hook.cjs'], 'win32'), { command: 'C:\\node.exe', args: ['hook.cjs'] });
  assert.throws(() => envCommand(['ELECTRON_RUN_AS_NODE=1'], ['C:\\A&B\\act.exe'], 'win32'), /cmd\.exe/);
});

test('Windows looks only for real executables and treats Path as a duplicate of PATH', () => {
  assert.equal(executableName('claude', 'win32'), 'claude.exe');
  assert.equal(executableName('claude', 'linux'), 'claude');
  assert.equal(isShadowedPath('Path', 'win32'), true);
  assert.equal(isShadowedPath('PATH', 'win32'), false);
  assert.equal(isShadowedPath('Path', 'linux'), false);
});
