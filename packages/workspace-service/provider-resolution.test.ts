import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startWorkspaceService } from './server.ts';
import { connectWorkspace } from './client.ts';
import { ResourcePluginRegistry } from '../../src/resource-plugins/registry.ts';
import { ResourcePluginHost } from '../../src/resource-plugins/host.ts';
import { defineResourcePlugin } from '../../src/resource-plugins/define.ts';
import { ProviderConnections } from '../provider-runtime/connections.ts';
import type { ResourceSnapshot } from '../../src/resource-plugins/types.ts';

test('unknown provider canonicalizes old aliases and URL imports atomically, then caches under surviving identity across restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-canonical-')), registry = new ResourcePluginRegistry();
  registry.register(defineResourcePlugin({ id: 'fixture.renamed', name: 'Renamed', apiVersion: 1, schemaVersion: 1, icon: 'file', preferredView: 'focus', connectionProvider: 'fixture', providerIdentity: (data, resource) => resource.connectionId ? String(data.key) : undefined, fields: { key: { label: 'Key', kind: 'text', required: true } }, creation: { label: 'Attach', mode: 'url', action: 'resource.attach' }, matchInput: input => ({ title: 'Lookup', data: { key: new URL(input).pathname.slice(1) } }) }));
  let calls = 0, label = 'Open';
  const connections = new ProviderConnections(() => [{ id: 'account', account: 'person', providerId: 'fixture', enabled: true, isDefault: true }], [{ id: 'fixture', name: 'Fixture', setupHint: '', accounts: async () => [] }]);
  const providers = { connections, host(registry: ResourcePluginRegistry) { const host = new ResourcePluginHost(registry); host.register('fixture.renamed', { async load() { calls++; return { title: 'Current title', activity: 'idle', attention: 'none', connection: 'connected', label, observedAt: '2026-09-26T12:00:00Z', resolution: { data: { key: 'uuid' }, aliases: [{ key: 'old' }, { key: 'new' }] } }; } }); return host; } };
  let service = await startWorkspaceService(directory, registry, undefined, providers), client = await connectWorkspace(directory);
  try {
    await service.control.dispatch({ commandId: 'seed', expectedRevision: 0, actor: { kind: 'user', id: 'fixture' }, commands: ['old', 'new'].map((id, i) => ({ type: 'item.add', id, resourceId: id + '-r', pluginId: 'fixture.renamed', title: id, data: { key: id }, position: { x: i * 500, y: 0 } })) });
    const before = await service.control.read();
    const read = (refresh = false) => client.call<ResourceSnapshot>('runtime.run', { nodeId: 'old', action: 'resource.read', arguments: { refresh } });
    await read(); const merged = await service.control.read(); assert.equal(merged.resources.length, 1); assert.deepEqual(merged.resources[0].data, { key: 'uuid' });
    for (const node of before.nodes) assert.deepEqual(merged.nodes.find(item => item.id === node.id)?.position, node.position);
    assert.ok(merged.nodes.every(node => node.title === 'Current title'));
    const callCount = calls; await read(); assert.equal(calls, callCount); await read(true); assert.equal((await service.control.read()).revision, merged.revision);
    const request = { requestId: randomUUID(), nodeId: randomUUID(), resourceId: randomUUID(), pluginId: 'fixture.renamed', expectedRevision: merged.revision, title: 'Lookup', position: { x: 1000, y: 0 }, data: { url: 'https://fixture.test/new' } };
    const result = await client.call('item.create', request); assert.equal((await service.control.read()).nodes.length, 2);
    client.close(); await service.close(); service = await startWorkspaceService(directory, registry, undefined, providers); client = await connectWorkspace(directory);
    const afterRestart = calls; assert.deepEqual(await client.call('item.create', request), result); await read(); assert.equal(calls, afterRestart);
    label = 'Finished'; await read(true); const refreshed = await service.control.read(); assert.ok(refreshed.nodes.every(node => node.summary === label)); assert.equal(refreshed.resources.length, 1);
  } finally { client.close(); await service.close(); await rm(directory, { recursive: true, force: true }); }
});
