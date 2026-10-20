import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from './server.ts';
import { WorkspaceControl } from './control.ts';
import { FileStore } from './store.ts';
import { createResourcePluginRegistry } from '../resource-plugins/builtins.ts';
import { defineResourcePlugin } from '../resource-plugins/define.ts';
import { ResourcePluginHost } from '../resource-plugins/host.ts';
import { presentResource } from '../resource-plugins/views.ts';

test('an unknown-to-core plugin goes from MCP discovery to persistence, context, actions and archive', async () => {
  const definition = defineResourcePlugin({
    id: 'test.deployment', apiVersion: 1, schemaVersion: 2, name: 'Deployment', icon: 'rocket',
    preferredView: 'focus', creation: { label: 'Track deployment' },
    appearance: { size: 'medium', tone: 'blue', shape: 'server' },
    relationships: { cardinality: 'one' },
    fields: { deploymentId: { label: 'Deployment ID', kind: 'text', required: true } },
  });
  const registry = createResourcePluginRegistry([definition]);
  const directory = await mkdtemp(join(tmpdir(), 'benchgrove-plugin-'));
  const control = new WorkspaceControl(new FileStore(join(directory, 'workspace.state.json')), registry);
  const host = new ResourcePluginHost(registry);
  host.register(definition.id, {
    async load() { return { activity: 'working', attention: 'none', connection: 'connected', label: 'Deploying', observedAt: new Date().toISOString() }; },
    actions: () => [{ id: 'logs', label: 'Read logs', readOnly: true }, { id: 'promote', label: 'Promote', humanOnly: true }],
    async execute(resource, actionId) { if (actionId === 'promote') throw new Error('humanOnly action reached the connector'); return { deployment: resource.data.deploymentId, output: 'Ready' }; },
    async getContext(resource) { return { resourceId: resource.id, title: resource.title, content: String(resource.data.deploymentId) }; },
  });
  const server = createServer(control, undefined, host);
  const client = new Client({ name: 'plugin-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    return JSON.parse((result.content as { text: string }[])[0].text);
  };
  try {
    await server.connect(serverTransport); await client.connect(clientTransport);
    const catalog = await call('workspace_plugins', {});
    const discovered = catalog.plugins.find((p: { id: string }) => p.id === definition.id);
    assert.deepEqual(discovered.dataSchema.required, ['deploymentId']);
    assert.equal(discovered.capabilities.context, true);
    assert.equal(discovered.relationships.cardinality, 'one');
    let state = await call('workspace_apply', { expectedRevision: 0, command: { type: 'item.add', id: 'node', resourceId: 'resource', pluginId: definition.id, title: 'Preview', data: { deploymentId: 'deploy-42' }, position: { x: 25, y: 50 } } });
    assert.equal(state.resources[0].schemaVersion, 2);
    assert.equal(presentResource(registry, state.resources[0]).appearance.size, 'medium');
    assert.equal((await call('workspace_run', { action: 'resource.read', nodeId: 'node' })).label, 'Deploying');
    assert.equal((await call('workspace_run', { action: 'resource.context', nodeId: 'node' })).content, 'deploy-42');
    assert.equal((await call('workspace_run', { action: 'resource.actions', nodeId: 'node' }))[0].id, 'logs');
    assert.equal((await call('workspace_run', { action: 'resource.action', nodeId: 'node', arguments: { actionId: 'logs' } })).output, 'Ready');
    const refused = await client.callTool({ name: 'workspace_run', arguments: { action: 'resource.action', nodeId: 'node', arguments: { actionId: 'promote' } } });
    assert.equal(refused.isError, true); assert.match((refused.content as { text: string }[])[0].text, /needs a person to confirm it in the app/);
    state = await call('workspace_apply', { expectedRevision: 1, command: { type: 'item.update', id: 'node', data: { deploymentId: 'deploy-43' } } });
    const invalid = await client.callTool({ name: 'workspace_apply', arguments: { expectedRevision: 2, command: { type: 'item.update', id: 'node', data: {} } } });
    assert.equal(invalid.isError, true);
    assert.deepEqual(await control.read(), state);
    await call('workspace_apply', { expectedRevision: 2, command: { type: 'todo.save', todo: { id: 'task', title: 'Check deploy', nodeIds: ['node'] } } });
    await call('workspace_apply', { expectedRevision: 3, command: { type: 'node.archive', id: 'node' } });
    await call('workspace_apply', { expectedRevision: 4, command: { type: 'node.restore', id: 'node' } });
    const reloaded = new WorkspaceControl(new FileStore(join(directory, 'workspace.state.json')), registry);
    state = await reloaded.read();
    assert.deepEqual(state.nodes[0].position, { x: 25, y: 50 });
    assert.equal(state.resources[0].data.deploymentId, 'deploy-43');
    assert.equal(state.todos[0].nodeIds[0], 'node');
    assert.equal(state.nodes[0].archivedAt, undefined);
  } finally { await client.close(); await server.close(); await rm(directory, { recursive: true, force: true }); }
});
