import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startWorkspaceService } from '../workspace-service/server.ts';
import { githubFixture } from '../../tests/fixtures/github.ts';

test('production MCP merges for an agent while agents may act for the person, and refuses without reaching GitHub while they may not', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-pr-merge-mcp-')), providers = githubFixture();
  const service = await startWorkspaceService(directory, undefined, undefined, providers);
  const client = new Client({ name: 'merge-agent', version: '1' });
  try {
    await service.control.dispatch({ commandId: 'add', expectedRevision: 0, actor: { kind: 'user', id: 'test' }, commands: [{ type: 'item.add', id: 'pr', resourceId: 'pr-resource', pluginId: 'github.pull-request', title: 'PR', position: { x: 0, y: 0 }, data: { owner: 'fixture', repo: 'billing', number: 42 } }] });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [resolve('packages/mcp/entry.ts')], env: { ACT_DATA_DIR: directory }, stderr: 'pipe' }));
    const agentsActForPerson = (allowed: boolean) => { const settings = service.store.readSettings(); service.store.writeSettings({ expectedRevision: settings.revision, value: { ...settings.value, agentsActForPerson: allowed } }); };
    const run = (args: Record<string, unknown>) => client.callTool({ name: 'workspace_run', arguments: { action: 'resource.action', nodeId: 'pr', arguments: args } });
    const options = await run({ actionId: 'pr.merge.options' });
    assert.notEqual(options.isError, true, JSON.stringify(options));
    const context = JSON.parse((options.content as { text: string }[])[0].text).context;
    agentsActForPerson(false);
    for (const value of ['SQUASH', 'QUEUE']) {
      const refused = await run({ actionId: 'pr.merge', input: { ...context, value, requestId: crypto.randomUUID() } });
      assert.equal(refused.isError, true); assert.match((refused.content as { text: string }[])[0].text, /“Agents may act for you” is off in Settings/);
    }
    assert.equal(providers.merges.length, 0); assert.equal(providers.pull.merged, false);
    agentsActForPerson(true);
    const merged = await run({ actionId: 'pr.merge', input: { ...context, value: 'SQUASH', requestId: crypto.randomUUID() } });
    assert.notEqual(merged.isError, true, JSON.stringify(merged));
    assert.equal(providers.merges.length, 1); assert.equal(providers.pull.merged, true);
  } finally { await client.close(); await service.close(); await rm(directory, { recursive: true, force: true }); }
});
