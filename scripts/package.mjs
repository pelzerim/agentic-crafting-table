import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { LINUX_BUNDLE_INFO, stagedBundle } from './local-bundle.mjs';

/** `npm run package` (after the build): stage an unsigned local bundle for this machine in release/staged. */
const builder = resolve('node_modules/.bin/electron-builder');
if (process.platform === 'darwin') {
  execFileSync(builder, ['--dir', '--mac', '--arm64'], { stdio: 'inherit' });
} else {
  execFileSync(builder, ['--dir', '--linux', `--${process.arch}`], { stdio: 'inherit' });
  // Wrap electron-builder's flat directory like a macOS bundle, so the installer can swap `Contents` in place.
  const unpacked = resolve('release/staged', process.arch === 'x64' ? 'linux-unpacked' : `linux-${process.arch}-unpacked`);
  rmSync(stagedBundle, { recursive: true, force: true });
  mkdirSync(stagedBundle, { recursive: true });
  renameSync(unpacked, join(stagedBundle, 'Contents'));
  const { version, build } = JSON.parse(readFileSync('package.json', 'utf8'));
  writeFileSync(join(stagedBundle, LINUX_BUNDLE_INFO), JSON.stringify({ identifier: build.appId, version }) + '\n');
  console.log(`Staged ${stagedBundle}`);
}
