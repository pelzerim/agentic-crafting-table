import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { ensureLocalService } from './launcher.ts';
import { connectWorkspace } from './client.ts';
import { connectSupervisor } from '../session-runtime/client.ts';
import { connectSocket } from './local-rpc.ts';

test('already-cancelled connections do not create a workspace or read its credentials', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-connect-aborted-'));
  const missing = join(directory, 'absent'), signal = AbortSignal.abort(new Error('Connection owner closed'));
  let calls = 0;
  try {
    await assert.rejects(ensureLocalService(missing, 'unused', 'unused', false, async () => { calls++; }, signal), /Connection owner closed/);
    await assert.rejects(connectWorkspace(missing, signal), /Connection owner closed/);
    await assert.rejects(connectSupervisor(missing, signal), /Connection owner closed/);
    await assert.rejects(connectSocket(join(directory, 'absent.sock'), signal), /Connection owner closed/);
    assert.equal(calls, 0); assert.equal(existsSync(missing), false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('cancellation after an unavailable endpoint prevents service launch', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-connect-no-spawn-'));
  const lifetime = new AbortController();
  let calls = 0;
  try {
    await assert.rejects(ensureLocalService(directory, 'unused', 'missing-log-launcher.cjs', false, async (_directory, signal) => {
      calls++; assert.equal(signal, lifetime.signal); lifetime.abort(new Error('Connection owner closed'));
      throw Object.assign(new Error('Missing endpoint'), { code: 'ENOENT' });
    }, lifetime.signal), /Connection owner closed/);
    assert.equal(calls, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('service-start polling cancels without waiting for the startup deadline', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-connect-poll-'));
  const lifetime = new AbortController();
  let calls = 0;
  let cancelTimer: ReturnType<typeof setTimeout> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    // The disposable child simply exits; no service, profile or provider is started.
    const launcher = join(directory, 'service-log.cjs');
    await writeFile(launcher, 'require("node:fs").writeFileSync(__filename + ".done", "done");');
    const pending = ensureLocalService(directory, process.execPath, join(directory, 'service.cjs'), false, async (_directory, signal) => {
      calls++; assert.equal(signal, lifetime.signal);
      if (calls === 2) cancelTimer = setTimeout(() => lifetime.abort(), 0);
      throw Object.assign(new Error('Missing endpoint'), { code: 'ENOENT' });
    }, lifetime.signal);
    await Promise.race([assert.rejects(pending, { name: 'AbortError' }), new Promise<never>((_, reject) => {
      deadline = setTimeout(() => reject(new Error('Startup polling did not cancel')), 1000);
    })]);
    assert.equal(calls, 2);
    // Keep the launcher file until the disposable child has actually read it.
    const childDeadline = Date.now() + 1000;
    while (!existsSync(launcher + '.done') && Date.now() < childDeadline) await delay(10);
    assert.ok(existsSync(launcher + '.done'));
  } finally {
    clearTimeout(cancelTimer); clearTimeout(deadline); lifetime.abort();
    await rm(directory, { recursive: true, force: true });
  }
});
