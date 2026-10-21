import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { UpdateRefused, planUpdate } from '../packages/desktop-update/release.ts';

/** `npm run update`: move this checkout to the newest release tag, then build and install the app in place.
 * Refuses while the app runs or the checkout has local changes; `--dry-run` only prints the plan. */
if (process.platform !== 'darwin') throw new Error('The local updater currently supports macOS only');
const dryRun = process.argv.includes('--dry-run');
if (process.argv.slice(2).some(arg => arg !== '--dry-run')) throw new Error('Usage: npm run update [-- --dry-run]');
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();
const run = (command, args) => execFileSync(command, args, { stdio: 'inherit' });
const installed = [resolve('release/staged/mac-arm64/Agentic Crafting Table.app'), resolve('release/mac-arm64/Agentic Crafting Table.app')];
const assertStopped = () => {
  const processes = execFileSync('/bin/ps', ['-ax', '-o', 'comm='], { encoding: 'utf8' }).split('\n');
  if (processes.some(command => installed.some(app => command.trim().startsWith(app + '/')))) throw new Error('Quit Agentic Crafting Table before updating. The app or its background services are still running; nothing was changed.');
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
