import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnection } from 'node:net';
import { once } from 'node:events';
import { startWorkspaceService } from './server.ts';
import { connectWorkspace } from './client.ts';
import type { WorkspaceSnapshot } from './protocol.ts';
import type { SettingsSnapshot } from '../core/settings.ts';
import { selectProviderAccount } from '../core/connections.ts';
import { stateSchema } from '../core/control.ts';

const envelope = { commandId: 'one', expectedRevision: 0, actor: { kind: 'user', id: 'test' }, commands: [{ type: 'project.create', id: 'p', title: 'Project 🪴', position: { x: 1, y: 2 } }] };

test('authenticated clients share committed snapshots, reject bad writes, and reconnect after service restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-service-'));
  let service = await startWorkspaceService(directory);
  let a = await connectWorkspace(directory), b = await connectWorkspace(directory);
  try {
    const snapshots: WorkspaceSnapshot[] = []; b.on('snapshot', snapshot => snapshots.push(snapshot));
    await b.subscribe();
    assert.equal(snapshots[0].cursor, 0);
    const changed = once(b, 'snapshot');
    await a.call('apply', envelope);
    await changed;
    assert.equal(snapshots.at(-1)!.state.nodes[0].title, 'Project 🪴');
    assert.equal(snapshots.at(-1)!.cursor, 1);
    await a.call('apply', envelope);
    await assert.rejects(a.call('apply', { ...envelope, commandId: 'stale' }), (error: any) => error.code === 'REVISION_CONFLICT' && error.currentRevision === 1);
    await assert.rejects(a.call('shell.execute', {}), /Unknown workspace method/);
    await assert.rejects(startWorkspaceService(directory), /already running/);
    a.close(); b.close(); await service.close();
    service = await startWorkspaceService(directory);
    a = await connectWorkspace(directory); b = await connectWorkspace(directory);
    assert.equal((await a.call<WorkspaceSnapshot>('read')).state.revision, 1);
    service.store.compactEvents(1);
    const resumed = await b.call<WorkspaceSnapshot & { resetRequired: boolean }>('subscribe', { after: 0 });
    assert.equal(resumed.resetRequired, true); assert.equal(resumed.cursor, 1);
    assert.equal(resumed.state.nodes[0].title, 'Project 🪴');
  } finally { a.close(); b.close(); await service.close(); await rm(directory, { recursive: true, force: true }); }
});

test('a subscriber on the map layer receives the map without the 600 items below; below, a read and an old subscriber get everything', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-layers-'));
  const service = await startWorkspaceService(directory);
  const writer = await connectWorkspace(directory), map = await connectWorkspace(directory), legacy = await connectWorkspace(directory);
  try {
    const AT = '2026-10-27T08:00:00.000Z', stored = Array.from({ length: 600 }, (_, index) => `stored-${index}`);
    await service.store.update(state => stateSchema.parse({ ...state,
      nodes: [{ id: 'live', title: 'Live', position: { x: 0, y: 0 } }, { id: 'old', title: 'Old', position: { x: 3000, y: 0 }, belowAt: AT },
        { id: 'card', title: 'Card', resourceId: 'card-r', projectId: 'live', position: { x: 0, y: 0 } },
        ...stored.map((id, index) => ({ id, title: `Stored note ${index} with a summary long enough to weigh something`, resourceId: `${id}-r`, projectId: 'old', position: { x: 3000 + index, y: 0 }, summary: 'Kept below for later reference' }))],
      resources: [{ id: 'card-r', pluginId: 'workspace.note', schemaVersion: 1, title: 'Card', data: { text: 'On the map' } },
        ...stored.map(id => ({ id: `${id}-r`, pluginId: 'workspace.note', schemaVersion: 1, title: id, data: { text: 'A note that has been sent below the map with some text in it.' } }))],
      links: stored.slice(1).map((id, index) => ({ id: `chain-${index}`, sourceId: stored[index], targetId: id, kind: 'reference', label: '' })) }));
    const received = { map: [] as WorkspaceSnapshot[], legacy: [] as WorkspaceSnapshot[] };
    map.on('snapshot', snapshot => received.map.push(snapshot)); legacy.on('snapshot', snapshot => received.legacy.push(snapshot));
    const first = await map.subscribe(0, 'map');
    assert.deepEqual(first.state.nodes.map(node => node.id), ['live', 'old', 'card']);
    assert.deepEqual(first.state.resources.map(resource => resource.id), ['card-r']);
    assert.deepEqual(first.state.links, []);
    assert.deepEqual(first.layers, { below: { items: 600, projects: ['old'] } });
    const whole = await legacy.subscribe();
    assert.equal(whole.state.nodes.length, 603); assert.equal(whole.layers, undefined);
    assert.equal((await map.call<WorkspaceSnapshot>('read')).state.nodes.length, 603);
    const arrived = Promise.all([once(map, 'snapshot'), once(legacy, 'snapshot')]);
    await writer.call('apply', { ...envelope, commands: [{ type: 'node.move', id: 'card', position: { x: 40, y: 0 } }] });
    await arrived;
    const bytes = (snapshot: WorkspaceSnapshot) => Buffer.byteLength(JSON.stringify({ event: 'snapshot', snapshot }) + '\n');
    const before = bytes(received.legacy.at(-1)!), after = bytes(received.map.at(-1)!);
    t.diagnostic(`snapshot frame with 600 items below: whole ${before} bytes, map layer ${after} bytes`);
    assert.ok(after * 20 < before, `${after} vs ${before}`);
    assert.equal(received.map.at(-1)!.state.nodes.find(node => node.id === 'card')!.position.x, 40);
    // Travel: subscribing again answers with that layer at once, and later broadcasts follow it.
    const down = await map.subscribe(received.map.at(-1)!.cursor, 'below');
    assert.equal(down.state.nodes.length, 603); assert.equal(received.map.at(-1), down);
    const next = once(map, 'snapshot');
    await writer.call('apply', { ...envelope, commandId: 'two', expectedRevision: 1, commands: [{ type: 'node.move', id: 'card', position: { x: 80, y: 0 } }] });
    assert.equal((await next)[0].state.nodes.length, 603);
    const up = await map.subscribe(down.cursor, 'map');
    assert.equal(up.state.nodes.length, 3); assert.equal(received.map.at(-1), up);
  } finally { writer.close(); map.close(); legacy.close(); await service.close(); await rm(directory, { recursive: true, force: true }); }
});

test('a socket without the private token cannot read or mutate the workspace', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-auth-'));
  const service = await startWorkspaceService(directory);
  const socket = createConnection(service.paths.socket);
  try {
    await once(socket, 'connect');
    const response = once(socket, 'data');
    socket.write(JSON.stringify({ id: 'unauthorized', token: 'x'.repeat(64), method: 'apply', args: envelope }) + '\n');
    const [data] = await response;
    assert.equal(JSON.parse(data.toString()).error.code, 'UNAUTHORIZED');
    assert.equal((await service.store.read()).revision, 0);
  } finally { socket.destroy(); await service.close(); await rm(directory, { recursive: true, force: true }); }
});

test('connections.select applies one provider account immediately with the same revision rules as settings.write', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-select-'));
  const service = await startWorkspaceService(directory), client = await connectWorkspace(directory);
  try {
    const before = await client.call<SettingsSnapshot>('settings.read');
    const chosen = await client.call<SettingsSnapshot>('connections.select', { providerId: 'github', account: 'octocat', label: 'Octo Cat' });
    assert.equal(chosen.revision, before.revision + 1);
    assert.deepEqual(chosen.value.connections.map(({ id: _, ...rest }) => rest), [{ providerId: 'github', account: 'octocat', label: 'Octo Cat', enabled: true, isDefault: true }]);
    assert.deepEqual({ ...chosen.value, connections: [] }, { ...before.value, connections: [] });
    // A draft saved from the older revision (UI or MCP workspace_settings) still conflicts.
    await assert.rejects(client.call('settings.write', { expectedRevision: before.revision, value: before.value }), (error: any) => error.code === 'REVISION_CONFLICT');
    const same = await client.call<SettingsSnapshot>('settings.write', { expectedRevision: chosen.revision, value: { ...chosen.value, connections: selectProviderAccount(chosen.value.connections, 'github', 'octocat', 'unused', 'Octo Cat') } });
    assert.deepEqual(same.value.connections, chosen.value.connections);
    const disconnected = await client.call<SettingsSnapshot>('connections.select', { providerId: 'github' });
    assert.deepEqual(disconnected.value.connections.map(connection => [connection.id, connection.enabled, connection.isDefault]), [[chosen.value.connections[0].id, false, false]]);
    const again = await client.call<SettingsSnapshot>('connections.select', { providerId: 'github', account: 'octocat' });
    assert.equal(again.value.connections[0].id, chosen.value.connections[0].id);
    await assert.rejects(client.call('connections.select', { providerId: 'unknown', account: 'x' }), /Unknown provider/);
    await assert.rejects(client.call('connections.select', { providerId: 'github', account: 'x', token: 'secret' }));
    assert.equal((await client.call<SettingsSnapshot>('settings.read')).revision, again.revision);
  } finally { client.close(); await service.close(); await rm(directory, { recursive: true, force: true }); }
});
