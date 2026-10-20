import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkspaceControl } from './control.ts';

const pageId = '0123456789abcdef0123456789abcdef', url = `https://app.notion.com/p/acme/Billing-Export-${pageId}`;
const actor = { kind: 'user', id: 'test' };

async function workspace() {
  const control = new WorkspaceControl();
  const { state } = await control.dispatch({ commandId: 'seed', expectedRevision: 0, actor, commands: [
    { type: 'project.create', id: 'project', title: 'Billing', position: { x: 0, y: 0 } },
    { type: 'item.add', id: 'link', resourceId: 'link-r', pluginId: 'web.link', title: 'Notion', data: { url }, projectId: 'project', position: { x: 40, y: 400 } },
    { type: 'item.add', id: 'note', resourceId: 'note-r', pluginId: 'workspace.note', data: { text: 'Read the spec' }, projectId: 'project', position: { x: 400, y: 400 } },
    { type: 'link.save', link: { id: 'context', sourceId: 'link', targetId: 'note', kind: 'reference', label: 'spec' } },
    { type: 'todo.save', todo: { id: 'todo', title: 'Review the spec', nodeIds: ['link'] } },
    { type: 'node.resize', id: 'link', size: 'medium' },
    { type: 'node.update', id: 'link', summary: 'app.notion.com', indicators: [{ id: 'connection', label: 'Updates paused', icon: 'clock', tone: 'amber' }] },
  ] });
  return { control, state };
}

test('item.convert swaps a generic link for the type that claims its URL and keeps every identity', async () => {
  const { control, state: before } = await workspace(), old = before.nodes.find(node => node.id === 'link')!;
  const state = await control.apply({ type: 'item.convert', id: 'link', pluginId: 'notion.page', connectionId: 'notion-1' }, before.revision);
  const node = state.nodes.find(node => node.id === 'link')!, resource = state.resources.find(record => record.id === 'link-r')!;
  assert.deepEqual(resource, { id: 'link-r', pluginId: 'notion.page', schemaVersion: 1, title: 'Notion', connectionId: 'notion-1', data: { pageId } });
  assert.equal(node.resourceId, 'link-r'); assert.deepEqual(node.position, old.position); assert.equal(node.projectId, 'project'); assert.equal(node.mapSize, 'medium');
  assert.equal(node.title, 'Notion', 'the provider read supplies the title afterwards'); assert.equal(node.generatedTitle, undefined);
  assert.equal(node.summary, ''); assert.equal(node.indicators, undefined, 'the old type\'s status does not describe the new one');
  assert.deepEqual(state.links, before.links); assert.deepEqual(state.todos, before.todos);
  assert.deepEqual(state.nodes.filter(other => other.id !== 'link'), before.nodes.filter(other => other.id !== 'link'));
  assert.equal(state.resources.length, before.resources.length);
});

test('item.convert can keep a title the person chose', async () => {
  const { control, state: before } = await workspace();
  let state = await control.apply({ type: 'node.update', id: 'link', title: 'Billing export spec' }, before.revision);
  state = await control.apply({ type: 'item.convert', id: 'link', pluginId: 'notion.page', connectionId: 'notion-1', keepTitle: true }, state.revision);
  const node = state.nodes.find(node => node.id === 'link')!;
  assert.equal(node.title, 'Billing export spec'); assert.equal(node.generatedTitle, 'Billing export spec', 'provider refreshes leave a kept title alone');
});

test('item.convert never creates a second item for a page already on the map', async () => {
  const { control, state: before } = await workspace();
  let state = await control.apply({ type: 'item.create', id: 'page', position: { x: 800, y: 400 }, resource: { id: 'page-r', pluginId: 'notion.page', schemaVersion: 1, title: 'Billing Export', connectionId: 'notion-1', data: { pageId } } }, before.revision);
  await assert.rejects(control.apply({ type: 'item.convert', id: 'link', pluginId: 'notion.page', connectionId: 'notion-1' }, state.revision), /already/);
  state = await control.read();
  assert.equal(state.resources.find(record => record.id === 'link-r')!.pluginId, 'web.link', 'the link is left as it was');
  assert.equal(state.resources.filter(record => record.pluginId === 'notion.page').length, 1);
});

test('item.convert only follows URL matching: no other source type, no unrelated or generic target', async () => {
  const { control, state } = await workspace();
  await assert.rejects(control.apply({ type: 'item.convert', id: 'note', pluginId: 'notion.page' }, state.revision), /cannot be converted/);
  await assert.rejects(control.apply({ type: 'item.convert', id: 'link', pluginId: 'github.pull-request' }, state.revision), /cannot be converted/);
  await assert.rejects(control.apply({ type: 'item.convert', id: 'link', pluginId: 'web.link' }, state.revision), /cannot be converted/);
  await assert.rejects(control.apply({ type: 'item.convert', id: 'project', pluginId: 'notion.page' }, state.revision), /not a resource item/);
  assert.equal((await control.read()).revision, state.revision);
});

test('registry.conversions lists the specific types for a generic link only', async () => {
  const { control, state } = await workspace(), registry = control.registry;
  assert.deepEqual(registry.conversions(state.resources.find(record => record.id === 'link-r')!).map(candidate => [candidate.pluginId, candidate.data]), [['notion.page', { pageId }]]);
  assert.deepEqual(registry.conversions({ id: 'r', pluginId: 'web.link', schemaVersion: 1, title: 'Example', data: { url: 'https://example.com/docs' } }), []);
  assert.deepEqual(registry.conversions(state.resources.find(record => record.id === 'note-r')!), []);
  assert.deepEqual(registry.conversions({ id: 'r', pluginId: 'web.bookmark', schemaVersion: 1, title: 'Notion', data: { url, notes: 'mine' } }), [], 'a bookmark with notes is not a generic link');
});
