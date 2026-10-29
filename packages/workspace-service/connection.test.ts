import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { WorkspaceConnection } from './connection.ts';
import { connectWorkspace } from './client.ts';
import { serveLocal } from './local-rpc.ts';
import { startWorkspaceService } from './server.ts';
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

test('the connection subscribes on its layer, changes layer with one subscribe that answers, and keeps the layer across a reconnect', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-connection-layer-'));
  const paths = prepareWorkspace(directory), asked: unknown[] = [];
  let cursor = 0;
  const server = await serveLocal(paths.socket, paths.secret, async (method, args) => {
    if (method === 'hello') return { protocol: PROTOCOL_VERSION };
    if (method === 'subscribe') { asked.push(args); const { layer } = args as { layer?: string }; return { state: emptyState(), cursor, ...(layer ? { layer } : {}) }; }
    throw new Error('Unexpected fixture request');
  });
  const connection = new WorkspaceConnection(directory, process.execPath, 'unused');
  const layers: unknown[] = []; connection.on('snapshot', value => layers.push(value.layer));
  try {
    connection.setLayer('map');
    await connection.connect();
    cursor = 4;
    const answer = await connection.setLayer('below');
    assert.equal(answer?.layer, 'below');
    assert.deepEqual(asked, [{ after: 0, layer: 'map' }, { after: 0, layer: 'below' }]);
    assert.deepEqual(layers, ['map', 'below']);
    (connection as unknown as { client: { close(): void } }).client.close();
    await once(connection, 'status', { signal: AbortSignal.timeout(5000) });
    await connection.connect();
    assert.deepEqual(asked.at(-1), { after: 4, layer: 'below' });
  } finally { connection.close(); server.close(); await rm(directory, { recursive: true, force: true }); }
});

test('connection events record each status change with its reason; snapshot deliveries keep the 20 slowest', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-connection-events-'));
  const paths = prepareWorkspace(directory);
  let subscriptions = 0;
  const server = await serveLocal(paths.socket, paths.secret, async method => {
    if (method === 'hello') return { protocol: PROTOCOL_VERSION };
    if (method === 'subscribe') {
      subscriptions++;
      if (subscriptions === 2) throw new Error('Fixture refused');
      return { state: emptyState(), cursor: 0 };
    }
    throw new Error('Unexpected fixture request');
  });
  const connection = new WorkspaceConnection(directory, process.execPath, 'unused');
  const logged: string[] = [];
  connection.on('connection-event', (event: { status: string; reason?: string }) => logged.push(`${event.status}${event.reason ? `: ${event.reason}` : ''}`));
  try {
    const client = await connection.connect();
    for (let n = 0; n < 25; n++) connection.recordSnapshotDelivery({ parseMs: 0, length: 100 }, n);
    const reconnected = new Promise<void>(resolve => connection.on('status', value => { if (value === 'connected' && subscriptions === 3) resolve(); }));
    client.close();
    await reconnected;
    const { events, slowestSnapshots } = connection.connectionEvents();
    assert.deepEqual(events.map(event => [event.status, event.reason]), [
      ['connecting', undefined], ['connected', undefined], ['disconnected', 'closed'],
      ['connecting', undefined], ['disconnected', 'subscribe failed: Fixture refused'],
      ['connecting', undefined], ['connected', undefined],
    ]);
    assert.ok(events.every(event => !Number.isNaN(Date.parse(event.at))));
    assert.deepEqual(logged, ['connecting', 'connected', 'disconnected: closed', 'connecting', 'disconnected: subscribe failed: Fixture refused', 'connecting', 'connected']);
    assert.equal(slowestSnapshots.length, 20);
    assert.equal(slowestSnapshots[0].forwardMs, 24);
    assert.equal(slowestSnapshots.at(-1)!.forwardMs, 5);
  } finally { connection.close(); await server.close(); await rm(directory, { recursive: true, force: true }); }
});

test('a broadcast snapshot arrives with its parse time and length', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-snapshot-parse-'));
  const service = await startWorkspaceService(directory, undefined, undefined, {});
  const connection = new WorkspaceConnection(directory, process.execPath, 'unused');
  try {
    await connection.connect();
    const delivered = once(connection, 'snapshot', { signal: AbortSignal.timeout(5000) });
    await connection.call('apply', { commandId: 'parse', expectedRevision: 0, actor: { kind: 'user', id: 'test' }, commands: [{ type: 'project.create', id: 'p', title: 'Parsed', position: { x: 1, y: 2 } }] });
    const [snapshot, parse] = await delivered;
    assert.equal(snapshot.state.revision, 1);
    assert.ok(parse.parseMs >= 0); assert.ok(parse.length > 100);
  } finally { connection.close(); await service.close(); await rm(directory, { recursive: true, force: true }); }
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

test('a connection for requests only never subscribes, so it is sent no snapshots, and still answers calls', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-connection-requests-'));
  const paths = prepareWorkspace(directory), asked: string[] = [];
  const server = await serveLocal(paths.socket, paths.secret, async method => {
    asked.push(method);
    if (method === 'hello') return { protocol: PROTOCOL_VERSION };
    if (method === 'read') return { state: emptyState(), cursor: 0 };
    throw new Error('Unexpected fixture request');
  });
  const connection = new WorkspaceConnection(directory, process.execPath, 'unused', false, { subscribe: false });
  try {
    await connection.connect();
    assert.deepEqual((await connection.call<{ cursor: number }>('read')).cursor, 0);
    assert.equal(asked.includes('subscribe'), false);
  } finally { connection.close(); server.close(); await rm(directory, { recursive: true, force: true }); }
});
