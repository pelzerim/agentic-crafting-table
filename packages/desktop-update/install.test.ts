import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, lstat, readdir, rm, symlink, readlink, rename, chmod, utimes, realpath } from 'node:fs/promises';
import { fork, execFile } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { installBundle, recoverBundle } from './install.ts';
import type { InstallPhase } from './install.ts';
import { bundleLayout } from '../core/bundle-layout.ts';
import { DatabaseSync } from 'node:sqlite';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'craft-update-'));
  const source = join(root, 'staged', 'Table.app'), destination = join(root, 'installed', 'Table.app');
  for (const app of [source, destination]) await mkdir(join(app, 'Contents'), { recursive: true });
  await writeFile(join(source, 'Contents', 'app'), 'new build');
  await symlink('app', join(source, 'Contents', 'framework-link'));
  await writeFile(join(destination, 'Contents', 'app'), 'old build');
  await writeFile(join(destination, 'Contents', 'obsolete'), 'remove on update');
  await mkdir(join(root, 'workspace'));
  await writeFile(join(root, 'workspace', 'recording'), 'keep full session');
  return { root, source, destination };
}

test('local updates preserve the bookmarked app directory and retain the previous contents', async () => {
  const { root, source, destination } = await fixture();
  try {
    const before = await lstat(destination);
    const result = await installBundle(source, destination, async () => {});
    assert.equal((await lstat(destination)).ino, before.ino);
    assert.equal(await readFile(join(destination, 'Contents', 'app'), 'utf8'), 'new build');
    assert.equal(await readlink(join(destination, 'Contents', 'framework-link')), 'app');
    assert.equal(await readFile(join(result.backup!, 'Contents', 'app'), 'utf8'), 'old build');
    await assert.rejects(lstat(join(destination, 'Contents', 'obsolete')), { code: 'ENOENT' });
    assert.ok(!result.backup!.endsWith('.app'), 'Backup must not become a launchable duplicate app');
    // A subsequent update retains the same identity too.
    await installBundle(source, destination, async () => {});
    assert.equal((await lstat(destination)).ino, before.ino);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('an app launched during staging aborts installation without changing its contents', async () => {
  const { root, source, destination } = await fixture();
  try {
    const before = await lstat(destination); let checks = 0;
    await assert.rejects(installBundle(source, destination, async () => { if (++checks === 2) throw new Error('App is running'); }), /App is running/);
    assert.equal((await lstat(destination)).ino, before.ino);
    assert.equal(await readFile(join(destination, 'Contents', 'app'), 'utf8'), 'old build');
    assert.deepEqual((await readdir(join(root, 'installed'))).filter(name => !name.endsWith('.sqlite')), ['Table.app']);
    await assert.rejects(installBundle(destination, destination, async () => {}), /separate directories/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('an identical verified bundle keeps installed Contents and creates no additional rollback copy even on a full volume', async () => {
  const paths = await fixture();
  try {
    const first = await installBundle(paths.source, paths.destination, async () => {});
    assert.equal(first.unchanged, false);
    const inode = (await lstat(join(paths.destination, 'Contents'))).ino;
    // Timestamps are not product changes and must not waste another full copy.
    await utimes(join(paths.source, 'Contents/app'), new Date(0), new Date(0));
    let verified = false, stopped = 0;
    const next = await installBundle(paths.source, paths.destination, async () => { stopped++; }, {
      verify: async () => { verified = true; },
      capacity: async () => { throw new Error('An unchanged bundle needs no copy capacity'); },
      onPhase: () => { throw new Error('No staging should occur'); },
    });
    assert.ok(verified); assert.equal(stopped, 2); assert.equal(next.unchanged, true); assert.equal(next.backup, undefined);
    assert.equal((await lstat(join(paths.destination, 'Contents'))).ino, inode);
    assert.equal((await readdir(join(paths.root, 'installed/bundle-backups'))).length, 1);
    await assert.rejects(installBundle(paths.source, paths.destination, async () => { if (++stopped === 4) throw new Error('App started during verification'); }), /App started/);
    assert.equal((await lstat(join(paths.destination, 'Contents'))).ino, inode);
  } finally { await rm(paths.root, { recursive: true, force: true }); }
});

test('same-version updates compare all contents, executable modes and symlink targets without following links', async () => {
  const paths = await fixture();
  try {
    await installBundle(paths.source, paths.destination, async () => {});
    const changes = [
      () => writeFile(join(paths.source, 'Contents/app'), 'NEW BUILD'), // Same length, different bytes.
      () => chmod(join(paths.source, 'Contents/app'), 0o755),
      async () => { await rm(join(paths.source, 'Contents/framework-link')); await symlink('../..', join(paths.source, 'Contents/framework-link')); },
      () => mkdir(join(paths.source, 'Contents/empty-directory')),
      () => rm(join(paths.source, 'Contents/empty-directory'), { recursive: true }),
    ];
    for (const change of changes) {
      await change();
      assert.equal((await installBundle(paths.source, paths.destination, async () => {})).unchanged, false);
      assert.equal((await installBundle(paths.source, paths.destination, async () => {})).unchanged, true);
    }
    assert.equal((await lstat(join(paths.destination, 'Contents/app'))).mode & 0o777, 0o755);
    assert.equal(await readlink(join(paths.destination, 'Contents/framework-link')), '../..');
    assert.equal(await readFile(join(paths.root, 'workspace/recording'), 'utf8'), 'keep full session');
  } finally { await rm(paths.root, { recursive: true, force: true }); }
});

test('a staged build changed during verification is rejected before copying or replacing the installed app', async () => {
  const paths = await fixture();
  try {
    const before = await lstat(join(paths.destination, 'Contents'));
    let copying = false;
    await assert.rejects(installBundle(paths.source, paths.destination, async () => {}, {
      async verify(source) {
        assert.equal(await readFile(join(source, 'Contents/app'), 'utf8'), 'new build');
        await writeFile(join(source, 'Contents/app'), 'NEW BUILD');
      },
      onPhase() { copying = true; },
    }), { code: 'INSTALL_CHANGED' });
    assert.equal(copying, false);
    assert.equal((await lstat(join(paths.destination, 'Contents'))).ino, before.ino);
    assert.equal(await readFile(join(paths.destination, 'Contents/app'), 'utf8'), 'old build');
    assert.deepEqual((await readdir(join(paths.root, 'installed'))).filter(name => !name.endsWith('.sqlite')), ['Table.app']);
    assert.equal((await recoverBundle(paths.destination, async () => {})).recovery, undefined);
  } finally { await rm(paths.root, { recursive: true, force: true }); }
});

for (const change of ['bytes', 'mode', 'link', 'added file', 'removed file'] as const) {
  test(`staging concurrent changed ${change} aborts before activation and a stable retry preserves earlier backups`, async () => {
    const paths = await fixture();
    try {
      const first = await installBundle(paths.source, paths.destination, async () => {});
      await writeFile(join(paths.source, 'Contents/app'), 'next build');
      const before = await lstat(join(paths.destination, 'Contents'));
      const backups = await readdir(join(paths.root, 'installed/bundle-backups'));
      let reachedSwap = false;
      await assert.rejects(installBundle(paths.source, paths.destination, async () => {}, {
        async onPhase(phase) {
          if (phase === 'backed-up' || phase === 'activated') reachedSwap = true;
          if (phase !== 'staging') return;
          if (change === 'bytes') await writeFile(join(paths.source, 'Contents/app'), 'NEXT BUILD');
          if (change === 'mode') await chmod(join(paths.source, 'Contents/app'), 0o755);
          if (change === 'link') { await rm(join(paths.source, 'Contents/framework-link')); await symlink('../..', join(paths.source, 'Contents/framework-link')); }
          if (change === 'added file') await writeFile(join(paths.source, 'Contents/unverified'), 'new file');
          if (change === 'removed file') await rm(join(paths.source, 'Contents/framework-link'));
        },
      }), { code: 'INSTALL_CHANGED' });
      assert.equal(reachedSwap, false);
      assert.equal((await lstat(join(paths.destination, 'Contents'))).ino, before.ino);
      assert.equal(await readFile(join(paths.destination, 'Contents/app'), 'utf8'), 'new build');
      assert.equal(await readFile(join(first.backup!, 'Contents/app'), 'utf8'), 'old build');
      assert.deepEqual(await readdir(join(paths.root, 'installed/bundle-backups')), backups);
      assert.ok(!(await readdir(join(paths.root, 'installed'))).some(name => name.startsWith('.app-update-')));
      assert.equal((await recoverBundle(paths.destination, async () => {})).recovery, undefined);
      const retry = await installBundle(paths.source, paths.destination, async () => {});
      assert.equal(retry.unchanged, false);
      assert.equal(await readFile(join(retry.backup!, 'Contents/app'), 'utf8'), 'new build');
      assert.equal(await readFile(join(first.backup!, 'Contents/app'), 'utf8'), 'old build');
      assert.equal(await readFile(join(paths.root, 'workspace/recording'), 'utf8'), 'keep full session');
    } finally { await rm(paths.root, { recursive: true, force: true }); }
  });
}

test('a changed private copy is rejected on a first install without publishing a partial app', async () => {
  const paths = await fixture();
  try {
    await rm(paths.destination, { recursive: true });
    await assert.rejects(installBundle(paths.source, paths.destination, async () => {}, {
      async onPhase(phase) {
        if (phase !== 'prepared') return;
        const staged = (await readdir(join(paths.root, 'installed'))).find(name => name.startsWith('.app-update-'))!;
        await writeFile(join(paths.root, 'installed', staged, 'Contents/app'), 'bad bytes');
      },
    }), { code: 'INSTALL_CHANGED' });
    await assert.rejects(lstat(paths.destination), { code: 'ENOENT' });
    assert.ok(!(await readdir(join(paths.root, 'installed'))).some(name => name.startsWith('.app-update-')));
    assert.equal((await recoverBundle(paths.destination, async () => {})).recovery, undefined);
    await installBundle(paths.source, paths.destination, async () => {});
    assert.equal(await readFile(join(paths.destination, 'Contents/app'), 'utf8'), 'new build');
  } finally { await rm(paths.root, { recursive: true, force: true }); }
});

test('a source rebuild after copying cannot alter the verified copy being installed', async () => {
  const paths = await fixture();
  try {
    await installBundle(paths.source, paths.destination, async () => {}, {
      async onPhase(phase) { if (phase === 'prepared') await writeFile(join(paths.source, 'Contents/app'), 'later build'); },
    });
    assert.equal(await readFile(join(paths.destination, 'Contents/app'), 'utf8'), 'new build');
    assert.equal(await readFile(join(paths.source, 'Contents/app'), 'utf8'), 'later build');
  } finally { await rm(paths.root, { recursive: true, force: true }); }
});

test('insufficient or unavailable capacity refuses before staging and retry preserves the old build', async () => {
  const paths = await fixture();
  try {
    const inode = (await lstat(paths.destination)).ino;
    let copied = false;
    await assert.rejects(installBundle(paths.source, paths.destination, async () => {}, {
      capacity: async parent => { assert.equal(parent, await realpath(join(paths.root, 'installed'))); return { availableBytes: 1n, blockSize: 4096n }; },
      onPhase: () => { copied = true; },
    }), (error: any) => error.code === 'INSTALL_SPACE' && error.requiredBytes > 16n * 1024n * 1024n && /No new update was staged/.test(error.message));
    assert.equal(copied, false);
    assert.equal((await lstat(paths.destination)).ino, inode);
    assert.deepEqual((await readdir(join(paths.root, 'installed'))).filter(name => !name.endsWith('.sqlite')), ['Table.app']);
    assert.equal((await recoverBundle(paths.destination, async () => {})).recovery, undefined);
    await assert.rejects(installBundle(paths.source, paths.destination, async () => {}, { capacity: async () => { throw new Error('Cannot read volume capacity'); } }), /Cannot read volume/);
    assert.equal(await readFile(join(paths.destination, 'Contents/app'), 'utf8'), 'old build');
    const result = await installBundle(paths.source, paths.destination, async () => {});
    assert.equal(await readFile(join(result.backup!, 'Contents/app'), 'utf8'), 'old build');
  } finally { await rm(paths.root, { recursive: true, force: true }); }
});

async function pausedInstaller(paths: Awaited<ReturnType<typeof fixture>>, phase: InstallPhase) {
  const entry = join(paths.root, 'installer.mjs');
  await writeFile(entry, `import { installBundle } from ${JSON.stringify(new URL('./install.ts', import.meta.url).href)};
    await installBundle(process.argv[2], process.argv[3], async () => {}, {
      async onPhase(phase) {
        if (phase === process.argv[4]) {
          process.send({ phase });
          await new Promise(() => { setInterval(() => {}, 1000); });
        }
      }
    });
    process.disconnect();`);
  const child = fork(entry, [paths.source, paths.destination, phase], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const exit = once(child, 'exit');
  let output = ''; child.stderr?.on('data', data => { output = (output + data).slice(-4096); });
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  try {
    const result = await Promise.race([once(child, 'message'), exit.then(() => { throw new Error('Installer failed before checkpoint: ' + output); })]);
    assert.deepEqual(result[0], { phase });
  } catch (error) { child.kill('SIGKILL'); await exit; throw error; }
  finally { clearTimeout(timer); }
  return { async kill() { child.kill('SIGKILL'); await exit; } };
}

for (const phase of ['staging', 'prepared', 'backed-up', 'activated'] as const) {
  test(`SIGKILL during ${phase} recovers the old or fully activated build without changing the Dock identity`, async () => {
    const paths = await fixture();
    try {
      const inode = (await lstat(paths.destination)).ino;
      const child = await pausedInstaller(paths, phase);
      if (phase === 'staging') {
        // Leave an incomplete copied tree before interruption, not just an empty directory.
        const parent = join(paths.root, 'installed'), staged = (await readdir(parent)).find(name => name.startsWith('.app-update-'))!;
        await mkdir(join(parent, staged, 'Contents')); await writeFile(join(parent, staged, 'Contents/partial'), 'incomplete copy');
      }
      await child.kill();
      if (phase === 'backed-up') await assert.rejects(lstat(join(paths.destination, 'Contents')), { code: 'ENOENT' });
      const result = await recoverBundle(paths.destination, async () => {});
      assert.equal(result.recovery, phase === 'backed-up' ? 'restored' : phase === 'activated' ? 'completed' : 'discarded');
      assert.equal((await lstat(paths.destination)).ino, inode);
      assert.equal(await readFile(join(paths.destination, 'Contents', 'app'), 'utf8'), phase === 'activated' ? 'new build' : 'old build');
      assert.equal(await readFile(join(paths.root, 'workspace', 'recording'), 'utf8'), 'keep full session');
      assert.equal((await recoverBundle(paths.destination, async () => {})).recovery, undefined);
      assert.ok(!(await readdir(join(paths.root, 'installed'))).some(name => name.startsWith('.app-update-')));
      if (phase === 'activated') {
        const backups = await readdir(join(paths.root, 'installed', 'bundle-backups'));
        assert.equal(backups.length, 1);
        assert.equal(await readFile(join(paths.root, 'installed', 'bundle-backups', backups[0], 'Contents', 'app'), 'utf8'), 'old build');
      }
    } finally { await rm(paths.root, { recursive: true, force: true }); }
  });
}

for (const phase of ['prepared', 'activated'] as const) {
  test(`first installation interrupted when ${phase} is recoverable without an older bundle`, async () => {
    const paths = await fixture();
    try {
      await rm(paths.destination, { recursive: true });
      const child = await pausedInstaller(paths, phase); await child.kill();
      const inode = phase === 'activated' ? (await lstat(paths.destination)).ino : undefined;
      assert.equal((await recoverBundle(paths.destination, async () => {})).recovery, phase === 'activated' ? 'completed' : 'discarded');
      if (inode) assert.equal((await lstat(paths.destination)).ino, inode);
      else await assert.rejects(lstat(paths.destination), { code: 'ENOENT' });
      await installBundle(paths.source, paths.destination, async () => {});
      assert.equal(await readFile(join(paths.destination, 'Contents', 'app'), 'utf8'), 'new build');
    } finally { await rm(paths.root, { recursive: true, force: true }); }
  });
}

test('retry restores interrupted Contents before bundle verification, even when the staged build is gone', async () => {
  const paths = await fixture();
  try {
    const child = await pausedInstaller(paths, 'backed-up'); await child.kill();
    await rm(paths.source, { recursive: true });
    await assert.rejects(installBundle(paths.source, paths.destination, async () => {}), /Staged app/);
    assert.equal(await readFile(join(paths.destination, 'Contents', 'app'), 'utf8'), 'old build');
    // Repeat with a staged build and verify the restored installed identity first.
    await mkdir(join(paths.source, 'Contents'), { recursive: true });
    await writeFile(join(paths.source, 'Contents', 'app'), 'next build');
    const again = await pausedInstaller(paths, 'backed-up'); await again.kill();
    let verified = false;
    const result = await installBundle(paths.source, paths.destination, async () => {}, { async verify(_source, installed) {
      assert.equal(await readFile(join(installed!, 'Contents', 'app'), 'utf8'), 'old build'); verified = true;
    } });
    assert.ok(verified); assert.equal(result.recovery, 'restored');
    assert.equal(await readFile(join(paths.destination, 'Contents', 'app'), 'utf8'), 'next build');
  } finally { await rm(paths.root, { recursive: true, force: true }); }
});

test('a concurrent installer or recovery cannot take over a live installer lease', async () => {
  const paths = await fixture(); let child: Awaited<ReturnType<typeof pausedInstaller>> | undefined;
  try {
    child = await pausedInstaller(paths, 'prepared');
    await assert.rejects(installBundle(paths.source, paths.destination, async () => {}), /already running/);
    await assert.rejects(recoverBundle(paths.destination, async () => {}), /already running/);
    assert.equal(await readFile(join(paths.destination, 'Contents', 'app'), 'utf8'), 'old build');
    await child.kill(); child = undefined;
    assert.equal((await recoverBundle(paths.destination, async () => {})).recovery, 'discarded');
  } finally { await child?.kill(); await rm(paths.root, { recursive: true, force: true }); }
});

test('low-space refusal never prevents recovery of a previously interrupted swap', async () => {
  const paths = await fixture();
  try {
    const inode = (await lstat(paths.destination)).ino;
    const child = await pausedInstaller(paths, 'backed-up'); await child.kill();
    await assert.rejects(lstat(join(paths.destination, 'Contents')), { code: 'ENOENT' });
    await assert.rejects(installBundle(paths.source, paths.destination, async () => {}, { capacity: async () => ({ availableBytes: 0n, blockSize: 4096n }) }), { code: 'INSTALL_SPACE' });
    assert.equal((await lstat(paths.destination)).ino, inode);
    assert.equal(await readFile(join(paths.destination, 'Contents/app'), 'utf8'), 'old build');
    assert.equal((await recoverBundle(paths.destination, async () => {})).recovery, undefined);
    assert.equal(await readFile(join(paths.root, 'workspace/recording'), 'utf8'), 'keep full session');
  } finally { await rm(paths.root, { recursive: true, force: true }); }
});

test('recovery refuses running apps, keeps the intent, and succeeds after they stop', async () => {
  const paths = await fixture();
  try {
    const child = await pausedInstaller(paths, 'activated'); await child.kill();
    await assert.rejects(recoverBundle(paths.destination, async () => { throw new Error('App is running'); }), /App is running/);
    assert.equal(await readFile(join(paths.destination, 'Contents', 'app'), 'utf8'), 'new build');
    assert.equal((await recoverBundle(paths.destination, async () => {})).recovery, 'completed');
  } finally { await rm(paths.root, { recursive: true, force: true }); }
});

test('foreign contents and a tampered recovery path are preserved instead of overwritten', async () => {
  const paths = await fixture();
  try {
    const child = await pausedInstaller(paths, 'backed-up'); await child.kill();
    await mkdir(join(paths.destination, 'Contents')); await writeFile(join(paths.destination, 'Contents', 'app'), 'foreign build');
    await assert.rejects(recoverBundle(paths.destination, async () => {}), /unexpected contents/);
    assert.equal(await readFile(join(paths.destination, 'Contents', 'app'), 'utf8'), 'foreign build');
    const journalPath = (await readdir(join(paths.root, 'installed'))).find(name => name.endsWith('.sqlite'))!;
    const db = new DatabaseSync(join(paths.root, 'installed', journalPath));
    const body = JSON.parse(String(db.prepare('SELECT body FROM pending').get()!.body));
    db.prepare('UPDATE pending SET body=?').run(JSON.stringify({ ...body, id: '../../workspace' })); db.close();
    await assert.rejects(recoverBundle(paths.destination, async () => {}), /Invalid installer recovery record/);
    assert.equal(await readFile(join(paths.root, 'workspace', 'recording'), 'utf8'), 'keep full session');
  } finally { await rm(paths.root, { recursive: true, force: true }); }
});

test('ordinary activation failure rolls back and a replaced staging directory is never deleted', async () => {
  const paths = await fixture();
  try {
    await assert.rejects(installBundle(paths.source, paths.destination, async () => {}, { onPhase(phase) { if (phase === 'backed-up') throw new Error('Activation failed'); } }), /Activation failed/);
    assert.equal(await readFile(join(paths.destination, 'Contents', 'app'), 'utf8'), 'old build');
    const child = await pausedInstaller(paths, 'prepared'); await child.kill();
    const parent = join(paths.root, 'installed'), staged = (await readdir(parent)).find(name => name.startsWith('.app-update-'))!;
    await rename(join(parent, staged), join(parent, 'saved-staging'));
    await symlink(join(paths.root, 'workspace'), join(parent, staged));
    await assert.rejects(recoverBundle(paths.destination, async () => {}), /regular directories/);
    assert.equal(await readFile(join(paths.root, 'workspace', 'recording'), 'utf8'), 'keep full session');
  } finally { await rm(paths.root, { recursive: true, force: true }); }
});

test('the real recovery-only installer command restores an interrupted app without a staged bundle', async () => {
  const paths = await fixture();
  try {
    const layout = bundleLayout(process.platform, process.arch);
    const source = join(paths.root, layout.staged), destination = join(paths.root, layout.installed);
    await mkdir(dirname(source), { recursive: true });
    await mkdir(dirname(destination), { recursive: true });
    await rename(paths.source, source); await rename(paths.destination, destination);
    const inode = (await lstat(destination)).ino;
    const child = await pausedInstaller({ ...paths, source, destination }, 'backed-up'); await child.kill();
    await rm(source, { recursive: true });
    const command = fileURLToPath(new URL('../../scripts/install-local.mjs', import.meta.url));
    const result = await promisify(execFile)(process.execPath, [command, '--recover-only'], { cwd: paths.root });
    assert.match(result.stdout, /Installer recovery: restored/);
    assert.equal((await lstat(destination)).ino, inode);
    assert.equal(await readFile(join(destination, 'Contents/app'), 'utf8'), 'old build');
    const retry = await promisify(execFile)(process.execPath, [command, '--recover-only'], { cwd: paths.root });
    assert.match(retry.stdout, /nothing pending/);
  } finally { await rm(paths.root, { recursive: true, force: true }); }
});

test('installer metadata is private and refuses newer schemas or redirected journals', async () => {
  const paths = await fixture();
  try {
    await recoverBundle(paths.destination, async () => {});
    const parent = join(paths.root, 'installed'), file = (await readdir(parent)).find(name => name.endsWith('.sqlite'))!;
    const path = join(parent, file);
    assert.equal((await lstat(path)).mode & 0o777, 0o600);
    const db = new DatabaseSync(path); db.exec('PRAGMA user_version=2'); db.close();
    await assert.rejects(recoverBundle(paths.destination, async () => {}), /newer version/);
    await rename(path, join(parent, 'newer-schema.sqlite'));
    await symlink(join(paths.root, 'workspace/recording'), path);
    await assert.rejects(recoverBundle(paths.destination, async () => {}), { code: 'ELOOP' });
    assert.equal(await readFile(join(paths.root, 'workspace/recording'), 'utf8'), 'keep full session');
    assert.equal(await readFile(join(paths.destination, 'Contents/app'), 'utf8'), 'old build');
  } finally { await rm(paths.root, { recursive: true, force: true }); }
});
