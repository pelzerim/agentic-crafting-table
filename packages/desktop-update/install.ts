import { cp, lstat, mkdir, realpath, rename, rm, rmdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { InstallJournal } from './journal.ts';
import type { FileIdentity, InstallIntent } from './journal.ts';
import { inspectBundle, sameBundle, requireCopyCapacity, volumeCapacity } from './bundle.ts';
import type { Capacity } from './bundle.ts';

type Recovery = 'restored' | 'completed' | 'discarded';
export type InstallPhase = 'staging' | 'prepared' | 'backed-up' | 'activated';
type InstallOptions = {
  verify?: (source: string, destination?: string) => Promise<void>;
  onPhase?: (phase: InstallPhase) => void | Promise<void>;
  capacity?: (parent: string) => Promise<Capacity>;
};
async function directory(path: string): Promise<FileIdentity | undefined> {
  const stat = await lstat(path).catch(error => { if (error.code !== 'ENOENT') throw error; });
  if (!stat) return;
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Installer requires regular directories: ' + path);
  return { dev: stat.dev, ino: stat.ino };
}
function same(a?: FileIdentity, b?: FileIdentity) { return !!a && !!b && a.dev === b.dev && a.ino === b.ino; }
function paths(intent: InstallIntent) {
  const parent = dirname(intent.destination);
  return { prepared: join(parent, '.app-update-' + intent.id), backup: join(parent, 'bundle-backups', 'previous-' + intent.id) };
}
async function context(destination: string) {
  destination = resolve(destination);
  await mkdir(dirname(destination), { recursive: true });
  const parent = await realpath(dirname(destination));
  destination = join(parent, basename(destination));
  return { destination, journal: new InstallJournal(parent, destination) };
}

/** Recovery only trusts identities captured before the swap. Unknown contents are
 * preserved for manual investigation, never replaced by a guessed backup. */
async function recover(journal: InstallJournal, assertStopped: () => Promise<void>): Promise<Recovery | undefined> {
  const intent = journal.read();
  if (!intent) return;
  await assertStopped();
  const { destination, original, prepared: staged } = intent, { prepared, backup } = paths(intent);
  const app = await directory(destination), current = app && await directory(join(destination, 'Contents'));
  const staging = await directory(prepared), stagedContents = staging && await directory(join(prepared, 'Contents'));
  // Check the parent too: a substituted backup directory must not redirect a rename.
  const backupParent = await directory(dirname(backup));
  const backupRoot = backupParent && await directory(backup), old = backupRoot && await directory(join(backup, 'Contents'));
  const conflict = () => { throw new Error('Interrupted install has unexpected contents; preserved all files for manual recovery'); };
  if (staging && !same(staging, intent.staging)) conflict();
  if (stagedContents && staged && !same(stagedContents, staged.contents)) conflict();
  let outcome: Recovery = 'discarded';
  if (original) {
    if (!same(app, original.app)) conflict();
    if (same(current, original.contents) && !old) {
      // Copying or swap never began (or rollback already finished).
    } else if (!current && same(old, original.contents)) {
      await assertStopped();
      await rename(join(backup, 'Contents'), join(destination, 'Contents'));
      outcome = 'restored';
    } else if (staged && same(current, staged.contents) && same(old, original.contents) && !stagedContents) {
      outcome = 'completed'; // Activation succeeded before the process died.
    } else conflict();
  } else if (!app && !old) {
    // A first installation did not reach its atomic directory rename.
  } else if (staged && same(app, staged.app) && same(current, staged.contents) && !staging && !old) {
    outcome = 'completed';
  } else conflict();
  if (staging) await rm(prepared, { recursive: true });
  if (backupRoot && !await directory(join(backup, 'Contents'))) await rmdir(backup); // Empty wrapper only.
  journal.clear();
  return outcome;
}

/** Recover without requiring a staged build (for example after a cancelled build). */
export async function recoverBundle(destination: string, assertStopped: () => Promise<void>) {
  await assertStopped();
  const ctx = await context(destination);
  try { return { destination: ctx.destination, recovery: await recover(ctx.journal, assertStopped) }; }
  finally { ctx.journal.close(); }
}

/** Keep the outer installed .app identity: Dock bookmarks follow a renamed app.
 * Intent is committed before copying/moving files; retry recovers before validation. */
export async function installBundle(source: string, destination: string, assertStopped: () => Promise<void>, options: InstallOptions = {}) {
  source = resolve(source); destination = resolve(destination);
  if (source === destination || source.startsWith(destination + '/') || destination.startsWith(source + '/')) throw new Error('Build and installed app must use separate directories');
  await assertStopped();
  const ctx = await context(destination), journal = ctx.journal;
  destination = ctx.destination;
  try {
    const recovery = await recover(journal, assertStopped);
    if (!await directory(source) || !await directory(join(source, 'Contents'))) throw new Error('Staged app has no Contents directory');
    source = await realpath(source);
    if (source === destination || source.startsWith(destination + '/') || destination.startsWith(source + '/')) throw new Error('Build and installed app must use separate directories');
    const existing = await directory(destination), contents = existing && await directory(join(destination, 'Contents'));
    if (existing && !contents) throw new Error('Installed app has no Contents and no recovery record');
    const stagedBundle = await inspectBundle(join(source, 'Contents'));
    const changed = (phase: string) => Object.assign(new Error(`Staged app changed during ${phase}. Finish rebuilding it and retry installation; this update was not activated.`), { code: 'INSTALL_CHANGED' });
    if (options.verify) {
      await options.verify(source, existing ? destination : undefined);
      if (!sameBundle(stagedBundle, await inspectBundle(join(source, 'Contents')))) throw changed('verification');
    }
    if (existing && sameBundle(stagedBundle, await inspectBundle(join(destination, 'Contents')))) {
      await assertStopped();
      if (!same(await directory(destination), existing) || !same(await directory(join(destination, 'Contents')), contents)) throw new Error('Installed app changed during verification');
      return { destination, backup: undefined, recovery, unchanged: true };
    }
    requireCopyCapacity(stagedBundle, await (options.capacity ?? volumeCapacity)(dirname(destination)));
    const id = randomUUID(), prepared = join(dirname(destination), '.app-update-' + id);
    await mkdir(prepared, { mode: 0o700 });
    const intent: InstallIntent = { version: 1, id, destination, phase: 'copying', staging: (await directory(prepared))!, ...(existing && contents ? { original: { app: existing, contents } } : {}) };
    const { backup } = paths(intent);
    // A crash before this commit leaves only an empty private staging directory;
    // no copy or installed-file change has started. Never infer ownership later.
    try { journal.write(intent); }
    catch (error) { await rmdir(prepared); throw error; }
    try {
      await options.onPhase?.('staging');
      await cp(join(source, 'Contents'), join(prepared, 'Contents'), { recursive: true, verbatimSymlinks: true });
      intent.prepared = { app: (await directory(prepared))!, contents: (await directory(join(prepared, 'Contents')))! };
      intent.phase = 'ready'; journal.write(intent);
      await options.onPhase?.('prepared');
      // A rebuild may change the source after smoke verification or while cp is
      // reading it. Only activate a private copy matching that verified inventory.
      if (!sameBundle(stagedBundle, await inspectBundle(join(prepared, 'Contents')))) throw changed('copying');
      await assertStopped();
      if (existing) {
        if (!same(await directory(destination), existing) || !same(await directory(join(destination, 'Contents')), contents)) throw new Error('Installed app changed during staging');
        await mkdir(dirname(backup), { recursive: true, mode: 0o700 });
        await directory(dirname(backup));
        await mkdir(backup, { mode: 0o700 });
        await rename(join(destination, 'Contents'), join(backup, 'Contents'));
        await options.onPhase?.('backed-up');
        await rename(join(prepared, 'Contents'), join(destination, 'Contents'));
      } else {
        if (await directory(destination)) throw new Error('Installed app appeared during staging');
        await rename(prepared, destination);
      }
      await options.onPhase?.('activated');
      await recover(journal, assertStopped); // Finalize using the same crash-recovery rules.
      return { destination, backup: existing ? backup : undefined, recovery, unchanged: false };
    } catch (error) {
      // Refusal to recover a live/changed app leaves intent and both copies intact.
      try { await recover(journal, assertStopped); }
      catch (recoveryError) { throw new AggregateError([error, recoveryError], 'Install interrupted; recovery is pending. Quit the app and run install:local -- --recover-only.'); }
      throw error;
    }
  } finally { journal.close(); }
}
