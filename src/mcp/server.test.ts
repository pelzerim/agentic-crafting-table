import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from './server.ts';
import { WorkspaceControl } from './control.ts';
import { buildAgentToolContext } from '../agents/tool-context.ts';

test('MCP handshake, discovery, tool validation, resources and absent runtime', async () => {
  const server = createServer();
  const client = new Client({ name: 'test-agent', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    assert.equal(client.getInstructions(), buildAgentToolContext().prompt);
    assert.deepEqual((await client.listTools()).tools.map(t => t.name).sort(), ['workspace_apply', 'workspace_plugins', 'workspace_read', 'workspace_run']);
    const created = await client.callTool({ name: 'workspace_apply', arguments: { expectedRevision: 0, command: { type: 'project.create', id: 'p', title: 'Billing', position: { x: 0, y: 0 } } } });
    assert.equal(created.isError, undefined);
    const conflict = await client.callTool({ name: 'workspace_apply', arguments: { expectedRevision: 0, command: { type: 'node.archive', id: 'p' } } });
    assert.equal(conflict.isError, true);
    const runtime = await client.callTool({ name: 'workspace_run', arguments: { action: 'agent.start', nodeId: 'p' } });
    assert.equal(runtime.isError, true);
    assert.match(JSON.stringify(runtime.content), /not connected/);
    const resource = await client.readResource({ uri: 'benchgrove://workspace' });
    assert.ok('text' in resource.contents[0]);
    assert.equal(JSON.parse(resource.contents[0].text as string).revision, 1);
    assert.ok((await client.listResources()).resources.some(r => r.uri === 'benchgrove://agent-guide'));
    const guide = await client.readResource({ uri: 'benchgrove://agent-guide' });
    assert.ok('text' in guide.contents[0]);
    assert.equal(guide.contents[0].text, buildAgentToolContext().prompt);
    const mute = await client.callTool({ name: 'workspace_apply', arguments: { expectedRevision: 1, command: { type: 'project.mute', id: 'p', muted: true } } });
    assert.equal(mute.isError, true); assert.match(JSON.stringify(mute.content), /needs a person/);
    const invalid = await client.callTool({ name: 'workspace_apply', arguments: { expectedRevision: 1, command: { type: 'view.set', view: { camera: { x: 0, y: 0, zoom: 99 } } } } });
    assert.equal(invalid.isError, true);
  } finally { await client.close(); await server.close(); }
});

test('host runtime receives the actual workspace and returns its execution result', async () => {
  const control = new WorkspaceControl();
  await control.apply({ type: 'project.create', id: 'p', title: 'Billing', summary: 'Plan picker', position: { x: 0, y: 0 } }, 0);
  const requests: unknown[] = [];
  const server = createServer(control, { async execute(request, state, context) { requests.push({ request, state, context }); return { sessionId: 'real-session-id' }; } });
  const client = new Client({ name: 'test-agent', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport); await client.connect(clientTransport);
    const result = await client.callTool({ name: 'workspace_run', arguments: { action: 'agent.start', nodeId: 'p', arguments: { provider: 'claude', task: 'Implement picker', systemPrompt: 'Caller override' } } });
    assert.equal(result.isError, undefined);
    assert.match(JSON.stringify(result.content), /real-session-id/);
    assert.equal(requests.length, 1);
    assert.equal((requests[0] as any).state.nodes[0].summary, 'Plan picker');
    assert.equal((requests[0] as any).context.agentInstructions.systemPrompt, buildAgentToolContext({ projectId: 'p' }).prompt);
    assert.equal((requests[0] as any).context.agentInstructions.delivery, 'system');
    assert.equal((await control.read()).resources.length, 0); // Adapter, not transport, owns output registration.
  } finally { await client.close(); await server.close(); }
});

test('MCP sends items to the Undermap with the same placement as the map', async () => {
  const control = new WorkspaceControl();
  let revision = (await control.apply({ type: 'project.create', id: 'p', title: 'Billing', position: { x: 0, y: 0 } }, 0)).revision;
  for (const [id, x] of [['a', 0], ['b', 400]] as const) revision = (await control.apply({ type: 'item.add', id, resourceId: `${id}-r`, pluginId: 'github.pull-request', title: id, data: { owner: 'acme', repo: 'app', number: x + 1 }, projectId: 'p', position: { x, y: 0 } }, revision)).revision;
  const before = (await control.read()).nodes.find(node => node.id === 'b')!.position;
  const server = createServer(control);
  const client = new Client({ name: 'test-agent', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport); await client.connect(clientTransport);
    const send = (expectedRevision: number, command: unknown) => client.callTool({ name: 'workspace_apply', arguments: { expectedRevision, command } });
    assert.equal((await send(revision, { type: 'node.below', id: 'a' })).isError, undefined);
    assert.equal((await send(revision + 1, { type: 'nodes.action', ids: ['b'], action: 'below' })).isError, undefined);
    const below = (await control.read()).nodes, a = below.find(node => node.id === 'a')!, b = below.find(node => node.id === 'b')!;
    assert.deepEqual(b.mapPosition, before);
    assert.ok(b.position.x > a.position.x, 'beside the item already below');
    assert.equal((await send(revision + 2, { type: 'node.surface', id: 'b' })).isError, undefined);
    assert.deepEqual((await control.read()).nodes.find(node => node.id === 'b')!.position, before);
  } finally { await client.close(); await server.close(); }
});

test('standalone stdio entrypoint speaks MCP and persists a command', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'benchgrove-stdio-'));
  const client = new Client({ name: 'stdio-test', version: '1' });
  try {
    const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('./server.ts', import.meta.url))], env: { BENCHGROVE_STATE_FILE: join(directory, 'workspace.state.json') }, stderr: 'pipe' });
    await client.connect(transport);
    const result = await client.callTool({ name: 'workspace_apply', arguments: { expectedRevision: 0, command: { type: 'project.create', id: 'test', title: 'Shared map', position: { x: 30, y: 60 } } } });
    assert.equal(result.isError, undefined);
    const state = await client.readResource({ uri: 'benchgrove://workspace' });
    assert.ok('text' in state.contents[0]);
    assert.equal(JSON.parse(state.contents[0].text as string).nodes[0].title, 'Shared map');
  } finally { await client.close(); await rm(directory, { recursive: true, force: true }); }
});

test('the scaffold applies an additive command without a revision and refuses the rest', async () => {
  const server = createServer(), client = new Client({ name: 'test-agent', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport); await client.connect(clientTransport);
    const parse = (result: any) => JSON.parse(result.content[0].text);
    const created = parse(await client.callTool({ name: 'workspace_apply', arguments: { command: { type: 'project.create', id: 'p', title: 'Billing', position: { x: 0, y: 0 } } } }));
    assert.equal(created.revision, 1);
    assert.equal(parse(await client.callTool({ name: 'workspace_apply', arguments: { command: { type: 'project.create', id: 'q', title: 'Search', position: { x: 2000, y: 0 } } } })).revision, 2);
    const refused = await client.callTool({ name: 'workspace_apply', arguments: { command: { type: 'node.archive', id: 'p' } } });
    assert.equal(refused.isError, true); assert.match(JSON.stringify(refused.content), /node\.archive needs expectedRevision: .*Pass the revision from workspace_read\./);
    const stale = await client.callTool({ name: 'workspace_apply', arguments: { expectedRevision: 0, command: { type: 'project.create', id: 'r', title: 'Stale', position: { x: 4000, y: 0 } } } });
    assert.equal(stale.isError, true); assert.match(JSON.stringify(stale.content), /Revision conflict/);
  } finally { await client.close(); await server.close(); }
});
