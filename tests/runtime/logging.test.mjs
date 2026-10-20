import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import electron from 'electron';
import { WorkspaceConnection } from '../../packages/workspace-service/connection.ts';
import { connectWorkspace } from '../../packages/workspace-service/client.ts';
import { connectSupervisor } from '../../packages/session-runtime/client.ts';

async function until(check) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) { const result = await check(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 25)); }
  throw new Error('Timed out waiting for isolated log process');
}

test('detached Electron log owner survives launcher exit, drains later output, and releases its lease after service exit', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-log-runtime-')), childPath = join(directory, 'fixture.cjs'), pidPath = join(directory, 'pid');
  let servicePid, ownerPid;
  try {
    await writeFile(childPath, `const fs=require('node:fs'); fs.writeFileSync(${JSON.stringify(pidPath)},String(process.pid)); process.stdout.write('BEFORE\\n'); setTimeout(()=>process.stderr.write('AFTER_LAUNCHER_EXIT\\n'),300); setInterval(()=>{},1000);`);
    const script = `const {spawn}=require('node:child_process'); const child=spawn(process.execPath,${JSON.stringify([resolve('dist/service-log.cjs'), childPath])},{detached:true,stdio:'ignore',env:process.env}); child.unref();`;
    const launcher = spawn(electron, ['-e', script], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ACT_DATA_DIR: directory }, stdio: 'ignore' });
    assert.equal((await once(launcher, 'exit'))[0], 0);
    servicePid = await until(() => readFile(pidPath, 'utf8').then(Number).catch(() => undefined));
    await until(() => readFile(join(directory, 'service.log'), 'utf8').then(value => value.includes('AFTER_LAUNCHER_EXIT')));
    const lease = new DatabaseSync(join(directory, 'diagnostic-owner.sqlite')); ownerPid = Number(lease.prepare('SELECT pid FROM owner').get().pid); lease.close();
    process.kill(servicePid, 'SIGTERM'); servicePid = undefined;
    await until(() => readFile(join(directory, 'service.log'), 'utf8').then(value => value.includes('Service stopped (SIGTERM)')));
    await until(() => { const lease = new DatabaseSync(join(directory, 'diagnostic-owner.sqlite')); try { return !lease.prepare('SELECT pid FROM owner').get(); } finally { lease.close(); } });
    await until(() => { try { process.kill(ownerPid, 0); return false; } catch (error) { return error.code === 'ESRCH'; } }); ownerPid = undefined;
  } finally {
    if (servicePid) { try { process.kill(servicePid, 'SIGTERM'); } catch {} }
    if (ownerPid) { try { process.kill(ownerPid, 'SIGTERM'); } catch {} }
    await rm(directory, { recursive: true, force: true });
  }
});

test('saved log limits reach both Electron services and survive service loss and runtime reconnection', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-log-policy-runtime-')), runtime = join(directory, 'runtime');
  const workspace = new WorkspaceConnection(directory, electron, resolve('dist/workspace-service.cjs'), true);
  const policy = { fileMiB: 3, backups: 1 };
  const accepted = path => {
    if (!existsSync(join(path, 'diagnostic-owner.sqlite'))) return false;
    const db = new DatabaseSync(join(path, 'diagnostic-owner.sqlite'), { readOnly: true });
    try {
      db.exec('PRAGMA busy_timeout=2000');
      if (!db.prepare("SELECT name FROM sqlite_master WHERE name='policy'").get()) return false;
      return db.prepare('SELECT body FROM policy WHERE id=1').get()?.body === JSON.stringify(policy);
    } finally { db.close(); }
  };
  try {
    await workspace.connect();
    const settings = await workspace.call('settings.read');
    await workspace.call('settings.write', { expectedRevision: settings.revision, value: { ...settings.value, diagnostics: policy } });
    await until(() => accepted(directory) && accepted(runtime));
    const supervisor = await connectSupervisor(runtime), previous = await supervisor.call('hello');
    const disconnected = once(supervisor, 'disconnected');
    process.kill(previous.pid, 'SIGKILL'); await disconnected; supervisor.close();
    // Report reconnects the runtime without launching any terminal/model session.
    await until(async () => (await workspace.call('diagnostics.report')).sessions.available);
    const next = await connectSupervisor(runtime);
    assert.notEqual((await next.call('hello')).pid, previous.pid); next.close();
    await until(() => accepted(runtime));
    const service = await workspace.call('hello');
    const restored = once(workspace, 'snapshot', { signal: AbortSignal.timeout(10_000) });
    process.kill(service.pid, 'SIGKILL'); await restored;
    assert.notEqual((await workspace.call('hello')).pid, service.pid);
    assert.deepEqual((await workspace.call('settings.read')).value.diagnostics, policy);
    await until(() => accepted(directory) && accepted(runtime));
  } finally {
    workspace.close();
    const service = await connectWorkspace(directory).catch(() => undefined);
    if (service) { const stopped = once(service, 'disconnected'); await service.call('admin.shutdown'); await stopped; service.close(); }
    const supervisor = await connectSupervisor(runtime).catch(() => undefined);
    if (supervisor) { const stopped = once(supervisor, 'disconnected'); await supervisor.call('admin.shutdown'); await stopped; supervisor.close(); }
    for (const path of [directory, runtime]) await until(() => {
      if (!existsSync(join(path, 'diagnostic-owner.sqlite'))) return true;
      const db = new DatabaseSync(join(path, 'diagnostic-owner.sqlite'), { readOnly: true });
      try { db.exec('PRAGMA busy_timeout=2000'); return !db.prepare('SELECT pid FROM owner').get(); } finally { db.close(); }
    });
    await rm(directory, { recursive: true, force: true });
  }
});
