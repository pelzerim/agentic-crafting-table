import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { findCodexExecutable } from './codex-executable.ts';

const posixOnly = { skip: process.platform === 'win32' };
const TRIPLE = 'x86_64-pc-windows-msvc';
async function folder(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'act-codex-exe-'));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}
async function file(path: string, text = '', mode = 0o755) { await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, text, { mode }); }
const windows = (root: string, extra: Partial<Parameters<typeof findCodexExecutable>[1]> = {}) => ({ platform: 'win32' as const, arch: 'x64', home: join(root, 'home'), codexHome: join(root, 'home', '.codex'), appData: join(root, 'AppData'), ...extra });
const NPM_CMD = '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n';

test('a native codex.exe on PATH wins', posixOnly, () => folder(async root => {
  const bin = join(root, 'bin');
  await file(join(bin, 'codex.exe'));
  assert.equal(findCodexExecutable(bin, windows(root)), join(bin, 'codex.exe'));
}));

test('an npm install on Windows, which puts only codex.cmd on PATH, runs its native codex.exe', posixOnly, () => folder(async root => {
  const npm = join(root, 'AppData', 'npm'), native = join(npm, 'node_modules', '@openai', 'codex', 'node_modules', '@openai', 'codex-win32-x64', 'vendor', TRIPLE, 'bin', 'codex.exe');
  await file(join(npm, 'codex.cmd'), NPM_CMD); await file(join(npm, 'node_modules', '@openai', 'codex', 'bin', 'codex.js'), ''); await file(native);
  assert.equal(findCodexExecutable(npm, windows(root)), native);
  // %APPDATA%\npm is where npm puts global scripts even when a launch's PATH lacks it.
  assert.equal(findCodexExecutable(join(root, 'elsewhere'), windows(root)), native);
}));

test('a hoisted platform package and a pnpm store layout are both found from the script', posixOnly, () => folder(async root => {
  const hoisted = join(root, 'hoisted'), hoistedNative = join(hoisted, 'node_modules', '@openai', 'codex-win32-x64', 'vendor', TRIPLE, 'bin', 'codex.exe');
  await file(join(hoisted, 'codex.ps1'), '& "node$exe"  "$basedir/node_modules/@openai/codex/bin/codex.js" $args'); await file(join(hoisted, 'node_modules', '@openai', 'codex', 'bin', 'codex.js')); await file(hoistedNative);
  assert.equal(findCodexExecutable(hoisted, windows(root, { appData: undefined })), hoistedNative);

  // pnpm links the package from its store, where the platform package is a sibling in the parent node_modules.
  const pnpm = join(root, 'pnpm'), store = join(pnpm, 'global', '5', 'node_modules', '.pnpm', '@openai+codex@1.0.0', 'node_modules');
  const pnpmNative = join(store, '@openai', 'codex-win32-x64', 'vendor', TRIPLE, 'bin', 'codex.exe');
  await file(join(store, '@openai', 'codex', 'bin', 'codex.js')); await file(pnpmNative);
  await mkdir(join(pnpm, 'global', '5', 'node_modules', '@openai'), { recursive: true });
  await symlink(join(store, '@openai', 'codex'), join(pnpm, 'global', '5', 'node_modules', '@openai', 'codex'), 'dir');
  await file(join(pnpm, 'codex.cmd'), '@SETLOCAL\r\n"%~dp0\\node.exe" "%~dp0\\global\\5\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n');
  assert.equal(findCodexExecutable([join(root, 'empty'), pnpm].join(delimiter), windows(root, { appData: undefined })), pnpmNative);
}));

test('the standalone installer folder is found without PATH, and a script without its native program is not used', posixOnly, () => folder(async root => {
  const standalone = join(root, 'home', '.codex', 'packages', 'standalone', 'current', 'bin', 'codex');
  await file(standalone);
  assert.equal(findCodexExecutable('', { platform: 'linux', home: join(root, 'home'), codexHome: join(root, 'home', '.codex') }), standalone);
  const npm = join(root, 'AppData', 'npm');
  await file(join(npm, 'codex.cmd'), NPM_CMD);
  assert.equal(findCodexExecutable(npm, windows(root)), undefined);
  assert.equal(findCodexExecutable(npm, windows(root, { arch: 'ia32' })), undefined);
}));
