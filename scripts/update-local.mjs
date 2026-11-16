import { execFileSync } from 'node:child_process';
import { UpdateRefused, planUpdate, releaseRemote } from '../packages/desktop-update/release.ts';
import { installedBundle, isRunningFrom, stagedBundle } from './local-bundle.mjs';
import { UPDATE_FAILED, UPDATE_REFUSED } from './update-restart-check.mjs';

/** `npm run update`: move this checkout to the newest release tag, then build and install the app in place.
 * Refuses while the app runs or the checkout has local changes; `--dry-run` only prints the plan. */
const dryRun = process.argv.includes('--dry-run');
if (process.argv.slice(2).some(arg => arg !== '--dry-run')) throw new Error('Usage: npm run update [-- --dry-run]');
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();
const gitConfig = key => { try { return git('config', '--get', key) || undefined; } catch { return undefined; } };
/** A step that ran and failed, said in words for the terminal and for Settings → About. */
class UpdateFailed extends Error {}
const lastLine = text => String(text ?? '').trim().split('\n').filter(Boolean).at(-1);
// npm is a batch file on Windows, which only a shell can start. Every argument here is a fixed word.
const run = (command, args, { failure }) => {
  try { execFileSync(command, args, { stdio: 'inherit', shell: process.platform === 'win32' }); }
  catch (error) { throw new UpdateFailed(`${command} ${args.join(' ')} ${error.status == null ? `stopped (${error.signal ?? error.code ?? 'no exit code'})` : `exited with ${error.status}`}. ${failure}`); }
};
const assertStopped = () => {
  if (isRunningFrom([stagedBundle, installedBundle])) throw new UpdateRefused('Quit Agentic Crafting Table before updating. The app or its background services are still running; nothing was changed.');
};
const fetchTags = remote => {
  try { execFileSync('git', ['fetch', '--tags', '--quiet', remote.name], { encoding: 'utf8', stdio: ['ignore', 'inherit', 'pipe'] }); }
  catch (error) {
    process.stderr.write(error.stderr ?? '');
    throw new UpdateFailed(`Could not fetch release tags from ${remote.name} (${remote.url}): ${lastLine(error.stderr) ?? error.message}\nCheck the network and that git can reach that remote (git fetch ${remote.name}); nothing was changed.`);
  }
};

try {
  const remote = releaseRemote({ remotes: git('remote', '-v'), configured: gitConfig('act.updateRemote') });
  if (!dryRun) { assertStopped(); fetchTags(remote); }
  const plan = planUpdate({ status: git('status', '--porcelain'), tags: git('tag', '--list').split('\n'), head: git('rev-parse', 'HEAD'), tagsAtHead: git('tag', '--points-at', 'HEAD').split('\n') });
  if ('unchanged' in plan) { console.log(`Already at ${plan.unchanged}, the newest release on ${remote.name}. Run npm run install:local if the installed app is older.`); process.exit(0); }
  console.log(`${plan.current} → ${plan.tag} from ${remote.name} (${remote.url})${dryRun ? ' (dry run, nothing runs)' : ''}\n  git fetch --tags ${remote.name}\n  ${plan.steps.join('\n  ')}`);
  if (dryRun) process.exit(0);
  const rerun = `The checkout is on ${plan.tag}; its output is above (or in logs/update-restart.log in the app data folder after Update and restart); fix that, then run npm run update again.`;
  run('git', ['checkout', '--quiet', '--detach', plan.tag], { failure: `The checkout stays on ${plan.current}; nothing was installed.` });
  run('npm', ['ci'], { failure: `Installing dependencies failed, often a network or registry problem. ${rerun}` });
  run('npm', ['run', 'package'], { failure: `Building the app failed. ${rerun}` });
  run('npm', ['run', 'install:local'], { failure: `Installing the built app failed. ${rerun}` });
  console.log(`Updated to ${plan.tag}. Launch Agentic Crafting Table from the Dock.`);
} catch (error) {
  if (error instanceof UpdateRefused) { console.error(`${UPDATE_REFUSED}${error.message}`); process.exit(1); }
  if (error instanceof UpdateFailed) { console.error(`${UPDATE_FAILED}${error.message}`); process.exit(1); }
  throw error;
}
