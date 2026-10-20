import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startWorkspaceService } from '../workspace-service/server.ts';
import { githubFixture } from '../../tests/fixtures/github.ts';

test('production MCP reads pull request state options but refuses the human-only close and draft toggle without reaching GitHub', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-pr-state-mcp-')), providers = githubFixture();
  const service = await startWorkspaceService(directory, undefined, undefined, providers);
  const client = new Client({ name: 'pr-state-agent', version: '1' });
  try {
    await service.control.dispatch({ commandId: 'add', expectedRevision: 0, actor: { kind: 'user', id: 'test' }, commands: [{ type: 'item.add', id: 'pr', resourceId: 'pr-resource', pluginId: 'github.pull-request', title: 'PR', position: { x: 0, y: 0 }, data: { owner: 'fixture', repo: 'billing', number: 42 } }] });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [resolve('packages/mcp/entry.ts')], env: { ACT_DATA_DIR: directory }, stderr: 'pipe' }));
    const run = (args: Record<string, unknown>) => client.callTool({ name: 'workspace_run', arguments: { action: 'resource.action', nodeId: 'pr', arguments: args } });
    const options = await run({ actionId: 'pr.state.options' });
    assert.notEqual(options.isError, true, JSON.stringify(options));
    const choices = JSON.parse((options.content as { text: string }[])[0].text);
    assert.deepEqual(choices.options.map((option: { id: string }) => option.id), ['draft', 'close']);
    for (const input of [{ value: 'close', comment: 'Closing from an agent' }, { value: 'draft' }]) {
      const refused = await run({ actionId: 'pr.state', input: { ...choices.context, ...input, requestId: crypto.randomUUID() } });
      assert.equal(refused.isError, true); assert.match((refused.content as { text: string }[])[0].text, /needs a person to confirm it in the app/);
    }
    assert.deepEqual(providers.writes, []); assert.equal(providers.pull.state, 'open'); assert.equal(providers.pull.draft, false);
  } finally { await client.close(); await service.close(); await rm(directory, { recursive: true, force: true }); }
});
