import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startWorkspaceService } from '../workspace-service/server.ts';
import { linearProviders } from '../../tests/fixtures/linear.ts';
import { groupWorkspaceTodos } from '../../src/graph/todos.ts';

test('an agent reads Triage to-dos and sends one to a project through production MCP', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-todo-send-mcp-'));
  const service = await startWorkspaceService(directory, undefined, undefined, linearProviders({ assigned: 1 }));
  const client = new Client({ name: 'triage-agent', version: '1' });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [resolve('packages/mcp/entry.ts')], env: { ACT_DATA_DIR: directory, ACT_NODE_ID: 'agent' }, stderr: 'pipe' }));
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args });
      assert.notEqual(result.isError, true, JSON.stringify(result));
      return JSON.parse((result.content as { text: string }[])[0].text);
    };
    const apply = async (command: Record<string, unknown>) => call('workspace_apply', { expectedRevision: (await service.store.read()).revision, command });
    await apply({ type: 'project.create', id: 'billing', title: 'Billing', position: { x: 0, y: 0 } });
    for (let attempt = 0; attempt < 100 && !(await service.store.read()).todos.length; attempt++) await new Promise(resolve => setTimeout(resolve, 20));
    const read = await call('workspace_read', {}), todo = read.todos[0];
    assert.equal(todo.title, 'Assigned ticket 1'); assert.equal(todo.triage.label, 'BIL-1'); assert.equal(todo.triage.status, 'Todo'); assert.equal(todo.horizon, 'inbox');
    const missing = await client.callTool({ name: 'workspace_apply', arguments: { expectedRevision: read.revision, command: { type: 'todo.send', id: todo.id, projectId: 'billing' } } });
    assert.equal(missing.isError, true); assert.match((missing.content as { text: string }[])[0].text, /nodeId and resourceId/);
    const state = await apply({ type: 'todo.send', id: todo.id, projectId: 'billing', nodeId: 'sent', resourceId: 'sent-r' });
    assert.deepEqual(state.nodes.filter((node: { resourceId?: string }) => node.resourceId).map((node: { id: string; projectId?: string }) => [node.id, node.projectId]), [['sent', 'billing'], ['sent:item', 'billing']]);
    assert.deepEqual(groupWorkspaceTodos(state).map(group => [group.title, group.items.map(item => item.id)]), [['Billing', ['map:sent']]]);
    assert.equal(state.todos.length, 0);
  } finally { await client.close(); await service.close(); await rm(directory, { recursive: true, force: true }); }
});

test('an agent files to-dos into Later, moves and ticks them, and reads the horizon through production MCP', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-todo-horizon-mcp-'));
  const service = await startWorkspaceService(directory, undefined, undefined, {});
  const client = new Client({ name: 'horizon-agent', version: '1' });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [resolve('packages/mcp/entry.ts')], env: { ACT_DATA_DIR: directory, ACT_NODE_ID: 'agent' }, stderr: 'pipe' }));
    const tools = await client.listTools(), apply = tools.tools.find(tool => tool.name === 'workspace_apply')!;
    assert.match(apply.description ?? '', /horizon/);
    const call = async (args: Record<string, unknown>) => {
      const result = await client.callTool({ name: 'workspace_apply', arguments: args });
      assert.notEqual(result.isError, true, JSON.stringify(result));
      return JSON.parse((result.content as { text: string }[])[0].text);
    };
    await call({ commands: [{ type: 'todo.save', todo: { id: 'soon', title: 'Fix the flaky test', completed: false, nodeIds: [] } }, { type: 'todo.save', todo: { id: 'someday', title: 'Tidy the fixtures', completed: false, nodeIds: [], horizon: 'later' } }] });
    let read = JSON.parse(((await client.callTool({ name: 'workspace_read', arguments: {} })).content as { text: string }[])[0].text);
    assert.deepEqual(read.todos.map((todo: { id: string; horizon: string }) => [todo.id, todo.horizon]), [['soon', 'next'], ['someday', 'later']]);
    read = await call({ expectedRevision: read.revision, commands: [{ type: 'todo.move', id: 'soon', horizon: 'later', index: 0 }, { type: 'todo.move', id: 'someday', horizon: 'done' }] });
    assert.deepEqual(read.todos.map((todo: { id: string; horizon: string; completed: boolean }) => [todo.id, todo.horizon, todo.completed]), [['soon', 'later', false], ['someday', 'later', true]]);
  } finally { await client.close(); await service.close(); await rm(directory, { recursive: true, force: true }); }
});
