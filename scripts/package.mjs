import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { LINUX_BUNDLE_INFO, stagedBundle } from './local-bundle.mjs';

/** `npm run package` (after the build): stage an unsigned local bundle for this machine in release/staged. */
const builder = args => execFileSync(process.execPath, [resolve('node_modules/electron-builder/cli.js'), ...args], { stdio: 'inherit' });
if (process.platform === 'darwin') {
  builder(['--dir', '--mac', '--arm64']);
} else {
  const windows = process.platform === 'win32', prefix = windows ? 'win' : 'linux';
  builder(['--dir', windows ? '--win' : '--linux', `--${process.arch}`]);
  // Wrap electron-builder's flat directory like a macOS bundle, so the installer can swap `Contents` in place.
  const unpacked = resolve('release/staged', process.arch === 'x64' ? `${prefix}-unpacked` : `${prefix}-${process.arch}-unpacked`);
  rmSync(stagedBundle, { recursive: true, force: true });
  mkdirSync(stagedBundle, { recursive: true });
  renameSync(unpacked, join(stagedBundle, 'Contents'));
  const { version, build } = JSON.parse(readFileSync('package.json', 'utf8'));
  writeFileSync(join(stagedBundle, LINUX_BUNDLE_INFO), JSON.stringify({ identifier: build.appId, version }) + '\n');
  console.log(`Staged ${stagedBundle}`);
}
