// Opt-in read-only live gate. Only a disposable local table is mutated.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startWorkspaceService } from '../packages/workspace-service/server.ts';
import { connectWorkspace } from '../packages/workspace-service/client.ts';
if (process.env.ACT_LIVE_GITHUB !== '1') throw new Error('Set ACT_LIVE_GITHUB=1 to read real assigned PRs.');
const directory = await mkdtemp(join(tmpdir(), 'act-live-assigned-'));
let service, client;
try {
  service = await startWorkspaceService(directory); client = await connectWorkspace(directory);
  const accounts = await client.call('connections.accounts', { providerId: 'github' });
  const account = accounts.find(account => account.active && account.available); assert.ok(account, 'No active GitHub account');
  const settings = await client.call('settings.read');
  await client.call('settings.write', { expectedRevision: settings.revision, value: { ...settings.value, connections: [{ id: 'live-assignment', providerId: 'github', account: account.id, enabled: true, isDefault: true }] } });
  const status = await client.call('connections.refresh'); assert.ok(!status[0]?.error, status[0]?.error);
  const before = await client.call('read'), assigned = before.state.nodes.filter(node => node.attentionSources?.['github.assignment'] === 'assigned');
  let acknowledged = false;
  if (assigned.length) {
    const nodeId = assigned[0].id;
    const detail = await client.call('runtime.run', { action: 'resource.read', nodeId });
    assert.equal(detail.connection, 'connected'); assert.ok(detail.detail.pull); assert.ok(detail.attentionReceipt);
    const response = await client.call('runtime.run', { action: 'resource.viewed', nodeId, arguments: { receipt: detail.attentionReceipt } }); assert.equal(response.acknowledged, true); acknowledged = true;
    await client.call('connections.refresh');
    assert.equal((await client.call('read')).state.nodes.find(node => node.id === nodeId).attentionSources?.['github.assignment'], undefined);
    client.close(); await service.close(); service = await startWorkspaceService(directory); client = await connectWorkspace(directory);
    assert.equal((await client.call('read')).state.nodes.find(node => node.id === nodeId).attentionSources?.['github.assignment'], undefined);
  }
  console.log(JSON.stringify({ liveDiscovery: true, assignedPullRequests: assigned.length, liveDetailAcknowledged: acknowledged, reopenPreservesViewed: acknowledged, providerWrites: 0 }));
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { client?.close(); await service?.close(); await rm(directory, { recursive: true, force: true }); }
