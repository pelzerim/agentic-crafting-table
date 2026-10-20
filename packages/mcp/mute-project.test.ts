import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startWorkspaceService } from '../workspace-service/server.ts';
import { humanOnlyMessage } from '../../src/resource-plugins/host.ts';

test('a muted project survives a restart and is readable over MCP, but an agent can neither mute nor unmute', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-mute-mcp-'));
  let service = await startWorkspaceService(directory, undefined, undefined, { assignments: [] });
  const client = new Client({ name: 'mute-fixture', version: '1' });
  const user = async (command: Record<string, unknown>) => service.control.dispatch({ commandId: crypto.randomUUID(), expectedRevision: (await service.store.read()).revision, actor: { kind: 'user', id: 'desktop' }, commands: [command as any] });
  const agent = async (command: Record<string, unknown>) => client.callTool({ name: 'workspace_apply', arguments: { expectedRevision: (await service.store.read()).revision, command } });
  const read = async () => JSON.parse(((await client.callTool({ name: 'workspace_read', arguments: {} })).content as { text: string }[])[0].text) as { nodes: { id: string; mutedAt?: string }[] };
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [resolve('packages/mcp/entry.ts')], env: { ACT_DATA_DIR: directory }, stderr: 'pipe' }));
    await user({ type: 'project.create', id: 'p', title: 'Billing', position: { x: 0, y: 0 } });
    const refused = await agent({ type: 'project.mute', id: 'p', muted: true });
    assert.equal(refused.isError, true); assert.match(JSON.stringify(refused.content), new RegExp(humanOnlyMessage));
    assert.equal((await service.store.read()).nodes[0].mutedAt, undefined);
    await user({ type: 'project.mute', id: 'p', muted: true });
    const stamped = (await service.store.read()).nodes[0].mutedAt;
    assert.ok(stamped);
    assert.equal((await read()).nodes[0].mutedAt, stamped, 'agents can read the state');
    const unmute = await agent({ type: 'project.mute', id: 'p', muted: false });
    assert.equal(unmute.isError, true);
    // Agents keep writing into a muted project as before.
    const added = await agent({ type: 'item.add', id: 'note', resourceId: 'note-r', pluginId: 'workspace.todo', title: 'Follow up', data: {}, projectId: 'p', position: { x: 0, y: 0 } });
    assert.notEqual(added.isError, true, JSON.stringify(added));
    await client.close(); await service.close();
    service = await startWorkspaceService(directory, undefined, undefined, { assignments: [] });
    assert.equal((await service.store.read()).nodes.find(node => node.id === 'p')?.mutedAt, stamped, 'persisted across restart');
  } finally { await client.close(); await service.close(); await rm(directory, { recursive: true, force: true }); }
});
