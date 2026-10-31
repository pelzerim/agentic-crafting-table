import { execFileSync } from 'node:child_process';
import { UpdateRefused, planUpdate } from '../packages/desktop-update/release.ts';
import { installedBundle, isRunningFrom, stagedBundle } from './local-bundle.mjs';

/** `npm run update`: move this checkout to the newest release tag, then build and install the app in place.
 * Refuses while the app runs or the checkout has local changes; `--dry-run` only prints the plan. */
const dryRun = process.argv.includes('--dry-run');
if (process.argv.slice(2).some(arg => arg !== '--dry-run')) throw new Error('Usage: npm run update [-- --dry-run]');
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();
// npm is a batch file on Windows, which only a shell can start. Every argument here is a fixed word.
const run = (command, args) => execFileSync(command, args, { stdio: 'inherit', shell: process.platform === 'win32' });
const assertStopped = () => {
  if (isRunningFrom([stagedBundle, installedBundle])) throw new Error('Quit Agentic Crafting Table before updating. The app or its background services are still running; nothing was changed.');
};

try {
  if (!dryRun) { assertStopped(); run('git', ['fetch', '--tags', '--quiet', 'origin']); }
  const plan = planUpdate({ status: git('status', '--porcelain'), tags: git('tag', '--list').split('\n'), head: git('rev-parse', 'HEAD'), tagsAtHead: git('tag', '--points-at', 'HEAD').split('\n') });
  if ('unchanged' in plan) { console.log(`Already at ${plan.unchanged}, the newest release. Run npm run install:local if the installed app is older.`); process.exit(0); }
  console.log(`${plan.current} → ${plan.tag}${dryRun ? ' (dry run, nothing runs)' : ''}\n  ${plan.steps.join('\n  ')}`);
  if (dryRun) process.exit(0);
  run('git', ['checkout', '--quiet', '--detach', plan.tag]);
  run('npm', ['ci']);
  run('npm', ['run', 'package']);
  run('npm', ['run', 'install:local']);
  console.log(`Updated to ${plan.tag}. Launch Agentic Crafting Table from the Dock.`);
} catch (error) {
  if (error instanceof UpdateRefused) { console.error(error.message); process.exit(1); }
  throw error;
}
