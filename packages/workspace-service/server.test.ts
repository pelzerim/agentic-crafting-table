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
