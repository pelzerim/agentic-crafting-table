import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { WorkspaceConnection } from './connection.ts';
import { connectWorkspace } from './client.ts';
import { serveLocal } from './local-rpc.ts';
import { prepareWorkspace } from './paths.ts';
import { PROTOCOL_VERSION } from './protocol.ts';
import { emptyState } from '../core/control.ts';

test('detached service survives clients and automatically reconnects after process death', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-reconnect-'));
  const connection = new WorkspaceConnection(directory, process.execPath, resolve('packages/workspace-service/entry.ts'));
  let observer: Awaited<ReturnType<typeof connectWorkspace>> | undefined;
  try {
    await connection.connect();
    observer = await connectWorkspace(directory);
    const first = await observer.call<{ pid: number; instanceId: string }>('hello');
    const notified = once(connection, 'snapshot', { signal: AbortSignal.timeout(5000) });
    await observer.call('apply', { commandId: 'persist', expectedRevision: 0, actor: { kind: 'user', id: 'test' }, commands: [{ type: 'project.create', id: 'p', title: 'Survives the desktop', position: { x: 1, y: 2 } }] });
    assert.equal((await notified)[0].state.revision, 1);
    observer.close();
    observer = await connectWorkspace(directory);
    assert.equal((await observer.call<{ pid: number }>('hello')).pid, first.pid);
    const recovered = once(connection, 'snapshot', { signal: AbortSignal.timeout(15_000) });
    process.kill(first.pid, 'SIGKILL');
    assert.equal((await recovered)[0].state.nodes[0].title, 'Survives the desktop');
    const next = await connection.call<{ pid: number; instanceId: string }>('hello');
    assert.notEqual(next.instanceId, first.instanceId);
    assert.equal(connection.snapshot?.state.revision, 1);
  } finally {
    observer?.close(); connection.close();
    const cleanup = await connectWorkspace(directory).catch(() => undefined);
    if (cleanup) { await cleanup.call('admin.shutdown'); cleanup.close(); }
    await rm(directory, { recursive: true, force: true });
  }
});

test('closing a workspace connection during subscription never publishes ready state or leaks its client', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-connect-close-'));
  const paths = prepareWorkspace(directory);
  const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { resolve, promise }; };
  const subscribed = deferred(), release = deferred(), disconnected = deferred();
  const server = await serveLocal(paths.socket, paths.secret, async (method, _args, peer) => {
    if (method === 'hello') return { protocol: PROTOCOL_VERSION };
    if (method === 'subscribe') {
      peer.onClose(() => disconnected.resolve()); subscribed.resolve(); await release.promise;
      return { state: emptyState(), cursor: 0 };
    }
    throw new Error('Unexpected fixture request');
  });
  const connection = new WorkspaceConnection(directory, process.execPath, 'unused');
  const status: string[] = [], snapshots: unknown[] = [];
  connection.on('status', value => status.push(value)); connection.on('snapshot', value => snapshots.push(value));
  try {
    const pending = connection.connect(); const rejected = assert.rejects(pending, /closed|disconnected/);
    await subscribed.promise; connection.close(); release.resolve();
    await rejected;
    await Promise.race([disconnected.promise, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Subscription socket leaked')), 1000); timer.unref(); })]);
    assert.ok(!status.includes('connected')); assert.deepEqual(snapshots, []);
    await assert.rejects(connection.connect(), /closed/);
  } finally { release.resolve(); connection.close(); await server.close(); await rm(directory, { recursive: true, force: true }); }
});
