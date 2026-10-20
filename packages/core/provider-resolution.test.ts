import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WorkspaceControl } from './control.ts';
import { ResourcePluginRegistry } from '../../src/resource-plugins/registry.ts';
import { defineResourcePlugin } from '../../src/resource-plugins/define.ts';
import { ResourcePluginHost } from '../../src/resource-plugins/host.ts';
import type { ResourceSnapshot } from '../../src/resource-plugins/types.ts';

const plugin = defineResourcePlugin({ id: 'fixture.record', name: 'Record', apiVersion: 1, schemaVersion: 1, icon: 'file', preferredView: 'focus', connectionProvider: 'fixture', providerIdentity: data => String(data.key), fields: { key: { label: 'Key', kind: 'text', required: true } }, creation: { label: 'Record' } });
const registry = () => { const result = new ResourcePluginRegistry(); result.register(plugin); return result; };
const add = (id: string, key: string, account = 'account') => ({ type: 'item.add', id, resourceId: id + '-r', pluginId: plugin.id, title: id, data: { key }, connectionId: account, position: { x: 500 * id.length, y: 0 } });
const batch = (commandId: string, expectedRevision: number, commands: unknown[]) => ({ commandId, expectedRevision, actor: { kind: 'system', id: 'fixture' }, commands });

test('canonical reconciliation preserves aliases, links, to-dos, lifecycle and separate account identities with replay', async () => {
  const control = new WorkspaceControl(undefined, registry());
  await control.dispatch(batch('seed', 0, [add('old', 'OLD-1'), add('canonical', 'uuid'), add('other', 'uuid', 'different'), { type: 'link.save', link: { id: 'edge', sourceId: 'old', targetId: 'other', kind: 'reference' } }, { type: 'todo.save', todo: { id: 'task', title: 'Read', nodeIds: ['old'] } }, { type: 'node.archive', id: 'old' }]));
  const before = await control.read(), request = batch('resolve', before.revision, [{ type: 'item.resolve', id: 'old', data: { key: 'uuid' } }]);
  await assert.rejects(control.dispatch(batch('edit', before.revision, [{ type: 'item.update', id: 'old', data: { key: 'uuid' } }])), /already represents/);
  const result = await control.dispatch(request); assert.equal(result.state.resources.length, 2);
  assert.deepEqual(result.state.nodes, before.nodes.map(node => node.id === 'old' ? { ...node, resourceId: 'canonical-r' } : node));
  assert.deepEqual(result.state.links, before.links); assert.deepEqual(result.state.todos, before.todos);
  assert.equal((await control.dispatch(request)).replayed, true);
});

test('canonical merging reruns one-partner validation and rolls back the whole batch on collision', async () => {
  const restricted = new ResourcePluginRegistry(); restricted.register({ ...plugin, relationships: { cardinality: 'one' } });
  const control = new WorkspaceControl(undefined, restricted);
  await control.dispatch(batch('seed', 0, [add('a', 'a'), add('b', 'b'), add('c', 'c'), add('d', 'd'), { type: 'link.save', link: { id: 'ac', sourceId: 'a', targetId: 'c', kind: 'reference' } }, { type: 'link.save', link: { id: 'bd', sourceId: 'b', targetId: 'd', kind: 'reference' } }]));
  const before = await control.read();
  await assert.rejects(control.dispatch(batch('bad', before.revision, [{ type: 'node.update', id: 'a', title: 'Must roll back' }, { type: 'item.resolve', id: 'a', data: { key: 'b' } }])), /one|single/i);
  assert.deepEqual(await control.read(), before);
});

test('backend resolution validates every canonical/alias payload and requires a connected bound account', async () => {
  const host = new ResourcePluginHost(registry()), resource = { id: 'r', pluginId: plugin.id, schemaVersion: 1, title: 'Record', connectionId: 'account', data: { key: 'old' } };
  const snapshot: ResourceSnapshot = { title: 'Renamed', activity: 'idle', attention: 'none', connection: 'connected', label: '', observedAt: '', resolution: { data: { key: 'uuid' }, aliases: [] } };
  host.register(plugin.id, { async load() { return snapshot; } });
  assert.deepEqual((await host.load(resource, AbortSignal.timeout(1000))).resolution?.aliases, [{ key: 'old' }]);
  snapshot.resolution!.aliases = [{ key: null }]; await assert.rejects(host.load(resource, AbortSignal.timeout(1000)), /invalid canonical/);
  snapshot.resolution!.aliases = []; await assert.rejects(host.load({ ...resource, connectionId: undefined }, AbortSignal.timeout(1000)), /connected account/);
  snapshot.connection = 'disconnected'; await assert.rejects(host.load(resource, AbortSignal.timeout(1000)), /connected account/);
});
