import test from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners, once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceConnection } from './connection.ts';
import { connectWorkspace } from './client.ts';
import { SupervisorConnection, connectSupervisor } from '../session-runtime/client.ts';
import { serveLocal } from './local-rpc.ts';
import { prepareWorkspace } from './paths.ts';
import { PROTOCOL_VERSION } from './protocol.ts';
import { setImmediate as nextTurn } from 'node:timers/promises';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { resolve, promise };
}

test('repeated supervisor connections release cancellation listeners and initialization failure can retry', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-connect-retry-'));
  const paths = prepareWorkspace(directory), lifetime = new AbortController();
  let initializations = 0;
  const server = await serveLocal(paths.socket, paths.secret, method => {
    if (method === 'hello') return { protocol: PROTOCOL_VERSION, service: 'sessions' };
    if (method === 'diagnostics.configure') {
      if (++initializations === 1) throw new Error('Fixture initialization failed');
      return {};
    }
    if (method === 'ping') return 'alive';
    throw new Error('Unexpected fixture request');
  });
  const connection = new SupervisorConnection({ directory, executable: process.execPath, entrypoint: 'unused', electronRuntime: false },
    client => client.call('diagnostics.configure'));
  try {
    await assert.rejects(connection.connect(), /Fixture initialization failed/);
    assert.equal(await connection.call('ping'), 'alive');
    assert.equal(initializations, 2);
    for (let i = 0; i < 12; i++) {
      const client = await connectSupervisor(directory, lifetime.signal);
      assert.equal(await client.call('ping'), 'alive');
      const closed = once(client, 'disconnected'); client.close(); await closed;
      await nextTurn();
      assert.equal(getEventListeners(lifetime.signal, 'abort').length, 0);
    }
    assert.equal(await connection.call('ping'), 'alive');
    assert.equal(initializations, 2);
  } finally {
    connection.close(); lifetime.abort(); await server.close(); await rm(directory, { recursive: true, force: true });
  }
});

async function within<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Connection setup did not cancel promptly')), 1000);
    })]);
  } finally { clearTimeout(timer); }
}

for (const phase of ['workspace hello', 'supervisor hello', 'supervisor initialization'] as const) {
  test(`closing during ${phase} cancels its socket without stopping the shared service`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'craft-connect-cancel-'));
    const paths = prepareWorkspace(directory);
    const started = deferred(), release = deferred(), disconnected = deferred();
    const workspace = phase === 'workspace hello';
    const pausedMethod = phase === 'supervisor initialization' ? 'diagnostics.configure' : 'hello';
    const hello = { protocol: PROTOCOL_VERSION, service: 'sessions' };
    let paused = false;
    const methods: string[] = [];
    const server = await serveLocal(paths.socket, paths.secret, async (method, _args, peer) => {
      methods.push(method);
      if (method === pausedMethod && !paused) {
        paused = true; peer.onClose(disconnected.resolve); started.resolve(); await release.promise;
      }
      if (method === 'hello') return hello;
      if (method === 'diagnostics.configure') return {};
      if (method === 'ping') return 'alive';
      throw new Error('Unexpected fixture request');
    });
    const connection = workspace
      ? new WorkspaceConnection(directory, process.execPath, 'unused')
      : new SupervisorConnection({ directory, executable: process.execPath, entrypoint: 'unused', electronRuntime: false },
        client => client.call('diagnostics.configure'));
    const status: string[] = [], snapshots: unknown[] = [];
    if (connection instanceof WorkspaceConnection) {
      connection.on('status', value => status.push(value)); connection.on('snapshot', value => snapshots.push(value));
    }
    let observer: Awaited<ReturnType<typeof connectSupervisor>> | undefined;
    try {
      const rejected = assert.rejects(connection.connect(), /closed|disconnected|abort/i);
      await within(started.promise); connection.close();
      // Leave the reply paused: closure must not depend on a reply or the RPC timeout.
      await within(rejected); await within(disconnected.promise);
      assert.ok(!status.includes('connected')); assert.deepEqual(snapshots, []);
      assert.deepEqual(methods, phase === 'supervisor initialization' ? ['hello', 'diagnostics.configure'] : ['hello']);
      await assert.rejects(connection.connect(), /closed/);
      observer = await (workspace ? connectWorkspace(directory) : connectSupervisor(directory));
      assert.equal(await observer.call('ping'), 'alive');
      release.resolve(); await nextTurn();
      assert.ok(!status.includes('connected')); assert.deepEqual(snapshots, []);
    } finally {
      release.resolve(); connection.close(); observer?.close(); await server.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}
