import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { WorkspaceControl } from '../core/control.ts';
import { applyAtHead } from '../workspace-service/apply-at-head.ts';
import { layoutFootprints, ITEM_GAP } from '../../src/graph/movement.ts';
import { boundsOf } from '../../src/graph/undermap.ts';
import { createServiceMcpServer } from './service-server.ts';

const parse = (result: any) => JSON.parse(result.content[0].text);
const note = (id: string, extra: Record<string, unknown> = {}) => ({ type: 'item.add', id, resourceId: `${id}-r`, pluginId: 'workspace.note', title: id, data: { text: id }, ...extra });

/** The MCP server over the shared command layer; creation requests are recorded, not run. */
async function bridge(agentNodeId?: string) {
  const control = new WorkspaceControl(), requests: any[] = [];
  const service = { async call(method: string, input?: any) {
    if (method === 'read') return { state: await control.read() };
    if (method === 'apply') return input.expectedRevision === undefined ? applyAtHead(control, input) : control.dispatch(input);
    if (method === 'item.create') { requests.push(input); return {}; }
    throw new Error(`Unexpected service call: ${method}`);
  } };
  const server = createServiceMcpServer(service as never, agentNodeId ? { agentNodeId } : {}), client = new Client({ name: 'placement-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  await control.dispatch({ commandId: 'setup', expectedRevision: 0, actor: { kind: 'user', id: 'test' }, commands: [
    { type: 'project.create', id: 'project', title: 'Billing', position: { x: 0, y: 0 } }, note('agent', { projectId: 'project', position: { x: 500, y: 0 } }), note('pr', { projectId: 'project', position: { x: 500, y: 600 } })] });
  const edges = async (id: string) => { const state = await control.read(); return boundsOf(layoutFootprints(state.nodes, state.resources, control.registry).filter(box => box.id === id)); };
  return { control, client, requests, edges, close: async () => { await client.close(); await server.close(); } };
}

test('workspace_apply places an item without a position beside what it links to, or beside the agent', async () => {
  const table = await bridge('agent');
  try {
    const result = parse(await table.client.callTool({ name: 'workspace_apply', arguments: { commands: [note('finding', { links: [{ otherId: 'pr', kind: 'reference' }] }), note('own', { links: [{ agent: true, kind: 'reference' }] }), note('bare')] } }));
    assert.deepEqual(['finding', 'own', 'bare'].map(id => result.nodes.find((node: any) => node.id === id).projectId), ['project', 'project', 'project']);
    const [finding, own, bare, pr, self] = await Promise.all(['finding', 'own', 'bare', 'pr', 'agent'].map(table.edges));
    assert.equal(finding.left, pr.right + ITEM_GAP); assert.equal(finding.top, pr.top);
    assert.equal(own.left, self.right + ITEM_GAP); assert.equal(own.top, self.top);
    assert.equal(bare.left, self.right + ITEM_GAP); assert.equal(bare.top, own.bottom + ITEM_GAP);
  } finally { await table.close(); }
});

test('workspace_apply creates a project without a position, and an unbound client still has to place its items', async () => {
  const table = await bridge('agent'), unbound = await bridge();
  try {
    const created = await table.client.callTool({ name: 'workspace_apply', arguments: { command: { type: 'project.create', id: 'next', title: 'Next' } } });
    assert.ok(!created.isError); assert.ok(parse(created).nodes.find((node: any) => node.id === 'next').position.x > 500);
    const refused = await unbound.client.callTool({ name: 'workspace_apply', arguments: { command: note('lost') } });
    assert.equal(refused.isError, true); assert.match(JSON.stringify(refused.content), /position is required/);
    assert.ok(!(await unbound.client.callTool({ name: 'workspace_apply', arguments: { command: note('placed', { position: { x: 9000, y: 9000 } }) } })).isError);
  } finally { await table.close(); await unbound.close(); }
});

test('workspace_create_item sends the request for the calling agent, and an agent cannot name another', async () => {
  const table = await bridge('agent'), unbound = await bridge();
  try {
    const request = { requestId: randomUUID(), nodeId: randomUUID(), resourceId: randomUUID(), pluginId: 'terminal.session', title: 'Shell', data: {} };
    await table.client.callTool({ name: 'workspace_create_item', arguments: request });
    await table.client.callTool({ name: 'workspace_create_item', arguments: { ...request, position: { x: 1, y: 2 }, placedBy: 'pr' } });
    await unbound.client.callTool({ name: 'workspace_create_item', arguments: request });
    assert.deepEqual(table.requests, [{ ...request, placedBy: 'agent' }, { ...request, position: { x: 1, y: 2 }, placedBy: 'agent' }]);
    assert.deepEqual(unbound.requests, [{ ...request, placedBy: 'mcp-client' }]);
  } finally { await table.close(); await unbound.close(); }
});

test('the creating tools tell an agent to leave position out', async () => {
  const table = await bridge('agent');
  try {
    const tools = new Map((await table.client.listTools()).tools.map(tool => [tool.name, tool]));
    for (const name of ['workspace_apply', 'workspace_create_item']) {
      assert.match(tools.get(name)!.description!, /[Oo]mit position/, name);
      assert.match(tools.get(name)!.description!, /only when the user asked for a specific place/, name);
    }
    assert.ok(!('placedBy' in (tools.get('workspace_create_item')!.inputSchema.properties ?? {})));
    assert.ok(!(tools.get('workspace_create_item')!.inputSchema.required ?? []).includes('position'));
  } finally { await table.close(); }
});
