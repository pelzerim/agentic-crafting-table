import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startWorkspaceService } from '../workspace-service/server.ts';
import { groupWorkspaceTodos } from '../../src/graph/todos.ts';

test('notes share durable local creation, editing and agent context through production MCP', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-note-mcp-'));
  let service = await startWorkspaceService(directory, undefined, undefined, { assignments: [] });
  const client = new Client({ name: 'note-agent', version: '1' });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [resolve('packages/mcp/entry.ts')], env: { ACT_DATA_DIR: directory, ACT_NODE_ID: 'agent' }, stderr: 'pipe' }));
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args });
      assert.notEqual(result.isError, true, JSON.stringify(result));
      return JSON.parse((result.content as { text: string }[])[0].text);
    };
    const apply = async (command: Record<string, unknown>) => call('workspace_apply', { expectedRevision: (await service.store.read()).revision, command });
    const discovery = await call('workspace_plugins', {}), plugin = discovery.plugins.find((p: any) => p.id === 'workspace.note');
    assert.equal(plugin.name, 'Note'); assert.equal(plugin.capabilities.context, true);
    assert.ok(plugin.dataSchema.required.includes('text'));
    await apply({ type: 'project.create', id: 'project', title: 'Decisions', position: { x: 0, y: 0 } });
    const original = '  Design decision\nKeep existing API stable.\n\n<script>literal text</script> · 日本語  ';
    await apply({ type: 'item.add', id: 'floating', resourceId: 'floating-resource', pluginId: 'workspace.note', title: 'API notes', data: { text: original }, position: { x: 1000, y: 100 } });
    await apply({ type: 'item.add', id: 'agent', resourceId: 'agent-resource', pluginId: 'agent.session', title: 'Fixture only', data: { sessionId: 'not-running', provider: 'claude' }, projectId: 'project', position: { x: 100, y: 100 } });
    await apply({ type: 'item.add', id: 'note', resourceId: 'note-resource', pluginId: 'workspace.note', title: 'API notes', data: { text: original }, projectId: 'project', position: { x: 600, y: 100 } });
    await apply({ type: 'link.save', link: { id: 'context', sourceId: 'note', targetId: 'agent', kind: 'context' } });
    const before = await call('workspace_read', {});
    assert.equal(before.nodes.find((n: any) => n.id === 'floating').projectId, undefined);
    assert.equal(before.resources.filter((r: any) => r.pluginId === 'workspace.note').length, 2);
    assert.deepEqual(groupWorkspaceTodos(before), []);
    assert.equal((await call('workspace_run', { action: 'resource.context', nodeId: 'note' })).content, original);
    const changed = original + '\nNext: document the migration.';
    await apply({ type: 'item.update', id: 'note', data: { text: changed } });
    const after = await call('workspace_read', {});
    assert.deepEqual(after.nodes.map((n: any) => [n.id, n.position, n.projectId]), before.nodes.map((n: any) => [n.id, n.position, n.projectId])); assert.deepEqual(after.links, before.links);
    assert.equal(after.nodes.find((n: any) => n.id === 'note').title, 'Design decision');
    assert.equal((await call('workspace_run', { action: 'resource.context', nodeId: 'note' })).content, changed);
    for (const text of ['', '  \n ', null]) {
      const rejected = await client.callTool({ name: 'workspace_apply', arguments: { expectedRevision: after.revision, command: { type: 'item.update', id: 'note', data: { text } } } });
      assert.equal(rejected.isError, true);
      assert.equal((await service.store.read()).revision, after.revision);
    }
    const stale = await client.callTool({ name: 'workspace_apply', arguments: { expectedRevision: before.revision, command: { type: 'item.update', id: 'note', data: { text: original } } } });
    assert.equal(stale.isError, true);
    await apply({ type: 'node.resize', id: 'note', size: 'large' });
    const preferences = await call('workspace_settings', {});
    await call('workspace_settings', { update: { expectedRevision: preferences.revision, value: { ...preferences.value, itemMapSizes: { 'workspace.note': { sizes: { large: { width: 360, height: 180 } } } } } } });
    const invalidSettings = await client.callTool({ name: 'workspace_settings', arguments: { update: { expectedRevision: preferences.revision + 1, value: { ...preferences.value, itemMapSizes: { 'workspace.todo': { defaultSize: 'large', sizes: {} } } } } } });
    assert.equal(invalidSettings.isError, true);
    const resized = await call('workspace_read', {});
    assert.equal(resized.nodes.find((n: any) => n.id === 'note').mapSize, 'large');
    assert.deepEqual(resized.resources, after.resources);
    assert.equal(resized.nodes.find((n: any) => n.id === 'floating').mapSize, undefined);
    await apply({ type: 'node.resize', id: 'note', dimensions: { width: 310, height: 170 }, position: { x: 650, y: 160 } });
    const custom = await call('workspace_read', {});
    assert.deepEqual(custom.nodes.find((n: any) => n.id === 'note').mapDimensions, { width: 310, height: 170 });
    assert.deepEqual(custom.nodes.find((n: any) => n.id === 'note').position, { x: 650, y: 160 });
    assert.deepEqual(custom.resources, resized.resources); assert.deepEqual(custom.links, resized.links);
    const invalidSize = await client.callTool({ name: 'workspace_apply', arguments: { expectedRevision: custom.revision, command: { type: 'node.resize', id: 'note', dimensions: { width: 50, height: 80 } } } });
    assert.equal(invalidSize.isError, true); assert.equal((await service.store.read()).revision, custom.revision);
    await apply({ type: 'node.archive', id: 'note' }); await apply({ type: 'node.restore', id: 'note' });
    await client.close(); await service.close();
    service = await startWorkspaceService(directory, undefined, undefined, { assignments: [] });
    const restored = await service.store.read();
    assert.equal(restored.resources.find(r => r.id === 'note-resource')!.data.text, changed);
    assert.equal(restored.resources.find(r => r.id === 'floating-resource')!.data.text, original);
    assert.deepEqual(restored.links, before.links);
    assert.equal(restored.nodes.find(n => n.id === 'note')!.mapSize, 'large');
    assert.deepEqual(restored.nodes.find(n => n.id === 'note')!.mapDimensions, { width: 310, height: 170 });
    assert.equal(service.store.readMapSizes()['workspace.note'].sizes.large?.width, 360);
  } finally { await client.close(); await service.close(); await rm(directory, { recursive: true, force: true }); }
});
