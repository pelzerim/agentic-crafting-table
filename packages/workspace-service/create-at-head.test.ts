import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startWorkspaceService } from './server.ts';
import { connectWorkspace } from './client.ts';
import { prepareWorkspace } from './paths.ts';
import { serveLocal } from './local-rpc.ts';
import type { LaunchRequest, SessionSnapshot } from '../session-runtime/protocol.ts';

test('a session item is created without a revision while the map changes, and its retry is the same session', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'act-create-at-head-')));
  const runtimeDirectory = join(directory, 'runtime'), paths = prepareWorkspace(runtimeDirectory);
  const launched: LaunchRequest[] = [];
  // Real local IPC, simulated supervisor replies: no shell starts here.
  const runtime = await serveLocal(paths.socket, paths.secret, (method, input) => {
    if (method === 'hello') return { protocol: 1, service: 'sessions' };
    if (method === 'diagnostics.configure') return {};
    if (method === 'sessions.list') return [];
    const launch = input as LaunchRequest;
    if (method === 'sessions.launch') launched.push(launch); else assert.equal(method, 'sessions.read');
    const prior = launched.find(entry => entry.sessionId === (launch.sessionId ?? (input as { sessionId: string }).sessionId))!;
    return { session: { ...prior, native: undefined, id: prior.sessionId, state: 'running', createdAt: '', updatedAt: '' }, chunks: [], firstSequence: 1, lastSequence: 0, truncated: false } satisfies SessionSnapshot;
  });
  const service = await startWorkspaceService(directory, undefined, { directory: runtimeDirectory, executable: process.execPath, entrypoint: 'unused', electronRuntime: false }, { assignments: [], reviews: {}, workflows: {} });
  const client = await connectWorkspace(directory);
  try {
    await service.control.dispatch({ commandId: 'seed', expectedRevision: 0, actor: { kind: 'user', id: 'test' }, commands: [
      { type: 'item.add', id: 'agent', resourceId: 'agent-r', pluginId: 'workspace.note', title: 'Agent', data: { text: 'agent' }, position: { x: 600, y: 0 } }] });
    // Someone else writes between the plan's read and its write: the stale revision the plan would have frozen.
    const read = service.control.read.bind(service.control); let raced = false;
    service.control.read = async () => {
      const state = await read();
      if (!raced && state.revision === 1) { raced = true; await service.control.dispatch({ commandId: 'poll', expectedRevision: 1, actor: { kind: 'provider', id: 'poll' }, commands: [{ type: 'node.update', id: 'agent', summary: 'Polled' }] }); }
      return state;
    };
    const request = { requestId: randomUUID(), nodeId: randomUUID(), resourceId: randomUUID(), pluginId: 'terminal.session', title: 'Shell', position: { x: 0, y: 0 }, data: { cwd: directory },
      connection: { id: randomUUID(), otherId: 'agent', kind: 'reference', sourceIsNew: true } };
    const created = await client.call<SessionSnapshot>('item.create', request);
    assert.equal(raced, true); assert.equal(created.session.id, request.requestId); assert.equal(launched.length, 1);
    const state = await service.control.read();
    assert.equal(state.nodes.filter(node => node.id === request.nodeId).length, 1);
    assert.deepEqual(state.links.map(link => [link.sourceId, link.targetId]), [[request.nodeId, 'agent']]);
    assert.equal(state.nodes.find(node => node.id === 'agent')!.summary, 'Polled', 'the concurrent write is kept');
    await client.call('item.create', request);
    assert.equal(launched.length, 1, 'the retry launches nothing');
    assert.equal((await service.control.read()).nodes.filter(node => node.id === request.nodeId).length, 1);
    await assert.rejects(client.call('item.create', { ...request, expectedRevision: 0, requestId: randomUUID(), nodeId: randomUUID(), resourceId: randomUUID() }), { code: 'REVISION_CONFLICT' });
  } finally { client.close(); await service.close(); await runtime.close(); await rm(directory, { recursive: true, force: true }); }
});
