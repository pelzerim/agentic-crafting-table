import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startWorkspaceService } from '../workspace-service/server.ts';
import { rolloutFixture } from '../../tests/fixtures/rollout.ts';

test('production MCP refuses human-only rollout approval without reaching GitHub', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-rollout-mcp-')), providers = rolloutFixture();
  providers.run.status = 'waiting'; providers.gates = [{ environment: { id: 1, name: 'production' }, wait_timer: 0, current_user_can_approve: true, reviewers: [{ type: 'Team' }] }];
  const service = await startWorkspaceService(directory, undefined, undefined, providers);
  const client = new Client({ name: 'rollout-agent', version: '1' });
  try {
    await service.control.dispatch({ commandId: 'add', expectedRevision: 0, actor: { kind: 'user', id: 'test' }, commands: [{ type: 'item.add', id: 'rollout', resourceId: 'rollout-resource', pluginId: 'github.rollout', title: 'Rollout', position: { x: 0, y: 0 }, data: { owner: 'fixture', repo: 'web', runId: 101 } }] });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [resolve('packages/mcp/entry.ts')], env: { ACT_DATA_DIR: directory }, stderr: 'pipe' }));
    const run = (args: Record<string, unknown>) => client.callTool({ name: 'workspace_run', arguments: { action: 'resource.action', nodeId: 'rollout', arguments: args } });
    const options = await run({ actionId: 'rollout.approval.options' });
    assert.notEqual(options.isError, true, JSON.stringify(options));
    const context = JSON.parse((options.content as { text: string }[])[0].text).context;
    const refused = await run({ actionId: 'rollout.approve', input: { ...context, value: 'approve', requestId: crypto.randomUUID() } });
    assert.equal(refused.isError, true); assert.match((refused.content as { text: string }[])[0].text, /needs a person to confirm it in the app/);
    assert.equal(providers.approvals.length, 0);
  } finally { await client.close(); await service.close(); await rm(directory, { recursive: true, force: true }); }
});
