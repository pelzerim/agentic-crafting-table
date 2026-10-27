import { execFileSync, spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { afterUpdate } from './update-restart-check.mjs';

// Sent first: the app quits only once the helper is running.
process.send?.('ready'); process.disconnect?.();

/** Update and restart (UPDATE-01): started by the app after it quit. Waits for it to exit, runs `npm run update`, then reopens it.
 * A failure is written to `--failure` for Settings to show; `--dry-run` only prints the plan. */
const { values } = parseArgs({ options: { failure: { type: 'string' }, tag: { type: 'string' }, 'dry-run': { type: 'boolean', default: false } } });
if (!values.failure) throw new Error('Usage: node scripts/update-restart.mjs --failure <file> [--tag vX.Y.Z] [--dry-run]');
const app = resolve('release/mac-arm64/Agentic Crafting Table.app');
const installed = [resolve('release/staged/mac-arm64/Agentic Crafting Table.app'), app];
const running = () => execFileSync('/bin/ps', ['-ax', '-o', 'comm='], { encoding: 'utf8' }).split('\n').some(command => installed.some(path => command.trim().startsWith(path + '/')));
// The thrown error's line, not its stack; refusals print their message alone.
const reason = stderr => { const lines = stderr.trim().split('\n'), error = lines.findLastIndex(line => /^\w*Error: /.test(line)); return error >= 0 ? lines[error].replace(/^\w*Error: /, '') : lines.slice(-12).join('\n'); };
const version = () => { try { return execFileSync('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', join(app, 'Contents/Info.plist')], { encoding: 'utf8' }).trim(); } catch { return undefined; } };
const tagsAtHead = () => execFileSync('git', ['tag', '--points-at', 'HEAD'], { encoding: 'utf8' }).split('\n');
const plan = [`wait until nothing runs from ${installed.join(' or ')} (every 500 ms, at most 2 minutes)`, 'node scripts/update-local.mjs',
  ...(values.tag ? [`installed ${version() ?? 'nothing'}; if still older than ${values.tag} with the checkout on it: npm ci, npm run package, npm run install:local`] : []), `open ${app}`, `on failure: write { at, tag, message } to ${values.failure}`];

console.log(`${new Date().toISOString()} Update and restart${values.tag ? ` to ${values.tag}` : ''}${values['dry-run'] ? ' (dry run, nothing runs)' : ''}\n  ${plan.join('\n  ')}`);
if (values['dry-run']) process.exit(0);
try {
  const deadline = Date.now() + 2 * 60_000;
  while (running()) {
    if (Date.now() > deadline) throw new Error('Agentic Crafting Table did not finish quitting within 2 minutes; nothing was changed.');
    await sleep(500);
  }
  const update = spawnSync(process.execPath, ['scripts/update-local.mjs'], { stdio: ['ignore', 'inherit', 'pipe'], encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  process.stderr.write(update.stderr ?? '');
  if (update.status !== 0) throw new Error(reason(update.stderr ?? '') || `npm run update exited with ${update.status ?? update.signal}`);
  if (values.tag) {
    // An earlier run may have checked the tag out but failed to build or install it.
    if (afterUpdate({ tag: values.tag, installed: version(), tagsAtHead: tagsAtHead() }) === 'rebuild') for (const args of [['ci'], ['run', 'package'], ['run', 'install:local']]) execFileSync('npm', args, { stdio: ['ignore', 'inherit', 'inherit'] });
    if (afterUpdate({ tag: values.tag, installed: version(), tagsAtHead: tagsAtHead() }) !== 'installed') throw new Error(`The installed app is ${version() ?? 'missing'}, not ${values.tag}. Details in logs/update-restart.log.`);
  }
} catch (error) {
  console.error(error.message);
  writeFileSync(values.failure, JSON.stringify({ at: Date.now(), ...(values.tag && { tag: values.tag }), message: error.message.slice(0, 2000) }));
} finally {
  execFileSync('/usr/bin/open', [app]);
}
