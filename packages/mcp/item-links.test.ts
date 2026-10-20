import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { WorkspaceControl, itemLinkId } from '../core/control.ts';
import { startWorkspaceService } from '../workspace-service/server.ts';
import { humanOnlyMessage } from '../../src/resource-plugins/host.ts';
import { createServiceMcpServer } from './service-server.ts';

const position = { x: 0, y: 0 };
const session = (id: string) => ({ type: 'item.add', id, resourceId: `${id}-r`, pluginId: 'agent.session', title: id, data: { sessionId: `session-${id}`, provider: 'claude' }, position });
const note = (id: string, extra: Record<string, unknown> = {}) => ({ type: 'item.add', id, resourceId: `${id}-r`, pluginId: 'workspace.note', title: id, data: { text: id }, position, ...extra });
const parse = (result: any) => JSON.parse(result.content[0].text);

/** The MCP server over the shared command layer, with every dispatched envelope recorded. */
async function bridge(agentNodeId?: string) {
  const control = new WorkspaceControl(), envelopes: any[] = [];
  const service = { async call(method: string, input?: any) {
    if (method === 'read') return { state: await control.read() };
    if (method === 'apply') { envelopes.push(input); return control.dispatch(input); }
    throw new Error(`Unexpected service call: ${method}`);
  } };
  const server = createServiceMcpServer(service as never, agentNodeId ? { agentNodeId } : {}), client = new Client({ name: 'links-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  await control.dispatch({ commandId: 'setup', expectedRevision: 0, actor: { kind: 'user', id: 'test' }, commands: [session('agent'), { type: 'project.create', id: 'project', title: 'Billing', position }] });
  const apply = async (input: Record<string, unknown>) => client.callTool({ name: 'workspace_apply', arguments: { expectedRevision: (await control.read()).revision, ...input } });
  return { control, client, envelopes, apply, close: async () => { await client.close(); await server.close(); } };
}

test('workspace_apply commands apply together in one revision under one commandId', async () => {
  const table = await bridge('agent');
  try {
    const before = await table.control.read();
    const input = { commandId: 'batch', expectedRevision: before.revision, commands: [note('one'), note('two'), { type: 'link.save', link: { id: 'pair', sourceId: 'one', targetId: 'two', kind: 'reference' } }] };
    const result = parse(await table.client.callTool({ name: 'workspace_apply', arguments: input }));
    assert.equal(result.revision, before.revision + 1); assert.equal(result.commandId, 'batch'); assert.equal(result.replayed, false);
    assert.deepEqual(result.links.map((link: any) => link.id), ['pair']); assert.ok(!('itemLinks' in result));
    assert.equal(table.envelopes.length, 1); assert.equal(table.envelopes[0].commands.length, 3); assert.deepEqual(table.envelopes[0].actor, { kind: 'agent', id: 'agent' });
    assert.equal(parse(await table.client.callTool({ name: 'workspace_apply', arguments: input })).replayed, true);
    const saved = await table.control.read();
    const broken = await table.apply({ commands: [note('three'), { type: 'link.save', link: { id: 'bad', sourceId: 'three', targetId: 'missing', kind: 'reference' } }] });
    assert.equal(broken.isError, true); assert.deepEqual(await table.control.read(), saved, 'a failing command leaves nothing behind');
  } finally { await table.close(); }
});

test('workspace_apply takes exactly one of command and commands, and a human-only command refuses the whole batch', async () => {
  const table = await bridge('agent');
  try {
    const before = await table.control.read();
    for (const input of [{}, { command: note('one'), commands: [note('two')] }, { commands: [] }, { commands: Array.from({ length: 11 }, (_, index) => note(`n${index}`)) }]) {
      const refused = await table.apply(input); assert.equal(refused.isError, true, JSON.stringify(input).slice(0, 80));
    }
    assert.match(JSON.stringify((await table.apply({})).content), /exactly one of command or commands/);
    const muted = await table.apply({ commands: [note('one'), { type: 'project.mute', id: 'project', muted: true }] });
    assert.equal(muted.isError, true); assert.match(JSON.stringify(muted.content), new RegExp(humanOnlyMessage));
    assert.equal(table.envelopes.length, 0, 'refused before the service is called');
    assert.deepEqual(await table.control.read(), before);
  } finally { await table.close(); }
});

test('agent: true links the new item to the calling agent in the same call', async () => {
  const table = await bridge('agent');
  try {
    const result = parse(await table.apply({ command: note('finding', { projectId: 'project', links: [{ agent: true, kind: 'context' }] }) }));
    const id = itemLinkId('finding', { otherId: 'agent', kind: 'context', newItemIs: 'source' });
    assert.deepEqual(result.links, [{ id, sourceId: 'finding', targetId: 'agent', kind: 'context', label: '' }]);
    assert.deepEqual(result.itemLinks, [{ nodeId: 'finding', resourceId: 'finding-r', reusedResource: false, links: [{ id, existing: false }] }]);
    assert.deepEqual(table.envelopes[0].commands[0].links, [{ otherId: 'agent', kind: 'context', newItemIs: 'source' }], 'the service receives a plain node id');
    const both = await table.apply({ command: note('other', { links: [{ agent: true, otherId: 'finding', kind: 'reference' }] }) });
    assert.equal(both.isError, true); assert.match(JSON.stringify(both.content), /otherId or agent: true, not both/);
    const neither = await table.apply({ command: note('other', { links: [{ kind: 'reference' }] }) });
    assert.equal(neither.isError, true); assert.match(JSON.stringify(neither.content), /otherId or agent: true/);
    const batched = parse(await table.apply({ commands: [note('a', { links: [{ agent: true, kind: 'reference', newItemIs: 'target' }] }), note('b', { links: [{ otherId: 'a', kind: 'blocks' }] })] }));
    assert.deepEqual(batched.links.slice(1).map((link: any) => [link.sourceId, link.targetId, link.kind]), [['agent', 'a', 'reference'], ['b', 'a', 'blocks']]);
    assert.equal(batched.itemLinks.length, 2);
  } finally { await table.close(); }
});

test('agent: true is refused clearly when the session has no bound agent', async () => {
  const table = await bridge();
  try {
    const before = await table.control.read();
    const refused = await table.apply({ command: note('finding', { links: [{ agent: true, kind: 'reference' }] }) });
    assert.equal(refused.isError, true); assert.match(JSON.stringify(refused.content), /launched from the table.*otherId/);
    assert.equal(table.envelopes.length, 0); assert.deepEqual(await table.control.read(), before);
    const explicit = parse(await table.apply({ command: note('finding', { links: [{ otherId: 'agent', kind: 'reference' }] }) }));
    assert.equal(explicit.links.length, 1);
  } finally { await table.close(); }
});

test('the advertised tools describe links, commands and connections', async () => {
  const table = await bridge('agent');
  try {
    const tools = (await table.client.listTools()).tools, schema = (name: string) => JSON.stringify(tools.find(tool => tool.name === name)!.inputSchema);
    for (const term of ['"commands"', '"links"', '"agent"', '"newItemIs"']) assert.ok(schema('workspace_apply').includes(term), term);
    assert.ok(schema('workspace_create_item').includes('"connections"'));
    const describe = (name: string) => tools.find(tool => tool.name === name)!.description!;
    assert.match(describe('workspace_apply'), /links:\[\{agent:true/); assert.match(describe('workspace_apply'), /commands/);
    assert.match(describe('workspace_create_item'), /connections/);
  } finally { await table.close(); }
});

test('one stdio call registers a PR and links it to the launching agent; registering it again keeps one node and one link', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-mcp-item-links-'));
  const service = await startWorkspaceService(directory, undefined, undefined, { assignments: [] }), client = new Client({ name: 'links-stdio', version: '1' });
  const pull = (id: string) => ({ type: 'item.add', id, resourceId: `${id}-r`, pluginId: 'github.pull-request', title: 'Plan switcher', data: { owner: 'fixture', repo: 'billing', number: 42 }, position: { x: 400, y: 0 }, links: [{ agent: true, kind: 'reference' }] });
  try {
    await service.control.dispatch({ commandId: 'setup', expectedRevision: 0, actor: { kind: 'user', id: 'test' }, commands: [session('agent') as never] });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [resolve('packages/mcp/entry.ts')], env: { ACT_DATA_DIR: directory, ACT_NODE_ID: 'agent' }, stderr: 'pipe' }));
    const first = parse(await client.callTool({ name: 'workspace_apply', arguments: { expectedRevision: 1, command: pull('pr') } }));
    assert.equal(first.revision, 2);
    assert.deepEqual(first.links.map((link: any) => [link.sourceId, link.targetId, link.kind]), [['pr', 'agent', 'reference']]);
    assert.equal(first.itemLinks[0].reusedResource, false);
    const second = parse(await client.callTool({ name: 'workspace_apply', arguments: { expectedRevision: 2, command: pull('pr-again') } }));
    assert.deepEqual(second.links, first.links);
    assert.deepEqual(second.itemLinks, [{ nodeId: 'pr', resourceId: 'pr-r', reusedResource: true, links: [{ id: first.links[0].id, existing: false }] }]);
    assert.deepEqual(second.alreadyOnMap, [{ requestedId: 'pr-again', nodeId: 'pr', note: 'Already on the map as pr: no second item was created. Use this nodeId.' }]);
    const saved = await service.store.read();
    assert.deepEqual(saved.links, first.links); assert.deepEqual(saved.nodes.map(node => node.id), ['agent', 'pr']);
  } finally { await client.close(); await service.close(); await rm(directory, { recursive: true, force: true }); }
});
