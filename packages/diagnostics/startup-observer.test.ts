import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { startWorkspaceService } from '../workspace-service/server.ts';
import { prepareWorkspace } from '../workspace-service/paths.ts';
import { observeWorkspaceStartup } from './startup-observer.ts';
import { serveLocal } from '../workspace-service/local-rpc.ts';
import { PROTOCOL_VERSION } from '../workspace-service/protocol.ts';
import { emptyState } from '../core/control.ts';
async function until(condition: () => boolean) { const deadline = Date.now() + 3000; while (!condition()) { if (Date.now() > deadline) throw new Error('Probe did not settle'); await new Promise(resolve => setTimeout(resolve, 10)); } }

test('startup observer distinguishes missing IPC from a ready snapshot and records no graph content', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'act-startup-probe-'));
  const probe = observeWorkspaceStartup(directory);
  let service: Awaited<ReturnType<typeof startWorkspaceService>> | undefined;
  try {
    await until(() => probe.snapshot().lastFailure === 'ENOENT');
    assert.equal(probe.snapshot().failures[0].phase, 'waiting');
    service = await startWorkspaceService(directory, undefined, undefined, { assignments: [], reviews: {}, workflows: {} });
    await service.control.dispatch({ commandId: 'one', expectedRevision: 0, actor: { kind: 'user', id: 'PRIVATE_ACTOR' }, commands: [{ type: 'project.create', id: 'PRIVATE_ID', title: 'PRIVATE_TITLE', position: { x: 1, y: 2 } }] });
    await until(() => probe.snapshot().phase === 'ready');
    const result = await probe.stop();
    assert.equal(result.nodes, 1); assert.equal(result.links, 0); assert.ok(result.serviceReadyMs! <= result.snapshotReadyMs!);
    assert.ok(result.attempts >= 2); assert.doesNotMatch(JSON.stringify(result), /PRIVATE|act-startup-probe|token|secret/);
  } finally { await probe.stop(); await service?.close(); await rm(directory, { recursive: true, force: true }); }
});

test('stopping a startup observer cancels a stalled handshake and releases the socket', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'act-stalled-probe-')), paths = prepareWorkspace(directory);
  let connected = false, closed = false;
  const server = createServer(socket => { connected = true; socket.resume(); socket.on('close', () => { closed = true; }); });
  await new Promise<void>(resolve => server.listen(paths.socket, resolve));
  const probe = observeWorkspaceStartup(directory);
  try {
    await until(() => connected); assert.equal(probe.snapshot().phase, 'hello');
    const started = performance.now(); const report = await probe.stop(); assert.equal(report.phase, 'stopped'); assert.ok(performance.now() - started < 500);
    await until(() => closed);
  } finally { await probe.stop(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(paths.socket, { force: true }); await rm(directory, { recursive: true, force: true }); }
});

test('a missing socket is reported separately from a missing token or generic connection loss', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'act-missing-socket-'));
  prepareWorkspace(directory);
  const probe = observeWorkspaceStartup(directory);
  try {
    await until(() => Boolean(probe.snapshot().lastFailure));
    assert.equal(probe.snapshot().lastFailure, 'ENOENT');
    assert.equal(probe.snapshot().failures[0].phase, 'connect');
  } finally { await probe.stop(); await rm(directory, { recursive: true, force: true }); }
});

test('a stale Unix socket reports refused connection rather than a handshake failure', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'act-refused-probe-')), paths = prepareWorkspace(directory);
  const server = createServer();
  await new Promise<void>(resolve => server.listen(paths.socket, resolve));
  // Preserve the actual socket inode after its listener exits, as after a crash.
  const stale = paths.socket + '.stale';
  let probe: ReturnType<typeof observeWorkspaceStartup> | undefined;
  try {
    await rename(paths.socket, stale);
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rename(stale, paths.socket);
    probe = observeWorkspaceStartup(directory);
    await until(() => Boolean(probe!.snapshot().lastFailure));
    const report = await probe.stop();
    assert.equal(report.lastFailure, 'ECONNREFUSED');
    assert.equal(report.failures[0].phase, 'connect');
  } finally {
    await probe?.stop();
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(paths.socket, { force: true }); await rm(stale, { force: true });
    await rm(directory, { recursive: true, force: true });
  }
});

for (const phase of ['hello', 'snapshot'] as const) test(`a stalled ${phase} records its deadline and phase without retaining request content`, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'act-timeout-probe-')), paths = prepareWorkspace(directory);
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const server = await serveLocal(paths.socket, paths.secret, async method => {
    if (phase === 'hello' || method === 'read') await blocked;
    return { protocol: PROTOCOL_VERSION };
  });
  const probe = observeWorkspaceStartup(directory);
  try {
    await until(() => Boolean(probe.snapshot().lastFailure));
    const report = probe.snapshot();
    assert.equal(report.lastFailure, 'TIMEOUT');
    assert.equal(report.failures[0].phase, phase);
    assert.ok(report.failures[0].elapsedMs >= 900);
    assert.equal(typeof report.serviceReadyMs, phase === 'snapshot' ? 'number' : 'undefined');
    assert.doesNotMatch(JSON.stringify(report), /act-timeout-probe|token|secret|Startup probe timeout/);
  } finally { await probe.stop(); release(); await server.close(); await rm(directory, { recursive: true, force: true }); }
});

for (const failure of ['UNAUTHORIZED', 'INCOMPATIBLE'] as const) test(`startup reports ${failure} during hello`, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'act-rejected-probe-')), paths = prepareWorkspace(directory);
  const server = await serveLocal(paths.socket, failure === 'UNAUTHORIZED' ? '0'.repeat(64) : paths.secret, () => ({ protocol: PROTOCOL_VERSION + 1 }));
  const probe = observeWorkspaceStartup(directory);
  try {
    await until(() => Boolean(probe.snapshot().lastFailure));
    const report = await probe.stop();
    assert.equal(report.lastFailure, failure); assert.equal(report.failures[0].phase, 'hello');
    assert.equal(report.nodes, undefined);
  } finally { await probe.stop(); await server.close(); await rm(directory, { recursive: true, force: true }); }
});

test('failed-read history is bounded, private, immutable to consumers and retained after readiness', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'act-private-probe-')), paths = prepareWorkspace(directory);
  let reads = 0;
  const server = await serveLocal(paths.socket, paths.secret, method => {
    if (method === 'hello') return { protocol: PROTOCOL_VERSION };
    if (++reads <= 10) throw Object.assign(new Error('PRIVATE_MESSAGE /PRIVATE_PATH'), { code: 'PRIVATE_CODE' });
    return { state: { ...emptyState(), nodes: [{ id: 'PRIVATE_ID', title: 'PRIVATE_TITLE', position: { x: 0, y: 0 } }] }, cursor: 0 };
  });
  const probe = observeWorkspaceStartup(directory);
  try {
    await until(() => probe.snapshot().phase === 'ready');
    const report = probe.snapshot();
    assert.equal(report.attempts, 11); assert.equal(report.failures.length, 8);
    assert.deepEqual(report.failures.map(failure => failure.attempt), [3, 4, 5, 6, 7, 8, 9, 10]);
    assert.ok(report.failures.every(failure => failure.phase === 'snapshot' && failure.code === 'OTHER'));
    assert.equal(report.nodes, 1); assert.equal(report.links, 0);
    assert.doesNotMatch(JSON.stringify(report), /PRIVATE|act-private-probe|token|secret/);
    report.failures[0].code = 'ENOENT'; report.failures.pop();
    const stopped = await probe.stop();
    assert.equal(stopped.phase, 'ready'); assert.equal(stopped.failures.length, 8);
    assert.equal(stopped.failures[0].code, 'OTHER');
  } finally { await probe.stop(); await server.close(); await rm(directory, { recursive: true, force: true }); }
});
