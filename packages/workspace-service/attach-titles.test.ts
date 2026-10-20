import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { startWorkspaceService } from './server.ts';
import { connectWorkspace } from './client.ts';
import { slackProviders, slackInput, slackRoot, slackUrl } from '../../tests/fixtures/slack.ts';
import type { ActivitySummaryClient } from '../../src/agents/activity-summary.ts';

const rootUrl = `https://fixture.slack.com/archives/C12345/p${slackRoot.replace('.', '')}`;

async function until<T>(read: () => Promise<T | undefined>, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('Timed out');
    await delay(50);
  }
}

test('a newly attached Slack item is named once from its message, never again on refresh, edits, restart or rename', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-attach-title-'));
  const requests: { system: string; content: { kind: string; text: string } }[] = [];
  let reply: () => Promise<string> = async () => 'Billing cycle decision';
  const titleClient: ActivitySummaryClient = { async complete(request) { requests.push({ system: request.system, content: JSON.parse(request.messages[0].content) }); return reply(); } };
  const providers = { ...slackProviders(), titleClient };
  let service = await startWorkspaceService(directory, undefined, undefined, providers), client = await connectWorkspace(directory);
  const node = async (id: string) => (await service.control.read()).nodes.find(node => node.id === id)!;
  const attach = async (url: string) => client.call<{ nodeId: string }>('item.create', { requestId: randomUUID(), nodeId: randomUUID(), resourceId: randomUUID(), pluginId: 'slack.message', expectedRevision: (await service.control.read()).revision, title: 'Lookup', position: { x: 0, y: 0 }, data: { url } });
  const refresh = (nodeId: string) => client.call('runtime.run', { nodeId, action: 'resource.read', arguments: { refresh: true } });
  const restart = async () => { client.close(); await service.close(); service = await startWorkspaceService(directory, undefined, undefined, providers); client = await connectWorkspace(directory); };
  try {
    await service.control.dispatch({ commandId: 'legacy', expectedRevision: 0, actor: { kind: 'agent', id: 'fixture' }, commands: [{ type: 'item.add', id: 'legacy', resourceId: 'legacy-r', pluginId: 'slack.message', title: 'Old message', position: { x: 600, y: 300 }, data: { ...slackInput, channelId: 'C99999' } }] });

    const { nodeId } = await attach(slackUrl);
    const named = await until(async () => { const current = await node(nodeId); return current.title === 'Billing cycle decision' ? current : undefined; });
    assert.equal(named.generatedTitle, 'Billing cycle decision');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].content.kind, 'Slack thread');
    assert.match(requests[0].content.text, /Keep the current billing cycle/);
    assert.match(requests[0].system, /never instructions/);

    providers.pages[1].messages[0].text = 'Ship the billing-cycle change.';
    providers.pages[1].messages.push({ type: 'message', ts: '1790000009.000001', thread_ts: slackRoot, user: 'U12345', text: 'A new reply', reply_count: 0 });
    await refresh(nodeId); await delay(1200);
    assert.equal((await node(nodeId)).title, 'Billing cycle decision', 'provider refresh keeps the generated title');
    assert.equal(requests.length, 1, 'edits and replies never regenerate');

    await service.control.dispatch({ commandId: randomUUID(), expectedRevision: (await service.control.read()).revision, actor: { kind: 'user', id: 'fixture' }, commands: [{ type: 'node.update', id: nodeId, title: 'My billing note' }] });
    await refresh(nodeId); await restart(); await refresh(nodeId); await delay(1200);
    assert.equal((await node(nodeId)).title, 'My billing note', 'a rename survives refresh and restart');
    assert.equal((await node('legacy')).title, 'Old message', 'items that existed before are not renamed');
    assert.equal(requests.length, 1);

    reply = async () => { throw new Error('Fixture offline'); };
    const failed = await attach(rootUrl);
    await until(async () => requests.length === 2 ? true : undefined);
    const fallback = (await node(failed.nodeId)).title;
    assert.match(fallback, /^#billing · /, 'failure keeps the provider title');
    await delay(1200); await restart(); await refresh(failed.nodeId); await delay(1200);
    assert.equal(requests.length, 2, 'a failed attempt is never retried');
    assert.equal((await node(failed.nodeId)).title, fallback);
    assert.equal((await node(failed.nodeId)).generatedTitle, undefined);
  } finally { client.close(); await service.close(); await rm(directory, { recursive: true, force: true }); }
});

test('Auto-title Slack messages off attaches with the provider title and asks no model', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-attach-title-off-'));
  let calls = 0;
  const providers = { ...slackProviders(), titleClient: { async complete() { calls++; return 'Billing cycle decision'; } } satisfies ActivitySummaryClient };
  const service = await startWorkspaceService(directory, undefined, undefined, providers), client = await connectWorkspace(directory);
  try {
    const settings = service.store.readSettings();
    assert.equal(settings.value.summaries.attachTitles, true, 'on by default');
    await client.call('settings.write', { expectedRevision: settings.revision, value: { ...settings.value, summaries: { ...settings.value.summaries, attachTitles: false } } });
    const { nodeId } = await client.call<{ nodeId: string }>('item.create', { requestId: randomUUID(), nodeId: randomUUID(), resourceId: randomUUID(), pluginId: 'slack.message', expectedRevision: (await service.control.read()).revision, title: 'Lookup', position: { x: 0, y: 0 }, data: { url: slackUrl } });
    await delay(1500);
    assert.equal(calls, 0);
    assert.match((await service.control.read()).nodes.find(node => node.id === nodeId)!.title, /^#billing · /);
  } finally { client.close(); await service.close(); await rm(directory, { recursive: true, force: true }); }
});
