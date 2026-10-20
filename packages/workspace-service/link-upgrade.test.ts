import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startWorkspaceService } from './server.ts';
import { connectWorkspace } from './client.ts';
import { notionProviders, notionPageId, notionComment } from '../../tests/fixtures/notion.ts';
import { createWebLinkConnector } from '../../src/resource-plugins/items/web-link/connector.ts';
import { unreadCommentsIndicator } from '../../src/resource-plugins/indicators.ts';
import { ResourceCoordinator } from './resources.ts';
import { SqliteStore } from './sqlite-store.ts';
import { WorkspaceControl } from '../core/control.ts';
import type { WorkspaceCommand, WorkspaceState } from '../core/control.ts';

const pageUrl = `https://app.notion.com/p/acme/Billing-experience-${notionPageId}`;
type Node = WorkspaceState['nodes'][number];
interface Table {
  providers: ReturnType<typeof notionProviders>; coordinator: ResourceCoordinator; control: WorkspaceControl;
  /** A web link as it was saved before its URL was recognised: titled by the public page title. */
  bookmark(): Promise<string>; apply(...commands: WorkspaceCommand[]): Promise<WorkspaceState>;
  node(id: string): Promise<Node>; resource(id: string): Promise<WorkspaceState['resources'][number]>; poll(): Promise<void>;
  /** Renames the fixture page as Notion would: a new title and edit time. */
  renamePage(title: string): void;
}
async function table(run: (input: Table) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), 'craft-link-upgrade-')), store = new SqliteStore(join(directory, 'workspace.sqlite')), control = new WorkspaceControl(store), providers = notionProviders();
  let now = Date.parse('2026-09-26T12:00:30.000Z');
  const clock = () => now, host = providers.host(control.registry, clock);
  host.register('web.link', createWebLinkConnector(async () => 'Notion'));
  const coordinator = new ResourceCoordinator(store, control, host, providers.connections, async () => {}, clock);
  const input: Table = { providers, coordinator, control,
    async bookmark() { return (await coordinator.attach({ requestId: randomUUID(), nodeId: randomUUID(), resourceId: randomUUID(), expectedRevision: 0, pluginId: 'web.link', title: 'Web link', position: { x: 40, y: 300 }, data: { url: pageUrl } }) as { nodeId: string }).nodeId; },
    async apply(...commands) { return (await control.dispatch({ commandId: randomUUID(), expectedRevision: (await control.read()).revision, actor: { kind: 'user', id: 'test' }, commands })).state; },
    async node(id) { return (await control.read()).nodes.find(node => node.id === id)!; },
    async resource(id) { const state = await control.read(); return state.resources.find(record => record.id === state.nodes.find(node => node.id === id)!.resourceId)!; },
    async poll() { now += 11 * 60_000; await coordinator.poll(); },
    renamePage(title) {
      providers.responses[`/v1/pages/${notionPageId}/properties/title?page_size=100`] = { object: 'list', results: [{ object: 'property_item', type: 'title', title: { type: 'text', plain_text: title, text: { content: title } } }], has_more: false, next_cursor: null };
      providers.responses[`/v1/pages/${notionPageId}`].last_edited_time = new Date(now).toISOString();
    } };
  try { await run(input); } finally { await coordinator.close(); store.close(); rmSync(directory, { recursive: true, force: true }); }
}
const unread = (node: Node) => node.indicators?.find(cue => cue.id === 'comments');

test('a connected provider upgrades its bookmark once: page title, same identities, links and to-dos, no Needs me, no unread burst', () => table(async input => {
  const id = await input.bookmark();
  assert.equal((await input.node(id)).title, 'Notion'); assert.equal((await input.resource(id)).pluginId, 'web.link');
  await input.apply(
    { type: 'item.add', id: 'note', resourceId: 'note-r', pluginId: 'workspace.note', data: { text: 'Read the spec' }, position: { x: 500, y: 300 } },
    { type: 'link.save', link: { id: 'spec', sourceId: id, targetId: 'note', kind: 'reference', label: '' } },
    { type: 'todo.save', todo: { id: 'todo', title: 'Review the spec', completed: false, nodeIds: [id] } });
  input.providers.comments[notionPageId] = [notionComment('a', '2026-09-26T11:00:00.000Z'), notionComment('b', '2026-09-26T12:00:10.000Z')];
  const before = await input.control.read(), old = before.nodes.find(node => node.id === id)!;

  assert.deepEqual(await input.coordinator.upgradeLinks(), { converted: [id], skipped: [] });
  const state = await input.control.read(), node = state.nodes.find(candidate => candidate.id === id)!, resource = state.resources.find(record => record.id === old.resourceId)!;
  assert.deepEqual({ pluginId: resource.pluginId, connectionId: resource.connectionId, data: resource.data, title: resource.title }, { pluginId: 'notion.page', connectionId: 'notion-fixture', data: { pageId: notionPageId }, title: 'Billing experience' });
  assert.equal(node.title, 'Billing experience'); assert.deepEqual(node.position, old.position); assert.equal(node.resourceId, old.resourceId);
  assert.deepEqual(state.links, before.links); assert.deepEqual(state.todos, before.todos); assert.equal(state.nodes.length, before.nodes.length);
  assert.equal(node.attentionSources, undefined, 'an upgrade is quiet'); assert.equal(node.attentionVersion ?? 0, 0); assert.equal(unread(node), undefined, 'comments already there are read');

  const calls = input.providers.calls.length;
  assert.deepEqual(await input.coordinator.upgradeLinks(), { converted: [], skipped: [] });
  assert.equal(input.providers.calls.length, calls, 'nothing is left to upgrade'); assert.equal((await input.control.read()).revision, state.revision);

  await input.poll(); assert.equal((await input.node(id)).attentionSources, undefined);
  input.providers.comments[notionPageId].push(notionComment('c', '2026-09-26T12:30:00.000Z'));
  await input.poll();
  let after = await input.node(id);
  assert.deepEqual(after.indicators, [unreadCommentsIndicator(1, 'unread', { showLabel: true })]);
  assert.equal(after.attentionSources?.['notion.comments'], 'comment'); assert.equal(after.attentionNotes?.['notion.comments'], 'New comment');
  assert.deepEqual(await input.coordinator.opened(id), { recorded: true });
  after = await input.node(id);
  assert.equal(unread(after), undefined, 'opening the page reads its comments'); assert.equal(after.attentionSources?.['notion.comments'], 'comment', 'Needs me stays until Mark seen');
}));

test('bookmarks wait for an enabled connection and upgrade once it exists', () => table(async input => {
  const id = await input.bookmark();
  input.providers.accounts[0].enabled = false;
  const calls = input.providers.calls.length, revision = (await input.control.read()).revision;
  assert.deepEqual(await input.coordinator.upgradeLinks(), { converted: [], skipped: [] });
  assert.equal(input.providers.calls.length, calls, 'no provider read without a connection'); assert.equal((await input.control.read()).revision, revision);
  await assert.rejects(input.coordinator.convert(id), /Connect Notion in Settings/);
  assert.equal((await input.resource(id)).pluginId, 'web.link');
  input.providers.accounts[0].enabled = true;
  assert.deepEqual((await input.coordinator.upgradeLinks()).converted, [id]);
}));

test('a page already on the map is not duplicated: the bookmark stays', () => table(async input => {
  const page = (await input.coordinator.attach({ requestId: randomUUID(), nodeId: randomUUID(), resourceId: randomUUID(), expectedRevision: 0, pluginId: 'notion.page', title: 'Page', position: { x: 600, y: 300 }, data: { url: pageUrl } }) as { nodeId: string }).nodeId;
  const id = await input.bookmark(), calls = input.providers.calls.length;
  const result = await input.coordinator.upgradeLinks();
  assert.deepEqual(result.converted, []); assert.equal(result.skipped[0].nodeId, id); assert.match(result.skipped[0].reason, /Billing experience.*already/);
  assert.equal(input.providers.calls.length, calls, 'the duplicate is found before any provider read');
  await assert.rejects(input.coordinator.convert(id), /already/);
  const state = await input.control.read();
  assert.equal((await input.resource(id)).pluginId, 'web.link'); assert.equal(state.resources.filter(record => record.pluginId === 'notion.page').length, 1); assert.ok(state.nodes.some(node => node.id === page));
}));

test('a default bookmark title takes the page title and follows renames; Untitled pages say so', () => table(async input => {
  const id = await input.bookmark();
  await input.coordinator.upgradeLinks();
  assert.equal((await input.node(id)).title, 'Billing experience');
  input.renamePage('Billing, renamed');
  await input.poll();
  assert.equal((await input.node(id)).title, 'Billing, renamed'); assert.equal((await input.resource(id)).title, 'Billing, renamed');
  input.renamePage('');
  await input.poll();
  assert.equal((await input.node(id)).title, 'Untitled');
}));

test('a title the person gave the bookmark wins over the page title, also after the page is renamed', () => table(async input => {
  const id = await input.bookmark();
  await input.apply({ type: 'node.update', id, title: 'Billing export spec' });
  await input.coordinator.upgradeLinks();
  assert.equal((await input.resource(id)).pluginId, 'notion.page'); assert.equal((await input.node(id)).title, 'Billing export spec');
  input.renamePage('Billing, renamed');
  await input.poll();
  assert.equal((await input.node(id)).title, 'Billing export spec');
  assert.equal((await input.coordinator.cached(id))?.title, 'Billing, renamed', 'the full view still reads the page title');
}));

test('a bookmark whose saved page title is unknown is not mistaken for a renamed one', () => table(async input => {
  await input.apply({ type: 'item.add', id: 'legacy', resourceId: 'legacy-r', pluginId: 'web.link', title: 'app.notion.com', data: { url: pageUrl }, position: { x: 40, y: 300 } });
  assert.deepEqual((await input.coordinator.upgradeLinks()).converted, ['legacy']);
  assert.equal((await input.node('legacy')).title, 'Billing experience');
}));

test('a failed provider read leaves the bookmark; archived bookmarks are not upgraded on their own, Convert still works', () => table(async input => {
  const id = await input.bookmark();
  input.providers.before(() => { throw new Error('Notion page access removed'); });
  const failed = await input.coordinator.upgradeLinks();
  assert.deepEqual(failed.converted, []); assert.match(failed.skipped[0].reason, /access removed/);
  assert.equal((await input.resource(id)).pluginId, 'web.link'); assert.equal((await input.node(id)).title, 'Notion');
  input.providers.before(undefined);
  await input.apply({ type: 'node.archive', id });
  const calls = input.providers.calls.length;
  assert.deepEqual(await input.coordinator.upgradeLinks(), { converted: [], skipped: [] }); assert.equal(input.providers.calls.length, calls);
  await input.apply({ type: 'node.restore', id });
  assert.deepEqual(await input.coordinator.convert(id, 'notion.page'), { nodeId: id, resourceId: (await input.resource(id)).id, pluginId: 'notion.page' });
  assert.equal((await input.node(id)).title, 'Billing experience');
  await assert.rejects(input.coordinator.convert(id), /no more specific type/);
}));

test('the service upgrades bookmarks at start and offers resource.convert through the shared runtime route', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-link-upgrade-service-')), providers = notionProviders();
  let service = await startWorkspaceService(directory, undefined, undefined, providers), client = await connectWorkspace(directory);
  const converted = async (id: string) => { for (let attempt = 0; attempt < 100; attempt++) { const state = await service.control.read(); if (state.resources.find(record => record.id === state.nodes.find(node => node.id === id)?.resourceId)?.pluginId === 'notion.page') return state; await new Promise(resolve => setTimeout(resolve, 50)); } throw new Error('The bookmark was not upgraded'); };
  try {
    await service.control.dispatch({ commandId: 'seed', expectedRevision: 0, actor: { kind: 'user', id: 'fixture' }, commands: [{ type: 'item.add', id: 'link', resourceId: 'link-r', pluginId: 'web.link', title: 'Notion', data: { url: pageUrl }, position: { x: 40, y: 300 } }] });
    client.close(); await service.close();
    service = await startWorkspaceService(directory, undefined, undefined, providers); client = await connectWorkspace(directory);
    let state = await converted('link');
    assert.equal(state.nodes.find(node => node.id === 'link')!.title, 'Billing experience'); assert.equal(state.resources[0].id, 'link-r');
    await service.control.dispatch({ commandId: 'archive', expectedRevision: state.revision, actor: { kind: 'user', id: 'fixture' }, commands: [{ type: 'node.archive', id: 'link' }, { type: 'node.delete', id: 'link' },
      { type: 'item.add', id: 'again', resourceId: 'again-r', pluginId: 'web.link', title: 'Notion', data: { url: pageUrl }, position: { x: 40, y: 300 } }] });
    assert.deepEqual(await client.call('runtime.run', { nodeId: 'again', action: 'resource.convert', arguments: { pluginId: 'notion.page' } }), { nodeId: 'again', resourceId: 'again-r', pluginId: 'notion.page' });
    state = await service.control.read();
    assert.equal(state.nodes.find(node => node.id === 'again')!.title, 'Billing experience');
  } finally { client.close(); await service.close(); await rm(directory, { recursive: true, force: true }); }
});

test('connecting an account upgrades the bookmarks that waited for it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-link-upgrade-connect-')), providers = notionProviders();
  providers.accounts[0].enabled = false;
  const service = await startWorkspaceService(directory, undefined, undefined, providers), client = await connectWorkspace(directory);
  try {
    await service.control.dispatch({ commandId: 'seed', expectedRevision: 0, actor: { kind: 'user', id: 'fixture' }, commands: [{ type: 'item.add', id: 'link', resourceId: 'link-r', pluginId: 'web.link', title: 'Notion', data: { url: pageUrl }, position: { x: 40, y: 300 } }] });
    assert.deepEqual(await service.resources.upgradeLinks(), { converted: [], skipped: [] }); assert.equal(providers.calls.length, 0);
    providers.accounts[0].enabled = true;
    await client.call('connections.select', { providerId: 'notion', account: 'fixture-notion-bot' });
    for (let attempt = 0; attempt < 100 && (await service.control.read()).resources[0].pluginId !== 'notion.page'; attempt++) await new Promise(resolve => setTimeout(resolve, 50));
    const state = await service.control.read();
    assert.equal(state.resources[0].pluginId, 'notion.page'); assert.equal(state.nodes[0].title, 'Billing experience'); assert.equal(state.nodes[0].attentionSources, undefined);
  } finally { client.close(); await service.close(); await rm(directory, { recursive: true, force: true }); }
});
