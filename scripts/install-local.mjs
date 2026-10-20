import { execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { installBundle, recoverBundle } from '../packages/desktop-update/install.ts';

if (process.platform !== 'darwin') throw new Error('The local installer currently supports macOS only');
const source = resolve('release/staged/mac-arm64/Agentic Crafting Table.app');
const destination = resolve('release/mac-arm64/Agentic Crafting Table.app');
const identifier = app => execFileSync('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', join(app, 'Contents/Info.plist')], { encoding: 'utf8' }).trim();
if (process.argv.slice(2).some(arg => arg !== '--recover-only')) throw new Error('Usage: npm run install:local [-- --recover-only]');
const assertStopped = async () => {
  const processes = execFileSync('/bin/ps', ['-ax', '-o', 'comm='], { encoding: 'utf8' }).split('\n');
  if (processes.some(command => [source, destination].some(app => command.trim().startsWith(app + '/')))) throw new Error('Quit Agentic Crafting Table before installing. The app or its background services are still running; no files were replaced.');
};
if (process.argv.includes('--recover-only')) {
  const result = await recoverBundle(destination, assertStopped);
  console.log(`Installer recovery: ${result.recovery ?? 'nothing pending'}\nWorkspace data was not changed.`);
} else {
  const result = await installBundle(source, destination, assertStopped, {
    async verify(staged, installed) {
      // Recovery runs first: an interrupted swap can temporarily omit Info.plist.
      if (identifier(staged) !== 'dev.agentcraftingtable.desktop' || (installed && identifier(installed) !== identifier(staged))) throw new Error('App bundle identity does not match');
      // Hold the installer lease while verifying this exact staged bundle.
      execFileSync(process.execPath, ['scripts/smoke-packaged.mjs'], { stdio: 'inherit', env: { ...process.env, ACT_PACKAGED_EXECUTABLE: join(staged, 'Contents/MacOS/Agentic Crafting Table') } });
    },
  });
  console.log(`${result.unchanged ? 'Already up to date: ' : 'Installed '}${result.destination}\n${result.unchanged ? 'No new app copy or backup was created.' : `Previous contents: ${result.backup ?? '(first installation)'}`}\nRecovery: ${result.recovery ?? 'not needed'}\nWorkspace data was not changed.`);
}
