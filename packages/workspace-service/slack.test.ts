import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startWorkspaceService } from './server.ts';
import { connectWorkspace } from './client.ts';
import { slackProviders, slackRoot, slackInput, slackUrl } from '../../tests/fixtures/slack.ts';
import type { ResourceSnapshot, SkillContext } from '../../src/resource-plugins/types.ts';

test('Slack imports reconcile aliases, retain selected/root identity and preserve explicit message versus thread context across restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-slack-')), providers = slackProviders();
  let service = await startWorkspaceService(directory, undefined, undefined, providers), client = await connectWorkspace(directory);
  try {
    await service.control.dispatch({ commandId: 'legacy', expectedRevision: 0, actor: { kind: 'agent', id: 'fixture' }, commands: ['one', 'two'].map((id, i) => ({ type: 'item.add', id, resourceId: id + '-r', pluginId: 'slack.message', title: 'Old message', position: { x: 400 * i, y: 300 }, data: slackInput })) });
    const before = await service.control.read();
    const request = (url: string) => ({ requestId: randomUUID(), nodeId: randomUUID(), resourceId: randomUUID(), pluginId: 'slack.message', expectedRevision: before.revision, title: 'Lookup', position: { x: 0, y: 0 }, data: { url } });
    const original = request(slackUrl), result = await client.call('item.create', original), state = await service.control.read(); assert.equal(state.resources.length, 1); assert.equal(state.nodes.length, 2); assert.deepEqual(state.resources[0].data, slackInput); assert.equal(state.resources[0].connectionId, 'slack-fixture');
    for (const old of before.nodes) assert.deepEqual(state.nodes.find(node => node.id === old.id)?.position, old.position);
    const context = (nodeId: string) => client.call<SkillContext>('runtime.run', { nodeId, action: 'resource.context', arguments: {} });
    const whole = await context('one'); assert.match(whole.content, /How should we handle/); assert.match(whole.content, /Sam \(U67890\)/); assert.equal(whole.sourceUrl, slackUrl);
    const single = await client.call<{ nodeId: string }>('item.create', request(slackUrl.split('?')[0])); const singleResource = (await service.control.read()).resources.find(record => record.data.scope === 'message')!; assert.equal(singleResource.data.threadTs, slackRoot);
    const selected = await context(single.nodeId); assert.match(selected.content, /Keep the current billing cycle/); assert.doesNotMatch(selected.content, /How should we handle/);
    providers.pages[1].messages[0].text = 'x'.repeat(39_000); const bounded = await context(single.nodeId); assert.ok(bounded.content.length <= 32_000); assert.match(bounded.content, /Context excerpt/);
    client.close(); await service.close(); service = await startWorkspaceService(directory, undefined, undefined, providers); client = await connectWorkspace(directory);
    const callCount = providers.calls.length; assert.deepEqual(await client.call('item.create', original), result);
    const cached = await client.call<ResourceSnapshot>('runtime.run', { nodeId: 'one', action: 'resource.read', arguments: {} }); assert.equal(providers.calls.length, callCount); assert.equal(cached.detail?.threadTs, slackRoot);
    providers.before(method => { if (method === 'conversations.replies') throw new Error('Slack message is unavailable'); });
    const stale = await client.call<ResourceSnapshot>('runtime.run', { nodeId: 'one', action: 'resource.read', arguments: { refresh: true } }); assert.equal(stale.stale, true); assert.match(stale.error!, /unavailable/); assert.equal(stale.title, cached.title);
    await assert.rejects(context('one'), /unavailable/);
    providers.accounts[0].enabled = false; await assert.rejects(context('one'), /Connect Slack/);
    assert.ok(providers.calls.every(call => ['auth.test', 'conversations.info', 'conversations.replies', 'users.info'].includes(call.method)));
  } finally { client.close(); await service.close(); await rm(directory, { recursive: true, force: true }); }
});
