import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startWorkspaceService } from '../workspace-service/server.ts';
import { plotProject } from '../../tests/fixtures/plot-project.ts';

test('the map read lists plots read-only; agents cannot rename, hide, name or color them', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-plots-mcp-'));
  const service = await startWorkspaceService(directory, undefined, undefined, { assignments: [] });
  const client = new Client({ name: 'plots-agent', version: '1' });
  try {
    await service.store.update(() => plotProject());
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [resolve('packages/mcp/entry.ts')], env: { ACT_DATA_DIR: directory }, stderr: 'pipe' }));
    const read = JSON.parse((await client.callTool({ name: 'workspace_read', arguments: {} }) as { content: { text: string }[] }).content[0].text);
    assert.ok(Array.isArray(read.nodes));
    assert.deepEqual(read.plots.map((plot: { name: string; memberIds: string[]; generated: boolean; projectId: string }) => [plot.name, plot.memberIds.length, plot.generated, plot.projectId]),
      [['Billing · 4 items', 4, false, 'photos'], ['Thumbnail · 4 items', 4, false, 'photos'], ['Upload · 3 items', 3, false, 'photos']]);
    assert.deepEqual(Object.keys(read.plots[0]).sort(), ['generated', 'id', 'memberIds', 'name', 'projectId']);
    for (const operation of ['rename', 'hide', 'auto', 'color', 'project']) {
      const refused = await client.callTool({ name: 'workspace_run', arguments: { action: 'plot', nodeId: 'photos', arguments: { operation, plotId: read.plots[0].id, name: 'Agent name', hidden: true, shown: false } } });
      assert.equal(refused.isError, true); assert.match(JSON.stringify(refused), /needs a person/);
    }
  } finally { await client.close(); await service.close(); await rm(directory, { recursive: true, force: true }); }
});
