import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { REQUEST_REVISION_RULES } from '../core/revision-policy.ts';
import { startWorkspaceService } from '../workspace-service/server.ts';
import { connectWorkspace } from '../workspace-service/client.ts';
import { linearProviders } from '../../tests/fixtures/linear.ts';
import { createServiceMcpServer } from './service-server.ts';

const position = { x: 0, y: 0 };
const parse = (result: any) => JSON.parse(result.content[0].text);
const note = (id: string, extra: Record<string, unknown> = {}) => ({ type: 'item.add', id, resourceId: `${id}-r`, pluginId: 'workspace.note', title: id, data: { text: id }, position, ...extra });

/** The production MCP server on a real service and store, bound to the agent node `agent` in `project`. */
async function table() {
  const directory = await mkdtemp(join(tmpdir(), 'act-mcp-revision-free-')), providers = linearProviders();
  const service = await startWorkspaceService(directory, undefined, undefined, providers), connection = await connectWorkspace(directory);
  const server = createServiceMcpServer(connection, { agentNodeId: 'agent', projectId: 'project' }), client = new Client({ name: 'revision-free-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  await service.control.dispatch({ commandId: 'setup', expectedRevision: 0, actor: { kind: 'user', id: 'test' }, commands: [
    { type: 'project.create', id: 'project', title: 'Billing', position },
    { type: 'item.add', id: 'agent', resourceId: 'agent-r', pluginId: 'agent.session', title: 'Agent', projectId: 'project', data: { sessionId: 'session-agent', provider: 'claude' }, position: { x: 600, y: 0 } },
    note('other', { projectId: 'project', position: { x: 0, y: 600 } }),
  ] });
  const apply = (input: Record<string, unknown>) => client.callTool({ name: 'workspace_apply', arguments: input });
  return { service, client, providers, apply, close: async () => { await client.close(); await server.close(); connection.close(); await service.close(); await rm(directory, { recursive: true, force: true }); } };
}

test('an agent registers a PR with its link without reading a revision, and a retry replays', async () => {
  const bench = await table();
  try {
    const input = { commandId: 'register-pr', command: { type: 'item.add', id: 'pr', resourceId: 'pr-r', pluginId: 'github.pull-request', title: 'Pull request', projectId: 'project', position: { x: 300, y: 0 },
      data: { owner: 'acme', repo: 'app', number: 7 }, links: [{ agent: true, kind: 'reference' }] } };
    const before = (await bench.service.control.read()).revision;
    const first = parse(await bench.apply(input));
    assert.equal(first.replayed, false); assert.equal(first.revision, before + 1, 'the result carries the new revision to chain from');
    assert.deepEqual(first.itemLinks, [{ nodeId: 'pr', resourceId: 'pr-r', reusedResource: false, links: [{ id: 'link:pr:agent:reference:source', existing: false }] }]);
    await bench.service.control.dispatch({ commandId: 'elsewhere', expectedRevision: first.revision, actor: { kind: 'provider', id: 'poll' }, commands: [note('polled')] });
    const again = parse(await bench.apply(input));
    const state = await bench.service.control.read();
    assert.equal(again.replayed, true); assert.equal(again.revision, state.revision, 'a retry chains from the current revision');
    assert.equal(state.revision, before + 2); assert.equal(state.nodes.filter(node => node.id === 'pr').length, 1); assert.equal(state.links.length, 1);
    const reused = await bench.apply({ commandId: 'register-pr', command: note('different') });
    assert.equal(reused.isError, true); assert.equal(parse(reused).error.code, 'COMMAND_ID_CONFLICT');
  } finally { await bench.close(); }
});

test('revision-free writes from several callers all land once while the map keeps changing', async () => {
  const bench = await table();
  try {
    const before = (await bench.service.control.read()).revision, ids = Array.from({ length: 12 }, (_, index) => `note-${index}`);
    const results = await Promise.all(ids.map(id => bench.apply({ command: note(id, { projectId: 'project', links: [{ agent: true, kind: 'reference' }] }) })));
    assert.deepEqual(results.map(result => result.isError ?? false), ids.map(() => false), JSON.stringify(results.find(result => result.isError)?.content));
    const state = await bench.service.control.read();
    assert.equal(state.revision, before + ids.length);
    for (const id of ids) { assert.equal(state.nodes.filter(node => node.id === id).length, 1); assert.equal(state.links.filter(link => link.sourceId === id && link.targetId === 'agent').length, 1); }
  } finally { await bench.close(); }
});

test('a command that needs a revision is refused without one, alone or in a batch', async () => {
  const bench = await table();
  try {
    const before = await bench.service.control.read();
    const moved = await bench.apply({ command: { type: 'node.move', id: 'other', position: { x: 40, y: 40 } } });
    assert.equal(moved.isError, true);
    assert.deepEqual(parse(moved).error, { code: 'REVISION_REQUIRED', message: 'node.move needs expectedRevision: it overwrites positions the user may be changing. Pass the revision from workspace_read.' });
    const mixed = await bench.apply({ commands: [note('added'), { type: 'node.archive', id: 'other' }] });
    assert.equal(mixed.isError, true); assert.match(parse(mixed).error.message, /^node\.archive needs expectedRevision/);
    assert.deepEqual(await bench.service.control.read(), before, 'nothing was written');
    const batch = parse(await bench.apply({ commands: [note('one'), note('two'), { type: 'link.save', link: { id: 'pair', sourceId: 'one', targetId: 'two', kind: 'reference' } }] }));
    assert.equal(batch.revision, before.revision + 1);
    const explicit = parse(await bench.apply({ expectedRevision: batch.revision, command: { type: 'node.move', id: 'other', position: { x: 40, y: 1200 } } }));
    assert.equal(explicit.revision, batch.revision + 1);
  } finally { await bench.close(); }
});

test('an agent reports its own status without a revision, but not another node’s', async () => {
  const bench = await table();
  try {
    const own = parse(await bench.apply({ command: { type: 'node.update', id: 'agent', summary: 'Tests pass', activity: 'working' } }));
    assert.equal(own.nodes.find((node: any) => node.id === 'agent').summary, 'Tests pass');
    const raised = parse(await bench.apply({ command: { type: 'attention.set', id: 'agent', source: 'agent', reason: 'input', note: 'Agent waiting' } }));
    assert.deepEqual(raised.nodes.find((node: any) => node.id === 'agent').attentionSources, { agent: 'input' });
    const other = await bench.apply({ command: { type: 'node.update', id: 'other', summary: 'Not mine' } });
    assert.equal(other.isError, true); assert.match(parse(other).error.message, /^node\.update needs expectedRevision: it changes a node other than your own session/);
    const renamed = await bench.apply({ command: { type: 'node.update', id: 'agent', title: 'Renamed' } });
    assert.equal(renamed.isError, true); assert.equal(parse(renamed).error.code, 'REVISION_REQUIRED');
  } finally { await bench.close(); }
});

test('a stale explicit revision still conflicts, even for a command that could go without one', async () => {
  const bench = await table();
  try {
    const stale = await bench.apply({ expectedRevision: 0, command: note('stale') });
    assert.equal(stale.isError, true); assert.equal(parse(stale).error.code, 'REVISION_CONFLICT');
    assert.equal(parse(stale).error.currentRevision, (await bench.service.control.read()).revision);
    assert.ok(!(await bench.service.control.read()).nodes.some(node => node.id === 'stale'));
  } finally { await bench.close(); }
});

test('workspace_create_item needs no revision and links the new item in the same step', async () => {
  const bench = await table();
  try {
    const request = { requestId: randomUUID(), nodeId: randomUUID(), resourceId: randomUUID(), pluginId: 'linear.ticket', title: 'Lookup', projectId: 'project', position: { x: 300, y: 300 },
      data: { url: bench.providers.data.issue.url }, connections: [{ id: randomUUID(), otherId: 'agent', kind: 'reference', sourceIsNew: true }] };
    const created = await bench.client.callTool({ name: 'workspace_create_item', arguments: request });
    assert.ok(!created.isError, JSON.stringify(created.content));
    const state = await bench.service.control.read(), nodeId = parse(created).nodeId;
    assert.equal(nodeId, request.nodeId);
    assert.deepEqual(state.links.map(link => [link.sourceId, link.targetId, link.kind]), [[nodeId, 'agent', 'reference']]);
    assert.deepEqual(parse(await bench.client.callTool({ name: 'workspace_create_item', arguments: request })), parse(created), 'the same request is the same item');
    assert.equal((await bench.service.control.read()).nodes.filter(node => node.id === nodeId).length, 1);
  } finally { await bench.close(); }
});

test('every tool that takes a revision is classified and says when it is needed', async () => {
  const bench = await table();
  try {
    const tools = (await bench.client.listTools()).tools;
    const taking = tools.filter(tool => JSON.stringify(tool.inputSchema).includes('"expectedRevision"')).map(tool => tool.name).sort();
    assert.deepEqual(taking, Object.keys(REQUEST_REVISION_RULES).filter(name => !name.includes(' ')).sort());
    for (const tool of tools.filter(tool => taking.includes(tool.name))) {
      const required = (tool.inputSchema.required ?? []).includes('expectedRevision');
      if (tool.name !== 'workspace_settings') assert.equal(required, false, `${tool.name} takes expectedRevision optionally`);
    }
    const apply = tools.find(tool => tool.name === 'workspace_apply')!;
    assert.match(apply.description!, /expectedRevision/); assert.match(JSON.stringify(apply.inputSchema.properties!.expectedRevision), /Omit/);
    assert.match(tools.find(tool => tool.name === 'workspace_create_item')!.description!, /expectedRevision is optional/);
    assert.match(tools.find(tool => tool.name === 'workspace_run_skill')!.description!, /expectedRevision is optional/);
  } finally { await bench.close(); }
});
