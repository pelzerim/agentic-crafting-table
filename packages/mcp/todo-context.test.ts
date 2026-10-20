import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { startWorkspaceService } from '../workspace-service/server.ts';
import { connectWorkspace } from '../workspace-service/client.ts';
import { createServiceMcpServer } from './service-server.ts';

const parse = (result: any) => JSON.parse(result.content[0].text);

test('an agent leaves context on to-dos without a revision, reads it back, and a later agent is given it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'act-mcp-todo-context-'));
  const service = await startWorkspaceService(directory, undefined, undefined, { assignments: [] }), connection = await connectWorkspace(directory);
  const server = createServiceMcpServer(connection, { agentNodeId: 'agent', projectId: 'project' }), client = new Client({ name: 'todo-context-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  try {
    await service.control.dispatch({ commandId: 'setup', expectedRevision: 0, actor: { kind: 'user', id: 'test' }, commands: [
      { type: 'project.create', id: 'project', title: 'Billing', position: { x: 0, y: 0 } },
      { type: 'item.add', id: 'agent', resourceId: 'agent-r', pluginId: 'agent.session', title: 'Pricing agent', projectId: 'project', data: { sessionId: 'session-agent', provider: 'claude' }, position: { x: 600, y: 0 } },
      { type: 'item.add', id: 'task', resourceId: 'task-r', pluginId: 'workspace.todo', title: 'Check billing flows', projectId: 'project', data: {}, position: { x: 0, y: 600 } },
      { type: 'link.save', link: { id: 'task-agent', sourceId: 'task', targetId: 'agent', kind: 'reference' } },
    ] });
    const call = async (name: string, args: Record<string, unknown>) => { const result = await client.callTool({ name, arguments: args }); assert.notEqual(result.isError, true, JSON.stringify(result)); return parse(result); };
    const tool = (await client.listTools()).tools.find(tool => tool.name === 'workspace_apply')!;
    assert.match(tool.description!, /todo\.context/); assert.match(tool.description!, /stays when you are gone/);

    const created = await call('workspace_apply', { command: { type: 'todo.save', todo: { id: 'migrate', title: 'Migrate invoices', nodeIds: ['agent'], context: 'Reasoning: the old table is frozen.' } } });
    assert.equal(created.todos[0].context, 'Reasoning: the old table is frozen.');
    assert.deepEqual(created.todos[0].contextBy, { kind: 'agent', id: 'agent', title: 'Pricing agent' });
    const appended = await call('workspace_apply', { commandId: 'next-steps', command: { type: 'todo.context', id: 'migrate', context: 'Next: run the backfill, see https://example.com/runbook', mode: 'append' } });
    assert.equal(appended.revision, created.revision + 1);
    const replayed = await call('workspace_apply', { commandId: 'next-steps', command: { type: 'todo.context', id: 'migrate', context: 'Next: run the backfill, see https://example.com/runbook', mode: 'append' } });
    assert.equal(replayed.replayed, true);
    await call('workspace_apply', { command: { type: 'todo.context', id: 'map:task', context: 'Staging only so far.', mode: 'replace' } });

    const read = await call('workspace_read', {});
    assert.equal(read.todos[0].context, 'Reasoning: the old table is frozen.\n\nNext: run the backfill, see https://example.com/runbook');
    assert.equal(read.nodes.find((node: any) => node.id === 'task').todoContext, 'Staging only so far.');
    assert.equal(read.nodes.find((node: any) => node.id === 'task').todoContextBy.title, 'Pricing agent');

    const tooLong = await client.callTool({ name: 'workspace_apply', arguments: { command: { type: 'todo.context', id: 'migrate', context: 'x'.repeat(7990), mode: 'append' } } });
    assert.equal(tooLong.isError, true); assert.match((tooLong.content as { text: string }[])[0].text, /the limit is 8,000/);
    const moved = await client.callTool({ name: 'workspace_apply', arguments: { commands: [{ type: 'todo.context', id: 'migrate', context: 'Extra', mode: 'append' }, { type: 'todo.archive', id: 'migrate' }] } });
    assert.equal(moved.isError, true); assert.match((moved.content as { text: string }[])[0].text, /todo\.archive needs expectedRevision/);
    assert.equal((await service.store.read()).revision, read.revision);

    const context = await call('workspace_run', { action: 'agent.context', nodeId: 'agent' });
    assert.deepEqual(context.todoContext.map((entry: any) => [entry.todoId, entry.title, entry.done, entry.context, entry.writtenBy]), [
      ['migrate', 'Migrate invoices', false, read.todos[0].context, 'Pricing agent'],
      ['map:task', 'Check billing flows', false, 'Staging only so far.', 'Pricing agent'],
    ]);
    assert.ok(context.todoContext.every((entry: any) => entry.writtenAt));
    assert.match(context.usage, /todoContext/);
    assert.ok(!context.guide.prompt.includes('old table is frozen'));
    await call('workspace_run', { action: 'agent.context.ack', nodeId: 'agent', arguments: { deliveryId: context.deliveryId } });
    assert.equal((await call('workspace_run', { action: 'agent.context', nodeId: 'agent' })).acknowledged, true);
    await call('workspace_apply', { command: { type: 'todo.context', id: 'migrate', context: 'Backfill finished.', mode: 'append' } });
    const offered = await call('workspace_run', { action: 'agent.context', nodeId: 'agent' });
    assert.equal(offered.acknowledged, false, 'changed context is offered anew'); assert.match(offered.todoContext[0].context, /Backfill finished\.$/);
  } finally { await client.close(); await server.close(); connection.close(); await service.close(); await rm(directory, { recursive: true, force: true }); }
});
