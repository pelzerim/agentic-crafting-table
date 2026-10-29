import { app } from 'electron';
import { execFile, spawn } from 'node:child_process';
import { closeSync, constants, mkdirSync, openSync, writeFileSync } from 'node:fs';
import { access, readFile, realpath, unlink } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { LAUNCHER_SCRIPT, parseLauncher } from '../../packages/desktop-update/release.ts';
import { bundleLayout } from '../../packages/core/bundle-layout.ts';
import { CHECKOUT_PACKAGE_NAME, UPDATE_COMMAND, appUpdateRow, checkoutOfExecutable, updateFailureSchema } from '../../packages/core/updates.ts';
import type { UpdateFailure, UpdateStatus } from '../../packages/core/updates.ts';

/** Update and restart (UPDATE-01): the checkout this app was installed from, if it is one. */
export async function updateCheckout(executable: string, packaged: boolean): Promise<string | undefined> {
  const root = packaged ? checkoutOfExecutable(executable, bundleLayout(process.platform, process.arch)) : undefined;
  if (!root) return undefined;
  try {
    await access(join(root, '.git'));
    return JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).name === CHECKOUT_PACKAGE_NAME ? root : undefined;
  } catch { return undefined; }
}

export const updateFailurePath = (userData: string) => join(userData, 'update-failure.json');
export async function readUpdateFailure(userData: string): Promise<UpdateFailure | undefined> {
  try { return updateFailureSchema.parse(JSON.parse(await readFile(updateFailurePath(userData), 'utf8'))); } catch { return undefined; }
}
/** Deletes a failed run's note once a check after it has succeeded. */
export async function clearUpdateFailure(userData: string, status: UpdateStatus) {
  const failure = await readUpdateFailure(userData);
  if (failure && !appUpdateRow({ app: status.app, checkout: true, failure }).failure) await unlink(updateFailurePath(userData)).catch(() => {});
}

/** The node and PATH the person's login shell resolves, found before quitting so a shell without node never leaves the app closed. */
export async function resolveLauncher(): Promise<{ node: string; path: string }> {
  const shell = userInfo().shell || '/bin/zsh';
  const output = await new Promise<string>(resolve => execFile(shell, ['-ilc', LAUNCHER_SCRIPT], { encoding: 'utf8', timeout: 15_000, maxBuffer: 1024 * 1024 }, (_error, stdout) => resolve(stdout ?? '')));
  const found = parseLauncher(output);
  if (!found) throw new Error(`Node was not found in your login shell (${shell}). Update from a terminal with ${UPDATE_COMMAND}.`);
  const node = await realpath(found.node);
  await access(node, constants.X_OK);
  return { node, path: found.path };
}

/** Starts `scripts/update-restart.mjs` from the checkout once the app has drained; if it cannot start, notes why and relaunches the app. */
export async function startUpdateRestart(checkout: string, userData: string, tag: string | undefined, launcher: { node: string; path: string }) {
  const logs = join(userData, 'logs'), failure = updateFailurePath(userData);
  const failed = (error: Error) => {
    try { writeFileSync(failure, JSON.stringify({ at: Date.now(), ...(tag && { tag }), message: `The updater could not start: ${error.message}` })); } catch {}
    app.relaunch();
  };
  try {
    mkdirSync(logs, { recursive: true });
    const log = openSync(join(logs, 'update-restart.log'), 'a');
    const child = spawn(launcher.node, ['scripts/update-restart.mjs', '--failure', failure, ...(tag ? ['--tag', tag] : [])],
      { cwd: checkout, detached: true, stdio: ['ignore', log, log, 'ipc'], env: { ...process.env, PATH: launcher.path } });
    closeSync(log);
    // `spawn` only proves node started; the helper says ready once its own modules have loaded.
    const outcome = await new Promise<Error | undefined>(resolve => {
      const timer = setTimeout(() => resolve(new Error('it did not report ready within 5 seconds')), 5000);
      child.once('message', message => { clearTimeout(timer); resolve(message === 'ready' ? undefined : new Error('it sent an unexpected message')); });
      child.once('error', error => { clearTimeout(timer); resolve(error); });
      child.once('exit', code => { clearTimeout(timer); resolve(new Error(`it exited with ${code ?? 'a signal'}; see logs/update-restart.log`)); });
    });
    if (outcome) { child.kill(); failed(outcome); return; }
    child.removeAllListeners(); if (child.connected) child.disconnect(); child.unref();
  } catch (error) { failed(error as Error); }
}
