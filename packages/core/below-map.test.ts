import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkspaceControl, MemoryStore } from './control.ts';
import { createResourcePluginRegistry } from '../../src/resource-plugins/builtins.ts';
import { attentionItems } from '../../src/graph/attention.ts';
import { isBelow, isOffMap } from '../../src/graph/archive.ts';
import { itemFootprint } from '../../src/graph/footprints.ts';
import { ITEM_GAP } from '../../src/graph/movement.ts';
import { overlaps } from '../../src/graph/spatial.ts';

const pr = (id: string, projectId: string | undefined, x: number, number = 1) => ({ type: 'item.add', id, resourceId: `${id}-r`, pluginId: 'github.pull-request', title: id, data: { owner: 'acme', repo: 'app', number }, ...(projectId ? { projectId } : {}), position: { x, y: 0 } });
async function setup() {
  const control = new WorkspaceControl(new MemoryStore(), createResourcePluginRegistry());
  let state = await control.apply({ type: 'project.create', id: 'p', title: 'Billing', position: { x: 0, y: 0 } }, 0);
  for (const [id, x, n] of [['a', 0, 1], ['b', 400, 2]] as const) state = await control.apply(pr(id, 'p', x, n), state.revision);
  return { control, get state() { return state; }, async apply(command: unknown) { state = await control.apply(command as any, state.revision); return state; } };
}
const node = (state: { nodes: any[] }, id: string) => state.nodes.find(n => n.id === id);

test('sending below hides an item from the map and Needs me without archiving it; it returns to the nearest free spot', async () => {
  const f = await setup();
  await f.apply({ type: 'node.update', id: 'a', attention: 'input' });
  const before = node(f.state, 'a').position;
  let state = await f.apply({ type: 'node.below', id: 'a' });
  assert.ok(node(state, 'a').belowAt); assert.equal(node(state, 'a').archivedAt, undefined);
  assert.ok(isBelow(node(state, 'a'), state.nodes)); assert.ok(isOffMap(node(state, 'a'), state.nodes));
  assert.equal(attentionItems(state.nodes).length, 0, 'items below never need attention on the map');
  await assert.rejects(f.apply({ type: 'node.delete', id: 'a' }), /Archive the item/);
  // Another item takes the old spot while it is below.
  state = await f.apply({ type: 'node.move', id: 'b', position: before });
  assert.deepEqual(node(state, 'b').position, before, 'items below are not obstacles on the map');
  state = await f.apply({ type: 'node.surface', id: 'a' });
  assert.equal(node(state, 'a').belowAt, undefined); assert.equal(node(state, 'a').projectId, 'p');
  assert.notDeepEqual(node(state, 'a').position, before); assert.deepEqual(node(state, 'b').position, before, 'returning never pushes existing items');
  assert.ok(Math.hypot(node(state, 'a').position.x - before.x, node(state, 'a').position.y - before.y) < 500, 'nearest free spot');
  await assert.rejects(f.apply({ type: 'node.surface', id: 'a' }), /already on the map/);
});

test('a project below takes its items along; they return only with it, and archive from below restores back below', async () => {
  const f = await setup();
  let state = await f.apply({ type: 'node.below', id: 'p' });
  assert.ok(isBelow(node(state, 'a'), state.nodes));
  await assert.rejects(f.apply({ type: 'node.surface', id: 'a' }), /Bring its project “Billing” back first/);
  state = await f.apply({ type: 'node.below', id: 'a' });
  await assert.rejects(f.apply({ type: 'node.surface', id: 'a' }), /Bring its project “Billing” back first/, 'even when sent below on its own');
  state = await f.apply({ type: 'node.surface', id: 'p' });
  assert.ok(isBelow(node(state, 'a'), state.nodes)); state = await f.apply({ type: 'node.surface', id: 'a' });
  assert.ok(!isOffMap(node(state, 'a'), state.nodes));
  state = await f.apply({ type: 'nodes.action', ids: ['a', 'b'], action: 'below' });
  assert.ok(node(state, 'a').belowAt && node(state, 'b').belowAt);
  state = await f.apply({ type: 'node.archive', id: 'a' });
  assert.ok(!isBelow(node(state, 'a'), state.nodes), 'archived items leave the layer below');
  await assert.rejects(f.apply({ type: 'node.below', id: 'a' }), /archive first/);
  await assert.rejects(f.apply({ type: 'node.surface', id: 'a' }), /archive first/);
  state = await f.apply({ type: 'node.restore', id: 'a' });
  assert.ok(isBelow(node(state, 'a'), state.nodes), 'restore returns it below, where it was archived from');
  state = await f.apply({ type: 'nodes.action', ids: ['a', 'b'], action: 'surface' });
  assert.ok(!isOffMap(node(state, 'a'), state.nodes) && !isOffMap(node(state, 'b'), state.nodes));
});

test('items below whose project was deleted cannot return to the map', async () => {
  const f = await setup();
  await f.apply({ type: 'node.below', id: 'a' });
  await f.apply({ type: 'node.archive', id: 'p' });
  let state = await f.apply({ type: 'node.delete', id: 'p' });
  assert.equal(node(state, 'a').lostProject, 'Billing'); assert.ok(node(state, 'a').archivedAt);
  state = await f.apply({ type: 'node.restore', id: 'a' });
  assert.ok(isBelow(node(state, 'a'), state.nodes));
  await assert.rejects(f.apply({ type: 'node.surface', id: 'a' }), /Its project “Billing” was deleted/);
  assert.equal(node((await f.control.read()), 'b').belowAt, undefined, 'items that were only archived keep the old restore behavior');
});

const registry = createResourcePluginRegistry();
const boxOf = (state: { nodes: any[]; resources: any[] }, id: string) => itemFootprint(node(state, id), state.resources, registry);
const apart = (state: { nodes: any[]; resources: any[] }, a: string, b: string) => !overlaps(boxOf(state, a), boxOf(state, b), ITEM_GAP);
const offsets = (state: { nodes: any[] }, ids: string[]) => ids.map(id => ({ x: node(state, id).position.x - node(state, ids[0]).position.x, y: node(state, id).position.y - node(state, ids[0]).position.y }));

test('items sent below one by one or as a selection land beside the project’s items below, and surface where they were', async () => {
  const f = await setup();
  for (const [id, x, y, n] of [['c', 0, 400, 3], ['d', 300, 400, 4], ['e', 0, 520, 5]] as const) await f.apply({ ...pr(id, 'p', x, n), position: { x, y } });
  const sent = ['a', 'b', 'c', 'd', 'e'], original = Object.fromEntries(sent.map(id => [id, node(f.state, id).position]));
  const shape = offsets(f.state, ['c', 'd', 'e']);
  let state = await f.apply({ type: 'node.below', id: 'a' });
  assert.deepEqual(node(state, 'a').position, original.a, 'the first item below keeps its spot');
  assert.equal(node(state, 'a').mapPosition, undefined);
  state = await f.apply({ type: 'node.below', id: 'b' });
  assert.deepEqual(node(state, 'b').mapPosition, original.b);
  assert.ok(node(state, 'b').position.x > node(state, 'a').position.x, 'beside the project’s items below, to the right');
  const revision = state.revision;
  state = await f.apply({ type: 'nodes.action', ids: ['e', 'c', 'd'], action: 'below' });
  assert.equal(state.revision, revision + 1, 'a selection is one undoable revision');
  for (let i = 0; i < sent.length; i++) for (let j = i + 1; j < sent.length; j++) assert.ok(apart(state, sent[i], sent[j]), `${sent[i]} and ${sent[j]} overlap below the map`);
  assert.deepEqual(offsets(state, ['c', 'd', 'e']), shape, 'the selection keeps its layout');
  state = await f.apply({ type: 'nodes.action', ids: sent, action: 'surface' });
  for (const id of sent) { assert.deepEqual(node(state, id).position, original[id], `${id} returns to its map position`); assert.equal(node(state, id).mapPosition, undefined); }
});

test('a project sent below lands clear of other projects below and surfaces with its layout', async () => {
  const f = await setup();
  await f.apply({ type: 'project.create', id: 'q', title: 'Search', position: { x: 0, y: 600 } });
  await f.apply({ ...pr('q1', 'q', 0, 9), position: { x: 0, y: 600 } });
  await f.apply({ type: 'node.below', id: 'p' });
  await f.apply({ type: 'node.move', id: 'a', position: node(f.state, 'q1').position });
  const original = Object.fromEntries(['q', 'q1'].map(id => [id, node(f.state, id).position]));
  let state = await f.apply({ type: 'node.below', id: 'q' });
  assert.ok(apart(state, 'q1', 'a') && apart(state, 'q1', 'b'));
  assert.deepEqual(node(state, 'q').mapPosition, original.q); assert.deepEqual(node(state, 'q1').mapPosition, original.q1);
  state = await f.apply({ type: 'node.surface', id: 'q' });
  assert.deepEqual(node(state, 'q').position, original.q); assert.deepEqual(node(state, 'q1').position, original.q1);
  assert.equal(node(state, 'q1').mapPosition, undefined);
});
