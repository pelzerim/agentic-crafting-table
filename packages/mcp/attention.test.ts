import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startWorkspaceService } from '../workspace-service/server.ts';
import { attentionItems, attentionReceipt } from '../../src/graph/attention.ts';

test('MCP acknowledges observed attention durably without answering input; a later completion survives an old receipt', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-attention-mcp-'));
  let service = await startWorkspaceService(directory, undefined, undefined, { assignments: [] });
  const client = new Client({ name: 'attention-fixture', version: '1' });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [resolve('packages/mcp/entry.ts')], env: { ACT_DATA_DIR: directory }, stderr: 'pipe' }));
    const apply = async (command: Record<string, unknown>) => {
      const result = await client.callTool({ name: 'workspace_apply', arguments: { expectedRevision: (await service.store.read()).revision, command } });
      assert.notEqual(result.isError, true, JSON.stringify(result));
      return service.store.read();
    };
    await apply({ type: 'item.add', id: 'agent', resourceId: 'agent-resource', pluginId: 'agent.session', title: 'Fixture only', data: { sessionId: 'not-running', provider: 'claude' }, position: { x: 100, y: 100 } });
    let state = await apply({ type: 'node.update', id: 'agent', attention: 'input', attentionNote: 'Agent needs a decision' });
    assert.deepEqual(attentionItems(state.nodes)[0].notes, ['Agent needs a decision']);
    const receipt = attentionReceipt(state.nodes, 'agent');
    state = await apply({ type: 'attention.acknowledge', ...receipt });
    assert.equal(attentionItems(state.nodes).length, 0); assert.equal(state.nodes[0].attention, 'input');
    await client.close(); await service.close();
    service = await startWorkspaceService(directory, undefined, undefined, { assignments: [] });
    state = await service.store.read();
    assert.equal(attentionItems(state.nodes).length, 0); assert.equal(state.nodes[0].attention, 'input');
    await service.control.apply({ type: 'attention.set', id: 'agent', source: 'completion', reason: 'finished', eventId: 'later-turn' }, state.revision);
    state = await service.control.apply({ type: 'attention.acknowledge', ...receipt }, (await service.store.read()).revision);
    assert.equal(attentionItems(state.nodes).length, 1);
  } finally { await client.close(); await service.close(); await rm(directory, { recursive: true, force: true }); }
});
