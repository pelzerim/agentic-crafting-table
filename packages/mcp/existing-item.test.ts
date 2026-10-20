import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { WorkspaceControl } from '../core/control.ts';
import { createServiceMcpServer } from './service-server.ts';

const ID = '00000000-0000-4000-8000-000000000042', URL = `https://claude.ai/code/artifact/${ID}`;
const parse = (result: any) => JSON.parse(result.content[0].text);
const artifact = (id: string, extra: Record<string, unknown> = {}) => ({ type: 'item.add', id, resourceId: `${id}-r`, pluginId: 'claude.artifact', title: id, data: { url: URL, artifactId: ID }, ...extra });

/** An agent in a project, with the artifact card the host added when the agent published. */
async function bridge() {
  const control = new WorkspaceControl();
  const service = { async call(method: string, input?: any) {
    if (method === 'read') return { state: await control.read() };
    if (method === 'apply') return control.dispatch(input);
    throw new Error(`Unexpected service call: ${method}`);
  } };
  const server = createServiceMcpServer(service as never, { agentNodeId: 'agent' }), client = new Client({ name: 'existing-item-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  await control.dispatch({ commandId: 'setup', expectedRevision: 0, actor: { kind: 'user', id: 'test' }, commands: [
    { type: 'project.create', id: 'project', title: 'Billing', position: { x: 0, y: 0 } },
    { type: 'item.add', id: 'agent', resourceId: 'agent-r', pluginId: 'agent.session', title: 'Claude', projectId: 'project', position: { x: 0, y: 0 }, data: { sessionId: 'session-agent', provider: 'claude' } },
  ] });
  await control.dispatch({ commandId: 'published', expectedRevision: 1, actor: { kind: 'provider', id: 'session-agent' }, commands: [
    artifact('host', { projectId: 'project', position: { x: 0, y: 150 } }), { type: 'link.save', link: { id: 'host-link', sourceId: 'agent', targetId: 'host', kind: 'reference', label: 'Artifact' } }] });
  return { control, client, close: async () => { await client.close(); await server.close(); } };
}

test('an agent that adds the artifact the host already placed is told which node it is, and no second node appears', async () => {
  const table = await bridge();
  try {
    const before = await table.control.read();
    const input = { commandId: 'mine', expectedRevision: before.revision, command: artifact('artifact-billing-flow-overview', { title: 'Billing flow overview', links: [{ agent: true, kind: 'reference', newItemIs: 'target' }] }) };
    const result = parse(await table.client.callTool({ name: 'workspace_apply', arguments: input }));
    assert.deepEqual(result.nodes.filter((node: any) => node.resourceId === 'host-r').map((node: any) => node.id), ['host']);
    assert.deepEqual(result.links, before.links, 'the link the host saved is the relationship it asked for');
    assert.deepEqual(result.alreadyOnMap, [{ requestedId: 'artifact-billing-flow-overview', nodeId: 'host', note: 'Already on the map as host: no second item was created. Use this nodeId.' }]);
    assert.deepEqual(result.itemLinks, [{ nodeId: 'host', resourceId: 'host-r', reusedResource: true, links: [{ id: 'host-link', existing: true }] }]);
    const replay = parse(await table.client.callTool({ name: 'workspace_apply', arguments: input }));
    assert.equal(replay.replayed, true); assert.deepEqual(replay.alreadyOnMap, result.alreadyOnMap); assert.deepEqual(replay.itemLinks, result.itemLinks);
  } finally { await table.close(); }
});

test('the apply tool tells agents a published artifact is placed for them', async () => {
  const table = await bridge();
  try {
    const description = (await table.client.listTools()).tools.find(tool => tool.name === 'workspace_apply')!.description!;
    assert.match(description, /artifact you publish is put on the map beside you automatically/); assert.match(description, /alreadyOnMap/);
  } finally { await table.close(); }
});
