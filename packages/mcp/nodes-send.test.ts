import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startWorkspaceService } from '../workspace-service/server.ts';

test('an agent moves a selection of items to another project through production MCP', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-nodes-send-mcp-'));
  const service = await startWorkspaceService(directory);
  const client = new Client({ name: 'moving-agent', version: '1' });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [resolve('packages/mcp/entry.ts')], env: { ACT_DATA_DIR: directory, ACT_NODE_ID: 'agent' }, stderr: 'pipe' }));
    const tools = await client.listTools();
    assert.match(tools.tools.find(tool => tool.name === 'workspace_apply')!.description!, /nodes\.send moves items/);
    const call = async (command: Record<string, unknown>) => client.callTool({ name: 'workspace_apply', arguments: { expectedRevision: (await service.store.read()).revision, command } });
    const apply = async (command: Record<string, unknown>) => {
      const result = await call(command);
      assert.notEqual(result.isError, true, JSON.stringify(result));
      return JSON.parse((result.content as { text: string }[])[0].text);
    };
    await apply({ type: 'project.create', id: 'billing', title: 'Billing', position: { x: 0, y: 0 } });
    await apply({ type: 'project.create', id: 'docs', title: 'Docs', position: { x: 3000, y: 0 } });
    await apply({ type: 'item.add', id: 'one', resourceId: 'one-r', pluginId: 'workspace.note', title: 'One', data: { text: 'One' }, projectId: 'billing', position: { x: 0, y: 0 } });
    let state = await apply({ type: 'item.add', id: 'two', resourceId: 'two-r', pluginId: 'workspace.note', title: 'Two', data: { text: 'Two' }, projectId: 'billing', position: { x: 0, y: 600 } });
    const at = (id: string) => state.nodes.find((node: { id: string }) => node.id === id);
    const layout = () => ({ x: at('two').position.x - at('one').position.x, y: at('two').position.y - at('one').position.y }), before = layout();
    state = await apply({ type: 'nodes.send', ids: ['one', 'two'], projectId: 'docs' });
    assert.deepEqual([at('one').projectId, at('two').projectId], ['docs', 'docs']);
    assert.deepEqual(layout(), before); assert.ok(at('one').position.x > 2000);
    const refused = await call({ type: 'nodes.send', ids: ['one'], projectId: 'two' });
    assert.equal(refused.isError, true); assert.match((refused.content as { text: string }[])[0].text, /not a project/);
  } finally { await client.close(); await service.close(); await rm(directory, { recursive: true, force: true }); }
});
