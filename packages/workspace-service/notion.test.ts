import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startWorkspaceService } from './server.ts';
import { connectWorkspace } from './client.ts';
import { mkdtempSync, rmSync as removeSync } from 'node:fs';
import { notionProviders, notionPageId, notionComment, notionBlockId, notionBotId } from '../../tests/fixtures/notion.ts';
import type { JsonObject, ResourceSnapshot, SkillContext } from '../../src/resource-plugins/types.ts';
import { ResourceCoordinator } from './resources.ts';
import { SqliteStore } from './sqlite-store.ts';
import { WorkspaceControl } from '../core/control.ts';
import type { WorkspaceState } from '../core/control.ts';

const notionMeId = '88888888888888888888888888888888';

test('Notion verified URL attachment reconciles old aliases, supplies context and keeps its binding/cache across restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-notion-')), providers = notionProviders();
  let service = await startWorkspaceService(directory, undefined, undefined, providers), client = await connectWorkspace(directory);
  try {
    await service.control.dispatch({ commandId: 'legacy', expectedRevision: 0, actor: { kind: 'agent', id: 'fixture' }, commands: ['one', 'two'].map((id, i) => ({ type: 'item.add', id, resourceId: id + '-r', pluginId: 'notion.page', title: 'Old page', position: { x: 400 * i, y: 300 }, data: { pageId: notionPageId } })) });
    const before = await service.control.read(); assert.equal(before.resources.length, 2);
    const request = { requestId: randomUUID(), nodeId: randomUUID(), resourceId: randomUUID(), pluginId: 'notion.page', expectedRevision: before.revision, title: 'Provider title', position: { x: 0, y: 0 }, data: { url: `https://www.notion.so/billing-${notionPageId}` } };
    const result = await client.call('item.create', request), state = await service.control.read(); assert.equal(state.resources.length, 1); assert.equal(state.nodes.length, 2);
    for (const old of before.nodes) { const node = state.nodes.find(node => node.id === old.id)!; assert.deepEqual(node.position, old.position); assert.equal(node.title, 'Billing experience'); }
    assert.equal(state.resources[0].connectionId, 'notion-fixture');
    const context = await client.call<SkillContext>('runtime.run', { nodeId: 'one', action: 'resource.context', arguments: {} }); assert.match(context.content, /Keep the current cycle/); assert.equal(context.sourceUrl, `https://www.notion.so/${notionPageId}`);
    client.close(); await service.close(); service = await startWorkspaceService(directory, undefined, undefined, providers); client = await connectWorkspace(directory);
    assert.deepEqual(await client.call('item.create', request), result); const calls = providers.calls.length;
    const cached = await client.call<ResourceSnapshot>('runtime.run', { nodeId: 'one', action: 'resource.read', arguments: {} }); assert.equal(cached.title, 'Billing experience'); assert.equal(providers.calls.length, calls);
    providers.before(() => { throw new Error('Page access removed'); });
    const stale = await client.call<ResourceSnapshot>('runtime.run', { nodeId: 'one', action: 'resource.read', arguments: { refresh: true } }); assert.equal(stale.stale, true); assert.match(stale.error!, /access removed/); assert.equal(stale.title, 'Billing experience');
    providers.accounts[0].enabled = false; await assert.rejects(client.call('runtime.run', { nodeId: 'one', action: 'resource.context', arguments: {} }), /Connect Notion/);
  } finally { client.close(); await service.close(); await rm(directory, { recursive: true, force: true }); }
});

type Node = WorkspaceState['nodes'][number];
interface CommentsInput { providers: ReturnType<typeof notionProviders>; coordinator: ResourceCoordinator; nodeId: string; advance(ms: number): void; poll(): Promise<void>; restart(): Promise<void>; node(): Promise<Node> }
async function comments(run: (input: CommentsInput) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), 'craft-notion-comments-')), file = join(directory, 'workspace.sqlite'), providers = notionProviders();
  let now = Date.parse('2026-09-26T12:00:30.000Z'), store = new SqliteStore(file), control = new WorkspaceControl(store);
  const clock = () => now, make = () => new ResourceCoordinator(store, control, providers.host(control.registry, clock), providers.connections, async () => {}, clock);
  let coordinator = make();
  providers.comments[notionPageId] = [notionComment('a', '2026-09-26T11:00:00.000Z')];
  const { nodeId } = await coordinator.attach({ requestId: randomUUID(), nodeId: randomUUID(), resourceId: randomUUID(), expectedRevision: 0, pluginId: 'notion.page', title: 'Page', position: { x: 0, y: 0 }, data: { url: `https://app.notion.com/p/acme/Billing-${notionPageId}` } }) as { nodeId: string };
  const input: CommentsInput = { providers, nodeId, get coordinator() { return coordinator; },
    advance(ms) { now += ms; }, async poll() { now += 11 * 60_000; await coordinator.poll(); },
    async restart() { await coordinator.close(); store.close(); store = new SqliteStore(file); control = new WorkspaceControl(store); coordinator = make(); },
    async node() { return (await control.read()).nodes.find(node => node.id === nodeId)!; } };
  try { await run(input); } finally { await coordinator.close(); store.close(); removeSync(directory, { recursive: true, force: true }); }
}
const unread = (node: Node) => node.indicators?.find(cue => cue.id === 'comments')?.label;

test('Notion comments present at attach are read; new ones by others are counted, notify once per batch and include inline discussions', () => comments(async input => {
  assert.equal(unread(await input.node()), undefined, 'existing comments are not unread');
  await input.poll(); assert.equal((await input.node()).attentionSources?.['notion.comments'], undefined);
  input.providers.comments[notionPageId].push(notionComment('b', '2026-09-26T12:30:00.000Z'));
  await input.poll();
  let node = await input.node();
  assert.equal(unread(node), '1 unread comment'); assert.equal(node.attentionSources?.['notion.comments'], 'comment'); assert.equal(node.attentionNotes?.['notion.comments'], 'New comment');
  const version = node.attentionVersion ?? 0;
  await input.poll(); assert.equal((await input.node()).attentionVersion, version, 'an unchanged poll does not notify again');
  input.providers.comments[notionBlockId] = [notionComment('c', '2026-09-26T12:40:00.000Z', { parent: notionBlockId }), notionComment('d', '2026-09-26T12:41:00.000Z', { parent: notionBlockId })];
  await input.poll();
  node = await input.node();
  assert.equal(unread(node), '3 unread comments'); assert.equal(node.attentionNotes?.['notion.comments'], '2 new comments'); assert.ok((node.attentionVersion ?? 0) > version);
}));

test('my Notion comments never count: the integration itself and the configured user ID', () => comments(async input => {
  input.providers.comments[notionPageId].push(notionComment('b', '2026-09-26T12:30:00.000Z', { author: notionBotId }), notionComment('c', '2026-09-26T12:31:00.000Z', { author: notionMeId }));
  input.providers.me.push(notionMeId);
  await input.poll();
  const node = await input.node();
  assert.equal(unread(node), undefined); assert.equal(node.attentionSources?.['notion.comments'], undefined);
  input.providers.me.length = 0; await input.coordinator.refreshPresentation(input.nodeId);
  assert.equal(unread(await input.node()), '1 unread comment', 'without the setting my own comment counts');
}));

test('the Notion read watermark and notified comments survive a restart', () => comments(async input => {
  input.providers.comments[notionPageId].push(notionComment('b', '2026-09-26T12:30:00.000Z'));
  await input.poll(); const version = (await input.node()).attentionVersion;
  await input.restart(); await input.poll();
  const node = await input.node();
  assert.equal(unread(node), '1 unread comment'); assert.equal(node.attentionVersion, version, 'a restart does not notify again');
}));

test('opening the Notion page link reads every comment but keeps Needs me; only later comments count', () => comments(async input => {
  input.providers.comments[notionPageId].push(notionComment('b', '2026-09-26T12:10:00.000Z'), notionComment('c', '2026-09-26T12:11:00.000Z'));
  await input.poll(); assert.equal(unread(await input.node()), '2 unread comments');
  const raised = await input.node();
  assert.deepEqual(await input.coordinator.opened(input.nodeId), { recorded: true });
  let node = await input.node();
  assert.equal(unread(node), undefined);
  assert.equal(node.attentionSources?.['notion.comments'], 'comment', 'opening never withdraws Needs me; Mark seen does');
  assert.equal(node.attentionVersion, raised.attentionVersion); assert.equal(node.attentionSeenVersion, raised.attentionSeenVersion);
  await input.poll(); assert.equal((await input.node()).attentionVersion, raised.attentionVersion, 'a poll after opening does not withdraw or re-raise it');
  input.providers.comments[notionPageId].push(notionComment('e', '2026-09-26T12:13:00.000Z'));
  await input.poll(); node = await input.node();
  assert.equal(unread(node), '1 unread comment'); assert.equal(node.attentionNotes?.['notion.comments'], 'New comment');
  assert.ok((node.attentionVersion ?? 0) > (raised.attentionVersion ?? 0), 'a later comment raises a new cycle');
}));

test('missing Read comments capability degrades to an explicit state without failing the page or retrying every poll', () => comments(async input => {
  input.providers.access.comments = false;
  const snapshot = await input.coordinator.read(input.nodeId, true);
  assert.equal(snapshot.stale, undefined); assert.equal(snapshot.title, 'Billing experience');
  assert.match(String((snapshot.detail?.comments as JsonObject).reason), /Read comments capability/);
  const asked = () => input.providers.calls.filter(path => path.startsWith('/v1/comments')).length, before = asked();
  await input.poll(); await input.poll();
  assert.equal(asked(), before, 'background polls wait before asking again');
  const node = await input.node();
  assert.equal(unread(node), undefined); assert.equal(node.indicators?.some(cue => cue.id === 'connection') ?? false, false);
  input.providers.access.comments = true; await input.poll(); await input.poll(); await input.poll();
  assert.equal(((await input.coordinator.cached(input.nodeId))?.detail?.comments as JsonObject).available, true);
}));
