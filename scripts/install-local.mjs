import { execFileSync } from 'node:child_process';
import { installBundle, recoverBundle } from '../packages/desktop-update/install.ts';
import { bundleInfo, executableIn, installedBundle, isRunningFrom, registerDesktopEntry, stagedBundle } from './local-bundle.mjs';

const source = stagedBundle, destination = installedBundle;
if (process.argv.slice(2).some(arg => arg !== '--recover-only')) throw new Error('Usage: npm run install:local [-- --recover-only]');
const assertStopped = async () => {
  if (isRunningFrom([source, destination])) throw new Error('Quit Agentic Crafting Table before installing. The app or its background services are still running; no files were replaced.');
};
if (process.argv.includes('--recover-only')) {
  const result = await recoverBundle(destination, assertStopped);
  console.log(`Installer recovery: ${result.recovery ?? 'nothing pending'}\nWorkspace data was not changed.`);
} else {
  const result = await installBundle(source, destination, assertStopped, {
    async verify(staged, installed) {
      // Recovery runs first: an interrupted swap can temporarily omit the bundle info.
      const identifier = bundleInfo(staged).identifier;
      if (identifier !== 'dev.agentcraftingtable.desktop' || (installed && bundleInfo(installed).identifier !== identifier)) throw new Error('App bundle identity does not match');
      // Hold the installer lease while verifying this exact staged bundle.
      execFileSync(process.execPath, ['scripts/smoke-packaged.mjs'], { stdio: 'inherit', env: { ...process.env, ACT_PACKAGED_EXECUTABLE: executableIn(staged) } });
    },
  });
  if (process.platform === 'linux') console.log(`Desktop entry: ${registerDesktopEntry(result.destination)}`);
  console.log(`${result.unchanged ? 'Already up to date: ' : 'Installed '}${result.destination}\n${result.unchanged ? 'No new app copy or backup was created.' : `Previous contents: ${result.backup ?? '(first installation)'}`}\nRecovery: ${result.recovery ?? 'not needed'}\nWorkspace data was not changed.`);
}
