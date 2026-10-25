import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startWorkspaceService } from '../workspace-service/server.ts';

test('workspace_read lists note badges with their words, paper and the items they label; display pins a longer one', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-badge-mcp-'));
  const service = await startWorkspaceService(directory, undefined, undefined, { assignments: [] });
  const client = new Client({ name: 'badge-agent', version: '1' });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [resolve('packages/mcp/entry.ts')], env: { ACT_DATA_DIR: directory, ACT_NODE_ID: 'agent' }, stderr: 'pipe' }));
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args });
      assert.notEqual(result.isError, true, JSON.stringify(result));
      return JSON.parse((result.content as { text: string }[])[0].text);
    };
    const apply = async (command: Record<string, unknown>) => call('workspace_apply', { expectedRevision: (await service.store.read()).revision, command });
    await apply({ type: 'item.add', id: 'pr', resourceId: 'pr-r', pluginId: 'github.pull-request', title: 'Plan switcher', data: { owner: 'acme', repo: 'app', number: 48 }, position: { x: 0, y: 0 } });
    await apply({ type: 'item.add', id: 'ticket', resourceId: 'ticket-r', pluginId: 'linear.ticket', connectionId: 'linear-fixture', title: 'BIL-1', data: { issueId: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001' }, position: { x: 400, y: 0 } });
    await apply({ type: 'item.add', id: 's2', resourceId: 's2-r', pluginId: 'workspace.note', title: 'S2', data: { text: 'S2', paper: 'sky' }, position: { x: 200, y: 300 },
      links: [{ otherId: 'pr', kind: 'reference', newItemIs: 'source' }, { otherId: 'ticket', kind: 'reference', newItemIs: 'source' }] });
    let read = await call('workspace_read', {});
    assert.deepEqual(read.badges, [{ noteId: 's2', text: 'S2', paper: 'sky', itemIds: ['pr', 'ticket'] }]);
    await apply({ type: 'item.update', id: 's2', data: { text: 'customer escalation', display: 'badge' } });
    read = await call('workspace_read', {});
    assert.deepEqual(read.badges.map((badge: any) => badge.text), ['customer escalation']);
    await apply({ type: 'item.update', id: 's2', data: { text: 'customer escalation' } });
    assert.deepEqual((await call('workspace_read', {})).badges, []);
    const tool = (await client.listTools()).tools.find(entry => entry.name === 'workspace_read')!;
    assert.match(tool.description!, /badges/);
  } finally { await client.close(); await service.close(); await rm(directory, { recursive: true, force: true }); }
});
