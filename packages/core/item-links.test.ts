import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore, WorkspaceControl, commandSchema, itemLinkId, itemLinkReport } from './control.ts';
import { registryWithSinglePartner, singlePartner } from '../../tests/fixtures/single-partner.ts';

const actor = { kind: 'user', id: 'test' }, position = { x: 0, y: 0 };
const envelope = (commandId: string, expectedRevision: number, commands: unknown[]) => ({ commandId, expectedRevision, actor, commands });
const agent = (id: string) => ({ type: 'item.add', id, resourceId: `${id}-r`, pluginId: 'agent.session', title: id, data: { sessionId: `session-${id}`, provider: 'claude' }, position });
const note = (id: string, links?: unknown[]) => ({ type: 'item.add', id, resourceId: `${id}-r`, pluginId: 'workspace.note', title: id, data: { text: id }, position, ...(links ? { links } : {}) });
const pull = (id: string, links?: unknown[]) => ({ type: 'item.add', id, resourceId: `${id}-r`, pluginId: 'github.pull-request', title: id, data: { owner: 'fixture', repo: 'billing', number: 42 }, position, ...(links ? { links } : {}) });
const report = (state: Parameters<typeof itemLinkReport>[0], command: unknown) => itemLinkReport(state, [commandSchema.parse(command)]);
async function table() {
  const control = new WorkspaceControl(new MemoryStore(), registryWithSinglePartner());
  const state = (await control.dispatch(envelope('setup', 0, [agent('agent'), note('first')]))).state;
  return { control, state };
}

test('item.add creates the item and its links in one revision, in the stated direction', async () => {
  const { control, state } = await table();
  const next = (await control.dispatch(envelope('add', state.revision, [note('second', [
    { otherId: 'agent', kind: 'context' },
    { otherId: 'first', kind: 'blocks', newItemIs: 'target', label: 'Needs the first note' },
    { otherId: 'first', kind: 'reference', id: 'chosen' },
  ])]))).state;
  assert.equal(next.revision, state.revision + 1);
  assert.deepEqual(next.links, [
    { id: itemLinkId('second', { otherId: 'agent', kind: 'context', newItemIs: 'source' }), sourceId: 'second', targetId: 'agent', kind: 'context', label: '' },
    { id: itemLinkId('second', { otherId: 'first', kind: 'blocks', newItemIs: 'target' }), sourceId: 'first', targetId: 'second', kind: 'blocks', label: 'Needs the first note' },
    { id: 'chosen', sourceId: 'second', targetId: 'first', kind: 'reference', label: '' },
  ]);
});

test('item.create accepts the same links', async () => {
  const { control, state } = await table();
  const next = (await control.dispatch(envelope('create', state.revision, [{ type: 'item.create', id: 'second', position, resource: { id: 'second-r', pluginId: 'workspace.note', schemaVersion: control.registry.get('workspace.note')!.schemaVersion, title: 'Second', data: { text: 'x' } },
    links: [{ otherId: 'agent', kind: 'reference', newItemIs: 'target' }] }]))).state;
  assert.deepEqual(next.links.map(link => [link.sourceId, link.targetId, link.kind]), [['agent', 'second', 'reference']]);
});

test('one invalid link refuses the whole command: no item, no link, no revision', async () => {
  const { control, state } = await table();
  const refused: [unknown, RegExp][] = [
    [{ otherId: 'missing', kind: 'reference' }, /Both endpoints must exist/],
    [{ otherId: 'first', kind: 'context' }, /Context must point to an agent/],
    [{ otherId: 'second', kind: 'reference' }, /Cannot connect an item to itself/],
  ];
  for (const [link, message] of refused) await assert.rejects(control.dispatch(envelope(crypto.randomUUID(), state.revision, [note('second', [{ otherId: 'agent', kind: 'reference' }, link])])), message);
  assert.deepEqual(await control.read(), state);
  assert.equal(commandSchema.safeParse(note('second', Array.from({ length: 9 }, () => ({ otherId: 'agent', kind: 'reference' })))).success, false, 'at most eight links');
  assert.equal(commandSchema.safeParse(note('second', [{ otherId: 'agent', kind: 'sibling' }])).success, false);
});

test('derived link ids are stable, so an exact retry and a fresh attempt agree', async () => {
  const one = await table(), two = await table();
  const command = note('second', [{ otherId: 'agent', kind: 'context' }, { otherId: 'first', kind: 'reference', newItemIs: 'target' }]);
  const first = await one.control.dispatch(envelope('add', one.state.revision, [command]));
  const replay = await one.control.dispatch(envelope('add', one.state.revision, [command]));
  assert.equal(replay.replayed, true); assert.deepEqual(replay.state, first.state);
  const other = await two.control.dispatch(envelope('other', two.state.revision, [command]));
  assert.deepEqual(other.state.links, first.state.links);
  assert.equal(new Set(first.state.links.map(link => link.id)).size, 2);
  assert.throws(() => itemLinkId('n'.repeat(120), { otherId: 'o'.repeat(120), kind: 'reference', newItemIs: 'source' }), /link id/i);
});

test('a blocks link that would close a cycle refuses the item', async () => {
  const { control, state } = await table();
  const blocked = (await control.dispatch(envelope('block', state.revision, [{ type: 'link.save', link: { id: 'b', sourceId: 'agent', targetId: 'first', kind: 'blocks' } }]))).state;
  await assert.rejects(control.dispatch(envelope('cycle', blocked.revision, [note('second', [{ otherId: 'first', kind: 'blocks', newItemIs: 'target' }, { otherId: 'agent', kind: 'blocks' }])])), /cycle|circular|block/i);
  assert.deepEqual(await control.read(), blocked);
});

test('repeating a link in one command is one link; a second id for the same relationship follows link.save and is refused', async () => {
  const { control, state } = await table();
  const same = (await control.dispatch(envelope('same', state.revision, [note('second', [{ otherId: 'agent', kind: 'reference' }, { otherId: 'agent', kind: 'reference' }])]))).state;
  assert.equal(same.links.length, 1);
  await assert.rejects(control.dispatch(envelope('twice', same.revision, [note('third', [{ otherId: 'agent', kind: 'reference', id: 'a' }, { otherId: 'agent', kind: 'reference', id: 'b' }])])), /already have this relationship/);
  await assert.rejects(control.dispatch(envelope('taken', same.revision, [note('third', [{ otherId: 'first', kind: 'reference', id: same.links[0].id }])])), /Link already exists/);
  assert.deepEqual(await control.read(), same);
});

test('a one-partner item keeps its limit', async () => {
  const { control, state } = await table();
  const device = (links: unknown[]) => ({ type: 'item.add', id: 'device', resourceId: 'device-r', pluginId: singlePartner.id, title: 'Device', data: { deviceId: 'device' }, position, links });
  await assert.rejects(control.dispatch(envelope('two', state.revision, [device([{ otherId: 'agent', kind: 'context' }, { otherId: 'first', kind: 'reference' }])])), /only one item/);
  assert.deepEqual(await control.read(), state);
  const next = (await control.dispatch(envelope('one', state.revision, [device([{ otherId: 'agent', kind: 'context' }])]))).state;
  assert.equal(next.links.length, 1);
});

test('adding an item the map already has ensures its links instead of duplicating them, and the report says so', async () => {
  const { control, state } = await table();
  const links = [{ otherId: 'agent', kind: 'reference' }, { otherId: 'first', kind: 'reference', newItemIs: 'target' }];
  const created = (await control.dispatch(envelope('first-pr', state.revision, [pull('pr', [links[0]])]))).state;
  assert.deepEqual(report(created, pull('pr', [links[0]])), [{ nodeId: 'pr', resourceId: 'pr-r', reusedResource: false, links: [{ id: created.links[0].id, existing: false }] }]);
  const again = pull('again', links), next = (await control.dispatch(envelope('again', created.revision, [again]))).state;
  assert.equal(next.resources.filter(resource => resource.pluginId === 'github.pull-request').length, 1);
  assert.equal(next.nodes.find(node => node.id === 'again')!.resourceId, 'pr-r');
  assert.deepEqual(next.links.map(link => [link.sourceId, link.targetId]), [['pr', 'agent'], ['first', 'again']]);
  assert.deepEqual(report(next, again), [{ nodeId: 'again', resourceId: 'pr-r', reusedResource: true, links: [{ id: created.links[0].id, existing: true }, { id: next.links[1].id, existing: false }] }]);
  assert.deepEqual(report(next, note('plain')), []);
});
