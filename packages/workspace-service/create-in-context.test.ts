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
import { layoutFootprints, ITEM_GAP } from '../../src/graph/movement.ts';
import { boundsOf } from '../../src/graph/undermap.ts';

test('a session an agent creates without a position lands beside it, in its project, once', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'act-create-in-context-')));
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
    const seeded = await service.control.dispatch({ commandId: 'seed', expectedRevision: 0, actor: { kind: 'user', id: 'test' }, commands: [
      { type: 'project.create', id: 'p', title: 'p', position: { x: 0, y: 0 } },
      { type: 'item.add', id: 'agent', resourceId: 'agent-r', pluginId: 'workspace.note', title: 'Agent', data: { text: 'agent' }, projectId: 'p', position: { x: 600, y: 0 } }] });
    const request = { requestId: randomUUID(), nodeId: randomUUID(), resourceId: randomUUID(), pluginId: 'terminal.session', title: 'Shell', data: { cwd: directory }, placedBy: 'agent' };
    await client.call<SessionSnapshot>('item.create', request);
    const state = await service.control.read(), created = state.nodes.find(node => node.id === request.nodeId)!;
    const boxes = new Map(layoutFootprints(state.nodes, state.resources, service.control.registry).map(box => [box.id, box]));
    const own = boundsOf([boxes.get(created.id)!]), anchor = boundsOf([boxes.get('agent')!]);
    assert.equal(created.projectId, 'p'); assert.equal(own.left, anchor.right + ITEM_GAP); assert.equal(own.top, anchor.top);
    assert.deepEqual(state.nodes.find(node => node.id === 'agent')!.position, seeded.state.nodes.find(node => node.id === 'agent')!.position);
    await client.call('item.create', request);
    assert.equal(launched.length, 1, 'the retry launches nothing');
    assert.deepEqual((await service.control.read()).nodes.find(node => node.id === request.nodeId)!.position, created.position);
    await assert.rejects(client.call('item.create', { ...request, requestId: randomUUID(), nodeId: randomUUID(), resourceId: randomUUID(), placedBy: 'mcp-client' }), /position is required/);
    assert.equal(launched.length, 1, 'a request nothing can place starts no session');
    const { placedBy, ...plain } = request, exact = { ...plain, requestId: randomUUID(), nodeId: randomUUID(), resourceId: randomUUID(), position: { x: 9000, y: 9000 } };
    await client.call('item.create', exact);
    const person = (await service.control.read()).nodes.find(node => node.id === exact.nodeId)!;
    assert.equal(placedBy, 'agent'); assert.deepEqual(person.position, exact.position); assert.equal(person.projectId, undefined);
  } finally { client.close(); await service.close(); await runtime.close(); await rm(directory, { recursive: true, force: true }); }
});
