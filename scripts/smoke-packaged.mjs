import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { spawn, execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { executableIn, linuxSandboxRestricted, stagedBundle } from './local-bundle.mjs';

if (linuxSandboxRestricted()) throw new Error('This system lets only AppArmor-profiled programs start the Chromium sandbox. Run npm run sandbox:linux once, then retry.');
const directory = await mkdtemp(join(tmpdir(), 'craft-package-smoke-'));
const executable = resolve(process.env.ACT_PACKAGED_EXECUTABLE ?? executableIn(stagedBundle));
const report = join(directory, 'report.json');
const nativeConfig = join(directory, 'claude-history'), nativeFolder = join(nativeConfig, 'projects', directory.replace(/[^a-zA-Z0-9]/g, '-'));
await mkdir(nativeFolder, { recursive: true });
const savedId = '00000000-0000-4000-8000-000000000001';
await writeFile(join(nativeFolder, savedId + '.jsonl'), JSON.stringify({ type: 'user', uuid: '00000000-0000-4000-8000-000000000002', sessionId: savedId, cwd: directory, isSidechain: false, timestamp: new Date().toISOString(), message: { role: 'user', content: 'Packaged saved conversation' } }) + '\n');
try {
  if (process.platform === 'darwin') {
    // Electron's native notification API requires a signed bundle, not merely a
    // linker-signed executable. Local ad-hoc signatures are not notarization.
    execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', dirname(dirname(dirname(executable)))], { stdio: 'pipe' });
  }
  const child = spawn(executable, [`--smoke-report=${report}`], { env: { ...process.env, ACT_TEST_DATA_DIR: directory, CLAUDE_CONFIG_DIR: nativeConfig, SHELL: '/bin/sh' }, stdio: 'inherit' });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 30_000);
  try {
    const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
    assert.equal(code, 0, 'Packaged desktop must exit successfully');
  } finally { clearTimeout(timeout); }
  const result = JSON.parse(await readFile(report, 'utf8'));
  assert.equal(result.packaged, true);
  assert.equal(result.savedSessions.sessions[0].id, savedId);
  assert.equal(result.savedSessions.sessions[0].title, 'Packaged saved conversation');
  assert.equal(result.runtimeNode, result.versions.node);
  assert.deepEqual(result.pty, { input: true, resize: true, exitCode: 0 });
  assert.equal(result.workspace.state.revision, 0, 'Packaged service opens real SQLite');
  assert.deepEqual(result.nativeTerminal, { state: 'running', cols: 76, rows: 29 });
  const placement = JSON.parse(await readFile(join(directory, 'window-state.json'), 'utf8'));
  assert.equal(placement.version, 1);
  assert.deepEqual(placement.bounds, result.window.bounds, 'Packaged close saves the actual native window geometry');
  if (process.env.ACT_TEST_SHOW_WINDOW !== '1') {
    assert.equal(result.window.visible, false, 'Packaged smoke must not show a window');
    assert.equal(result.window.focused, false, 'Packaged smoke must not steal focus');
    assert.equal(result.window.focusable, false);
    if (process.platform === 'darwin') assert.equal(result.window.dockVisible, false);
  }
  console.log(`Packaged app passed: Electron ${result.versions.electron}, background Node ${result.runtimeNode}; real PTY input, resize and exit.`);
} finally { await rm(directory, { recursive: true, force: true }); }
