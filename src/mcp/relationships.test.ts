import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { WorkspaceControl } from './control.ts';
import { createServer } from './server.ts';
import { registryWithSinglePartner, singlePartner } from '../../tests/fixtures/single-partner.ts';

test('agents can register a PR and keep the graph in sync, while one-partner limits reject writes atomically', async () => {
  const control = new WorkspaceControl(undefined, registryWithSinglePartner());
  const server = createServer(control);
  const client = new Client({ name: 'table-sync-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    return JSON.parse((result.content as { text: string }[])[0].text);
  };
  const apply = async (command: Record<string, unknown>) => call('workspace_apply', {
    expectedRevision: (await call('workspace_read')).revision, command,
  });
  const position = { x: 20, y: 40 };
  try {
    await server.connect(serverTransport); await client.connect(clientTransport);
    await apply({ type: 'project.create', id: 'project', title: 'Billing', position });
    for (const id of ['agent', 'other']) await apply({ type: 'item.add', id, resourceId: `r-${id}`, pluginId: 'agent.session', title: id, data: { sessionId: `session-${id}`, provider: 'claude' }, projectId: 'project', position });
    await apply({ type: 'item.add', id: 'device', resourceId: 'r-device', pluginId: singlePartner.id, title: 'billing-dev', data: { deviceId: 'billing-dev' }, projectId: 'project', position });
    await apply({ type: 'link.save', link: { id: 'host', sourceId: 'device', targetId: 'agent', kind: 'context' } });
    const before = await call('workspace_read');
    const rejected = await client.callTool({ name: 'workspace_apply', arguments: {
      expectedRevision: before.revision,
      command: { type: 'link.save', link: { id: 'extra', sourceId: 'other', targetId: 'device', kind: 'reference' } },
    } });
    assert.equal(rejected.isError, true);
    assert.match(JSON.stringify(rejected.content), /only one item/);
    assert.deepEqual(await call('workspace_read'), before);

    const discovery = await call('workspace_plugins', { input: 'https://github.com/acme/app/pull/48' });
    assert.equal(discovery.plugins.find((p: any) => p.id === singlePartner.id).relationships.cardinality, 'one');
    const pr = discovery.candidates.find((p: any) => p.pluginId === 'github.pull-request');
    await apply({ type: 'item.add', id: 'pr', resourceId: 'r-pr', pluginId: pr.pluginId, title: pr.title, data: pr.data, projectId: 'project', position: { x: 300, y: 40 } });
    await apply({ type: 'link.save', link: { id: 'result', sourceId: 'agent', targetId: 'pr', kind: 'reference', label: 'Created PR' } });
    await apply({ type: 'node.update', id: 'agent', summary: 'Opened PR #48', activity: 'complete', attention: 'none' });
    let state = await call('workspace_read');
    assert.equal(state.nodes.find((n: any) => n.id === 'pr').projectId, 'project');
    assert.equal(state.links.length, 2); // One agent can have both a device and a PR.
    assert.equal(state.nodes.find((n: any) => n.id === 'agent').summary, 'Opened PR #48');

    await apply({ type: 'link.remove', id: 'host' });
    await apply({ type: 'link.save', link: { id: 'host', sourceId: 'device', targetId: 'other', kind: 'context' } });
    state = await call('workspace_read');
    assert.equal(state.links.find((l: any) => l.id === 'host').targetId, 'other');
  } finally { await client.close(); await server.close(); }
});

test('agents create and read blocking links; cycles and unknown kinds are refused atomically', async () => {
  const control = new WorkspaceControl(), server = createServer(control), client = new Client({ name: 'blocking-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const call = async (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });
  const read = async () => JSON.parse(((await call('workspace_read')).content as { text: string }[])[0].text);
  const apply = async (command: Record<string, unknown>) => call('workspace_apply', { expectedRevision: (await read()).revision, command });
  try {
    await server.connect(serverTransport); await client.connect(clientTransport);
    for (const [id, number] of [['first', 64], ['second', 65]] as const) {
      assert.notEqual((await apply({ type: 'item.add', id, resourceId: `r-${id}`, pluginId: 'github.pull-request', title: `PR ${number}`, data: { owner: 'acme', repo: 'api', number }, position: { x: 0, y: 0 } })).isError, true);
    }
    assert.notEqual((await apply({ type: 'link.save', link: { id: 'order', sourceId: 'first', targetId: 'second', kind: 'blocks' } })).isError, true);
    assert.deepEqual((await read()).links, [{ id: 'order', sourceId: 'first', targetId: 'second', kind: 'blocks', label: '' }]);
    const before = await read();
    const cycle = await apply({ type: 'link.save', link: { id: 'back', sourceId: 'second', targetId: 'first', kind: 'blocks' } });
    assert.equal(cycle.isError, true); assert.match(JSON.stringify(cycle.content), /PR 64 already blocks PR 65\. This would create a blocking cycle/);
    const unknown = await apply({ type: 'link.save', link: { id: 'other', sourceId: 'second', targetId: 'first', kind: 'depends' } });
    assert.equal(unknown.isError, true);
    assert.deepEqual(await read(), before);
  } finally { await client.close(); await server.close(); }
});
