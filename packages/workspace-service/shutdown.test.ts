import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { startWorkspaceService } from './server.ts';
import { prepareWorkspace } from './paths.ts';
import { serveLocal } from './local-rpc.ts';
import { connectWorkspace } from './client.ts';
import { connectSupervisor } from '../session-runtime/client.ts';
import { randomUUID } from 'node:crypto';
import { SqliteStore } from './sqlite-store.ts';
import { githubFixture } from '../../tests/fixtures/github.ts';
import type { ResourceCreate } from '../core/resource-creation.ts';
import { WorkspaceControl } from '../core/control.ts';
import type { ReviewSource } from '../provider-runtime/review-sources.ts';

function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function within<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('Workspace shutdown did not settle promptly')), 1000);
  })]); } finally { clearTimeout(timer); }
}

test('shutdown during supervisor initialization closes workspace IPC and ownership without stopping the supervisor', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-startup-stop-'));
  const runtimeDirectory = join(directory, 'runtime'), runtimePaths = prepareWorkspace(runtimeDirectory);
  const entered = deferred(), release = deferred(), disconnected = deferred();
  const methods: string[] = [];
  const runtime = await serveLocal(runtimePaths.socket, runtimePaths.secret, async (method, _args, peer) => {
    methods.push(method);
    if (method === 'hello') return { protocol: 1, service: 'sessions' };
    if (method === 'diagnostics.configure') {
      peer.onClose(disconnected.resolve); entered.resolve(); await release.promise; return {};
    }
    if (method === 'ping') return 'alive';
    throw new Error('Unexpected runtime request');
  });
  const starting = startWorkspaceService(directory, undefined, { directory: runtimeDirectory, executable: process.execPath, entrypoint: 'unused', electronRuntime: false }, { assignments: [], reviews: {}, workflows: {} })
    .then(service => ({ service, error: undefined }), error => ({ service: undefined, error }));
  let client: Awaited<ReturnType<typeof connectWorkspace>> | undefined;
  let observer: Awaited<ReturnType<typeof connectSupervisor>> | undefined;
  let replacement: Awaited<ReturnType<typeof startWorkspaceService>> | undefined;
  try {
    await within(entered.promise);
    client = await connectWorkspace(directory);
    await client.call('apply', { commandId: 'before-close', expectedRevision: 0, actor: { kind: 'user', id: 'fixture' }, commands: [
      { type: 'project.create', id: 'saved', title: 'Survives initialization shutdown', position: { x: 1, y: 2 } },
    ] });
    const closed = once(client, 'disconnected');
    await client.call('admin.shutdown');
    // Keep the runtime reply paused: service shutdown must cancel its owned setup.
    await within(closed); await within(disconnected.promise);
    const result = await within(starting);
    assert.equal(result.service, undefined); assert.match(result.error?.message, /closed during startup/);
    assert.deepEqual(methods, ['hello', 'diagnostics.configure']);
    observer = await connectSupervisor(runtimeDirectory);
    assert.equal(await observer.call('ping'), 'alive');
    replacement = await startWorkspaceService(directory, undefined, undefined, { assignments: [], reviews: {}, workflows: {} });
    assert.equal((await replacement.control.read()).nodes[0].id, 'saved');
    release.resolve();
    const verification = await connectWorkspace(directory);
    try { assert.equal((await verification.call<{ instanceId: string }>('hello')).instanceId, replacement.instanceId); }
    finally { verification.close(); }
  } finally {
    release.resolve(); client?.close(); observer?.close();
    const initial = await starting; await initial.service?.close();
    await replacement?.close(); await runtime.close(); await rm(directory, { recursive: true, force: true });
  }
});

test('every concurrent close caller waits for ownership release and cannot remove a successor socket', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-concurrent-stop-'));
  const providers = { assignments: [], reviews: {}, workflows: {} };
  const service = await startWorkspaceService(directory, undefined, undefined, providers);
  let replacement: Awaited<ReturnType<typeof startWorkspaceService>> | undefined;
  try {
    const first = service.close(), second = service.close();
    await within(second);
    replacement = await startWorkspaceService(directory, undefined, undefined, providers);
    await first; await service.close();
    const client = await connectWorkspace(directory);
    try { assert.equal((await client.call<{ instanceId: string }>('hello')).instanceId, replacement.instanceId); }
    finally { client.close(); }
  } finally { await service.close(); await replacement?.close(); await rm(directory, { recursive: true, force: true }); }
});

test('shutdown drains background review recovery and correlates requests rejected during that drain', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-review-drain-'));
  const paths = prepareWorkspace(directory), seed = new SqliteStore(paths.database);
  const control = new WorkspaceControl(seed), requestId = randomUUID();
  await control.dispatch({ commandId: 'seed', expectedRevision: 0, actor: { kind: 'user', id: 'fixture' }, commands: [
    { type: 'item.add', id: 'pr', resourceId: 'pr-resource', pluginId: 'github.pull-request', title: 'PR', position: { x: 0, y: 0 }, data: { owner: 'fixture', repo: 'billing', number: 42 } },
  ] });
  seed.enqueueJob(`review:${requestId}`, { action: 'review.prepare', nodeId: 'pr', arguments: { requestId, provider: 'claude' } }); seed.close();
  const entered = deferred(), release = deferred(), aborted = deferred();
  const source: ReviewSource = {
    async freeze() { return { comparison: { repository: 'fixture/billing', number: 42, headSha: 'a'.repeat(40), baseTipSha: 'b'.repeat(40) }, title: 'PR', description: '', url: 'https://github.com/fixture/billing/pull/42' }; },
    async capture(_directory, _id, _source, signal) {
      signal.addEventListener('abort', aborted.resolve, { once: true }); entered.resolve();
      await release.promise; signal.throwIfAborted(); throw new Error('No native session should launch');
    },
  };
  const runtimeDirectory = join(directory, 'runtime'), runtimePaths = prepareWorkspace(runtimeDirectory);
  const runtime = await serveLocal(runtimePaths.socket, runtimePaths.secret, method => {
    if (method === 'hello') return { protocol: 1, service: 'sessions' };
    if (method === 'diagnostics.configure') return {};
    if (method === 'sessions.list') return [];
    throw new Error('Unexpected runtime request');
  });
  let service: Awaited<ReturnType<typeof startWorkspaceService>> | undefined;
  let client: Awaited<ReturnType<typeof connectWorkspace>> | undefined;
  let closing: Promise<void> | undefined;
  try {
    service = await startWorkspaceService(directory, undefined, { directory: runtimeDirectory, executable: process.execPath, entrypoint: 'unused', electronRuntime: false }, {
      assignments: [], workflows: {}, reviews: { 'github.pull-request': source },
      reviewRuntime: { models: async () => ({ options: ['opus'], default: 'opus' }), probe: async () => ({ executable: '/fixture/native', version: 'fixture' }) },
    });
    await within(entered.promise); client = await connectWorkspace(directory);
    let closed = false; closing = service.close().then(() => { closed = true; });
    await within(aborted.promise);
    await assert.rejects(within(client.call('read')), { code: 'WORKSPACE_CLOSING' });
    assert.equal(closed, false);
    assert.equal(service.store.listJobs()[0].state, 'running');
    release.resolve(); await within(closing);
    const saved = new SqliteStore(paths.database);
    try {
      assert.equal(saved.listJobs()[0].state, 'outcome-unknown'); const { state } = await saved.snapshot();
      assert.equal(state.nodes.length, 2); assert.equal(state.resources.find(resource => resource.pluginId === 'code.review')?.data.phase, 'fetching');
    }
    finally { saved.close(); }
  } finally { release.resolve(); client?.close(); await closing; await service?.close(); await runtime.close(); await rm(directory, { recursive: true, force: true }); }
});

test('shutdown interrupts recovered attachments without starting the next job, which remains recoverable', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-recovery-stop-'));
  const paths = prepareWorkspace(directory), seed = new SqliteStore(paths.database);
  const requests: ResourceCreate[] = [0, 1].map(index => ({ requestId: randomUUID(), nodeId: randomUUID(), resourceId: randomUUID(),
    expectedRevision: 0, pluginId: 'github.pull-request', title: 'URL lookup', data: { url: 'https://github.com/fixture/billing/pull/42' }, position: { x: index * 300, y: 0 } }));
  for (const request of requests) seed.enqueueJob(request.requestId, { action: 'resource.attach', nodeId: request.nodeId, arguments: { request } });
  seed.close();
  const fixture = githubFixture(), entered = deferred(), release = deferred();
  // Ignore cancellation in this fake transport to prove the host also bounds an
  // uncooperative adapter. It must not commit when its late result is released.
  fixture.delay(async () => { entered.resolve(); await release.promise; });
  const providers = { connections: fixture.connections, host: fixture.host, assignments: [], reviews: {}, workflows: {} };
  const starting = startWorkspaceService(directory, undefined, undefined, providers)
    .then(service => ({ service, error: undefined }), error => ({ service: undefined, error }));
  let client: Awaited<ReturnType<typeof connectWorkspace>> | undefined;
  let replacement: Awaited<ReturnType<typeof startWorkspaceService>> | undefined;
  try {
    await within(entered.promise);
    client = await connectWorkspace(directory);
    const disconnected = once(client, 'disconnected'); await client.call('admin.shutdown');
    await within(disconnected);
    const stopped = await within(starting);
    assert.match(stopped.error?.message, /closed during startup/);
    assert.equal(fixture.requests, 1);
    const stored = new SqliteStore(paths.database);
    try {
      assert.deepEqual(stored.listJobs().map(job => job.state), ['outcome-unknown', 'queued']);
      assert.equal((await stored.snapshot()).state.nodes.length, 0);
    } finally { stored.close(); }
    fixture.delay(undefined);
    replacement = await startWorkspaceService(directory, undefined, undefined, providers);
    assert.equal(fixture.requests, 11); // Interrupted lookup + two complete five-read observations.
    assert.deepEqual(replacement.store.listJobs().map(job => job.state), ['succeeded', 'succeeded']);
    const state = await replacement.control.read();
    release.resolve();
    // The fixture represents one provider identity; both requests resolve to it.
    assert.equal(state.nodes.length, 1);
    await replacement.close(); replacement = undefined;
    replacement = await startWorkspaceService(directory, undefined, undefined, providers);
    assert.equal(fixture.requests, 11); // Interrupted lookup + two complete five-read observations.
    assert.deepEqual(await replacement.control.read(), state);
  } finally {
    release.resolve(); client?.close(); const initial = await starting; await initial.service?.close();
    await replacement?.close(); await rm(directory, { recursive: true, force: true });
  }
});
