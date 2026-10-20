import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startWorkspaceService } from './server.ts';
import { connectWorkspace } from './client.ts';
import { SqliteStore } from './sqlite-store.ts';
import { githubFixture } from '../../tests/fixtures/github.ts';
import type { RecoveryState } from './lifecycle.ts';
import type { ResourceCreate } from '../core/resource-creation.ts';
import { WorkspaceControl } from '../core/control.ts';
import { prepareWorkspace } from './paths.ts';
import { serveLocal } from './local-rpc.ts';
import type { LaunchRequest, SessionSnapshot } from '../session-runtime/protocol.ts';

for (const phase of ['open', 'recovering'] as const) test(`service with a ${phase} recovery checkpoint gates new and queued work until a durable retry`, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-recovery-gate-'));
  const seed = new SqliteStore(join(directory, 'workspace.sqlite'));
  const checkpoint: RecoveryState = { phase, entries: [], ...(phase === 'open' ? { error: 'Recovery checkpoint could not be saved: fixture interruption' } : {}) };
  seed.writeRecovery(checkpoint);
  const request: ResourceCreate = { requestId: randomUUID(), nodeId: randomUUID(), resourceId: randomUUID(),
    expectedRevision: 0, pluginId: 'github.pull-request', title: 'Queued attachment',
    data: { url: 'https://github.com/fixture/billing/pull/42' }, position: { x: 0, y: 0 } };
  const job = seed.enqueueJob(request.requestId, { action: 'resource.attach', nodeId: request.nodeId, arguments: { request } });
  seed.close();
  const fixture = githubFixture();
  const service = await startWorkspaceService(directory, undefined, undefined, {
    connections: fixture.connections, host: fixture.host, assignments: [], reviews: {}, workflows: {},
  });
  const client = await connectWorkspace(directory);
  const persist = service.store.writeRecovery.bind(service.store);
  try {
    assert.equal(fixture.requests, 0, 'startup cannot replay queued jobs around the lifecycle gate');
    assert.equal(service.store.getJob(job.id)!.state, 'queued');
    assert.deepEqual(await client.call('lifecycle.status'), checkpoint);
    assert.equal((await service.control.read()).nodes.length, 0);
    await assert.rejects(client.call('item.create', { ...request, requestId: randomUUID(), nodeId: randomUUID(), resourceId: randomUUID() }), { code: 'WORKSPACE_CLOSING' });
    assert.equal(service.store.listJobs().length, 1);
    service.store.writeRecovery = () => { throw new Error('Fixture write still unavailable'); };
    const failed = await client.call<RecoveryState>('lifecycle.recover', { retry: true });
    assert.match(failed.error!, /checkpoint.*Fixture write still unavailable/);
    assert.equal(fixture.requests, 0); assert.deepEqual(service.store.readRecovery(), checkpoint);
    // Restore only this temporary store. Retry drains the original queued request.
    service.store.writeRecovery = persist;
    await client.call('lifecycle.recover', { retry: true });
    for (let i = 0; i < 100 && service.store.getJob(job.id)!.state !== 'succeeded'; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(service.store.getJob(job.id)!.state, 'succeeded');
    assert.equal(fixture.requests, 5); assert.equal((await service.control.read()).nodes[0].id, request.nodeId);
    for (let i = 0; i < 100 && service.store.readRecovery().phase === 'recovering'; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(service.store.readRecovery().error, undefined); assert.equal(service.store.readRecovery().phase, 'open');
    await client.call('lifecycle.recover', { retry: true });
    assert.equal(fixture.requests, 5); assert.equal(service.store.listJobs().length, 1);
  } finally {
    service.store.writeRecovery = persist; client.close(); await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('persisted recovery errors keep queued native launches stopped until recovery is saved', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-native-recovery-gate-'));
  const runtimeDirectory = join(directory, 'runtime'), paths = prepareWorkspace(runtimeDirectory);
  const seed = new SqliteStore(join(directory, 'workspace.sqlite')), control = new WorkspaceControl(seed);
  const launch: LaunchRequest = { requestId: randomUUID(), sessionId: randomUUID(), nodeId: randomUUID(), workspaceId: 'local:fixture',
    executable: '/bin/sh', args: [], cwd: directory, cols: 80, rows: 24 };
  await control.apply({ type: 'item.add', id: launch.nodeId, resourceId: randomUUID(), pluginId: 'terminal.session',
    title: 'Pending native launch', position: { x: 0, y: 0 }, data: { sessionId: launch.sessionId, workspaceId: launch.workspaceId, cwd: directory, shell: '/bin/sh' } }, 0);
  const checkpoint: RecoveryState = { phase: 'open', error: 'Recovery checkpoint could not be saved: fixture interruption', entries: [] };
  seed.writeRecovery(checkpoint);
  const job = seed.enqueueJob(launch.requestId, { action: 'terminal.create', nodeId: launch.nodeId, arguments: { launch } });
  seed.close();
  const accepted: SessionSnapshot[] = [];
  // Real local IPC, simulated supervisor replies: no shell or model starts here.
  const runtime = await serveLocal(paths.socket, paths.secret, (method, input) => {
    if (method === 'hello') return { protocol: 1, service: 'sessions' };
    if (method === 'diagnostics.configure') return {};
    if (method === 'sessions.list') return accepted.map(value => value.session);
    assert.equal(method, 'sessions.launch'); assert.deepEqual(input, launch);
    const snapshot: SessionSnapshot = { session: { ...launch, native: undefined, id: launch.sessionId, state: 'running', createdAt: '', updatedAt: '' }, chunks: [], firstSequence: 1, lastSequence: 0, truncated: false };
    accepted.push(snapshot); return snapshot;
  });
  let service: Awaited<ReturnType<typeof startWorkspaceService>> | undefined;
  let client: Awaited<ReturnType<typeof connectWorkspace>> | undefined;
  try {
    service = await startWorkspaceService(directory, undefined, { directory: runtimeDirectory, executable: process.execPath, entrypoint: 'unused', electronRuntime: false }, { assignments: [], reviews: {}, workflows: {} });
    client = await connectWorkspace(directory);
    assert.equal(accepted.length, 0); assert.equal(service.store.getJob(job.id)!.state, 'queued');
    const persist = service.store.writeRecovery.bind(service.store);
    service.store.writeRecovery = () => { throw new Error('Fixture checkpoint still unavailable'); };
    assert.match((await client.call<RecoveryState>('lifecycle.recover', { retry: true })).error!, /checkpoint.*Fixture checkpoint still unavailable/);
    assert.equal(accepted.length, 0); assert.deepEqual(service.store.readRecovery(), checkpoint);
    service.store.writeRecovery = persist;
    await client.call('lifecycle.recover', { retry: true });
    for (let i = 0; i < 100 && service.store.readRecovery().phase === 'recovering'; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(service.store.getJob(job.id)!.state, 'succeeded');
    assert.equal(accepted.length, 1); assert.equal(accepted[0].session.requestId, launch.requestId);
    assert.equal(service.store.readRecovery().error, undefined);
    await client.call('lifecycle.recover', { retry: true }); assert.equal(accepted.length, 1);
  } finally { client?.close(); await service?.close(); await runtime.close(); await rm(directory, { recursive: true, force: true }); }
});
