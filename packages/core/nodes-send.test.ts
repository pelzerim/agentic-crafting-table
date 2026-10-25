import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore, WorkspaceControl } from './control.ts';
import type { WorkspaceCommand, WorkspaceState } from './control.ts';
import { moveTargets } from './todos.ts';
import { itemFootprint } from '../../src/graph/footprints.ts';
import { overlaps } from '../../src/graph/spatial.ts';
import { ITEM_GAP } from '../../src/graph/movement.ts';
import { NEIGHBORHOOD_PADDING } from '../../src/graph/project-neighborhoods.ts';
import { boundsOf, field } from '../../src/graph/undermap.ts';

const note = (id: string, position: { x: number; y: number }, projectId?: string): WorkspaceCommand => ({ type: 'item.add', id, resourceId: `${id}-r`, pluginId: 'workspace.note', title: id, data: { text: id }, projectId, position });
const todo = (id: string, position: { x: number; y: number }, projectId?: string): WorkspaceCommand => ({ type: 'item.add', id, resourceId: `${id}-r`, pluginId: 'workspace.todo', title: id, data: {}, projectId, position });
const link = (id: string, sourceId: string, targetId: string): WorkspaceCommand => ({ type: 'link.save', link: { id, sourceId, targetId, kind: 'reference', label: '' } });
async function fixture(actor: 'user' | 'agent' = 'user') {
  const control = new WorkspaceControl(new MemoryStore());
  const apply = async (commands: WorkspaceCommand[]) => (await control.dispatch({ commandId: crypto.randomUUID(), expectedRevision: (await control.read()).revision, actor: { kind: actor, id: 'test' }, commands })).state;
  await apply([
    { type: 'project.create', id: 'billing', title: 'Billing', summary: '', position: { x: 0, y: 0 } },
    { type: 'project.create', id: 'docs', title: 'Docs', summary: '', position: { x: 3000, y: 0 } },
    { type: 'project.create', id: 'empty', title: 'Empty', summary: '', position: { x: 0, y: 3000 } },
    note('pr', { x: 0, y: 0 }, 'billing'), note('spec', { x: 400, y: 0 }, 'billing'), note('guide', { x: 3000, y: 0 }, 'docs'),
    link('l1', 'pr', 'spec'),
  ]);
  return { control, apply };
}
const at = (state: WorkspaceState, id: string) => state.nodes.find(node => node.id === id)!;
function clear(state: WorkspaceState, control: WorkspaceControl) {
  const boxes = state.nodes.filter(node => node.resourceId && !node.belowAt && !node.archivedAt).map(node => itemFootprint(node, state.resources, control.registry));
  return boxes.every(box => !boxes.some(other => other.id !== box.id && overlaps(box, other, ITEM_GAP)));
}
const offset = (state: WorkspaceState, a: string, b: string) => ({ x: at(state, b).position.x - at(state, a).position.x, y: at(state, b).position.y - at(state, a).position.y });

test('moving one item puts it beside the target project\'s items, keeps its links and leaves linked items behind', async () => {
  const { control, apply } = await fixture();
  const before = await control.read(), state = await apply([{ type: 'nodes.send', ids: ['pr'], projectId: 'docs' }]);
  assert.equal(state.revision, before.revision + 1);
  assert.equal(at(state, 'pr').projectId, 'docs');
  assert.deepEqual(at(state, 'spec'), at(before, 'spec'), 'a linked item is not dragged along');
  assert.deepEqual(state.nodes.filter(node => node.id !== 'pr'), before.nodes.filter(node => node.id !== 'pr'), 'nothing else moves');
  assert.deepEqual(state.links, before.links); assert.deepEqual(state.resources, before.resources);
  assert.ok(Math.hypot(at(state, 'pr').position.x - 3000, at(state, 'pr').position.y) < 600, 'lands near the project\'s items');
  assert.equal(clear(state, control), true);
});

test('an empty project receives the item on its anchor, and a floating item can be moved in', async () => {
  const { control, apply } = await fixture();
  let state = await apply([{ type: 'nodes.send', ids: ['pr'], projectId: 'empty' }]);
  assert.deepEqual(at(state, 'pr').position, { x: 0, y: 3000 }); assert.equal(at(state, 'pr').projectId, 'empty');
  state = await apply([note('loose', { x: 6000, y: 6000 }), { type: 'nodes.send', ids: ['loose'], projectId: 'empty' }]);
  assert.equal(at(state, 'loose').projectId, 'empty'); assert.equal(clear(state, control), true);
  assert.ok(Math.hypot(at(state, 'loose').position.x, at(state, 'loose').position.y - 3000) < 600);
});

test('a selection moves as one block that keeps its layout, led by the first id, whatever projects its items came from', async () => {
  const { control, apply } = await fixture();
  let state = await apply([note('loose', { x: 150, y: 420 })]);
  const before = state, layout = [offset(state, 'spec', 'pr'), offset(state, 'spec', 'loose')];
  state = await apply([{ type: 'nodes.send', ids: ['spec', 'pr', 'loose'], projectId: 'docs' }]);
  assert.deepEqual(['spec', 'pr', 'loose'].map(id => at(state, id).projectId), ['docs', 'docs', 'docs']);
  assert.deepEqual([offset(state, 'spec', 'pr'), offset(state, 'spec', 'loose')], layout);
  assert.deepEqual(at(state, 'guide'), at(before, 'guide')); assert.equal(clear(state, control), true);
  assert.equal(state.revision, before.revision + 1, 'one atomic command');
});

test('sending to no project takes the items out as one block that keeps its layout and lands outside the project\'s ground', async () => {
  const { control, apply } = await fixture();
  const before = await apply([note('third', { x: 0, y: 300 }, 'billing')]), layout = offset(before, 'pr', 'spec');
  const state = await apply([{ type: 'nodes.send', ids: ['pr', 'spec'], projectId: null }]);
  assert.deepEqual(['pr', 'spec', 'third'].map(id => at(state, id).projectId), [undefined, undefined, 'billing']);
  assert.deepEqual(offset(state, 'pr', 'spec'), layout);
  const ground = field('billing', boundsOf([itemFootprint(at(state, 'third'), state.resources, control.registry)]), NEIGHBORHOOD_PADDING);
  for (const id of ['pr', 'spec']) assert.equal(overlaps(itemFootprint(at(state, id), state.resources, control.registry), ground, 0), false, `${id} is off the ground`);
  assert.ok(Math.hypot(at(state, 'pr').position.x, at(state, 'pr').position.y - 300) < 1500, 'stays near its old project');
  assert.deepEqual(at(state, 'guide'), at(before, 'guide')); assert.deepEqual(state.links, before.links); assert.equal(clear(state, control), true);
  assert.deepEqual((await apply([{ type: 'nodes.send', ids: ['pr'], projectId: null }])).nodes, state.nodes, 'an item without a project stays put');
});

test('a project left empty by sending to no project keeps its anchor clear', async () => {
  const { control, apply } = await fixture();
  const state = await apply([{ type: 'nodes.send', ids: ['pr', 'spec'], projectId: null }]);
  assert.deepEqual(['pr', 'spec'].map(id => at(state, id).projectId), [undefined, undefined]);
  const anchor = itemFootprint(at(state, 'billing'), state.resources, control.registry);
  for (const id of ['pr', 'spec']) assert.equal(overlaps(itemFootprint(at(state, id), state.resources, control.registry), anchor, ITEM_GAP), false);
});

test('items already in the target stay where they are: alone it changes nothing, in a selection only the others move', async () => {
  const { apply } = await fixture();
  const before = await apply([note('loose', { x: 6000, y: 6000 })]);
  let state = await apply([{ type: 'nodes.send', ids: ['pr'], projectId: 'billing' }]);
  assert.deepEqual(state.nodes, before.nodes);
  state = await apply([{ type: 'nodes.send', ids: ['pr', 'loose'], projectId: 'billing' }]);
  assert.deepEqual(at(state, 'pr'), at(before, 'pr')); assert.equal(at(state, 'loose').projectId, 'billing');
  assert.ok(at(state, 'loose').position.x < 2000);
});

test('a to-do brings its attached items, as does an item kept in the to-do list; any other item moves alone', async () => {
  const { control, apply } = await fixture();
  let state = await apply([
    todo('task', { x: 0, y: 400 }, 'billing'), note('near', { x: 0, y: 560 }, 'billing'), note('far', { x: 6000, y: 6000 }), note('sunk', { x: 800, y: 400 }, 'billing'),
    link('l2', 'near', 'task'), link('l3', 'task', 'far'), link('l4', 'task', 'sunk'), link('l5', 'task', 'billing'),
    { type: 'node.below', id: 'sunk' },
  ]);
  const before = state;
  state = await apply([{ type: 'nodes.send', ids: ['task'], projectId: 'docs' }]);
  assert.deepEqual(['task', 'near', 'far', 'sunk', 'pr'].map(id => at(state, id).projectId), ['docs', 'docs', 'docs', 'billing', 'billing']);
  assert.deepEqual(offset(state, 'task', 'near'), { x: 0, y: 160 }, 'attached items from the same project keep their layout');
  assert.equal(at(state, 'far').position.x, at(state, 'task').position.x); assert.ok(at(state, 'far').position.y > at(state, 'near').position.y, 'attached items from elsewhere stack below');
  assert.deepEqual(at(state, 'sunk'), at(before, 'sunk')); assert.deepEqual(state.links, before.links);
  assert.equal(clear(state, control), true);
  // The same block as todo.send.
  const viaTodo = (await (async () => { const other = await fixture(); await other.apply([
    todo('task', { x: 0, y: 400 }, 'billing'), note('near', { x: 0, y: 560 }, 'billing'), note('far', { x: 6000, y: 6000 }), note('sunk', { x: 800, y: 400 }, 'billing'),
    link('l2', 'near', 'task'), link('l3', 'task', 'far'), link('l4', 'task', 'sunk'), link('l5', 'task', 'billing'), { type: 'node.below', id: 'sunk' },
  ]); return other.apply([{ type: 'todo.send', id: 'map:task', projectId: 'docs' }]); })());
  assert.deepEqual(viaTodo.nodes.map(node => [node.id, node.projectId, node.position]), state.nodes.map(node => [node.id, node.projectId, node.position]));
  // An item kept in the to-do list counts as a to-do.
  state = await apply([
    { type: 'item.add', id: 'ticket', resourceId: 'ticket-r', pluginId: 'linear.ticket', connectionId: 'linear-fixture', title: 'BIL-1', data: { issueId: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001' }, projectId: 'billing', position: { x: 0, y: 900 } },
    link('l6', 'ticket', 'spec'), { type: 'node.todo', id: 'ticket', enabled: true }, { type: 'nodes.send', ids: ['ticket'], projectId: 'empty' }]);
  assert.deepEqual(['ticket', 'spec', 'pr'].map(id => at(state, id).projectId), ['empty', 'empty', 'billing']);
});

test('moving refuses archived and Undermap targets, non-projects, projects and off-map items in the selection, and duplicates', async () => {
  const { control, apply } = await fixture();
  const state = await apply([note('gone', { x: 800, y: 800 }, 'billing'), note('sunk', { x: 800, y: 0 }, 'billing'), { type: 'node.archive', id: 'gone' }, { type: 'node.below', id: 'sunk' }, { type: 'node.below', id: 'docs' }, { type: 'node.archive', id: 'empty' }]);
  const send = (ids: string[], projectId: string) => apply([{ type: 'nodes.send', ids, projectId }]);
  await assert.rejects(send(['pr'], 'docs'), /back to the map/);
  await assert.rejects(send(['pr'], 'empty'), /archive/i);
  await assert.rejects(send(['pr'], 'spec'), /not a project/);
  await assert.rejects(send(['pr'], 'missing'), /not found/);
  await assert.rejects(send(['billing'], 'billing'), /Only items/);
  await assert.rejects(send(['gone'], 'billing'), /archive/i);
  await assert.rejects(send(['sunk'], 'billing'), /Undermap/);
  await assert.rejects(send(['pr', 'pr'], 'billing'), /Duplicate/);
  assert.deepEqual(await control.read(), state, 'refusals changed nothing');
});

test('a muted project accepts items, and an agent may move items like any other transfer', async () => {
  const { apply } = await fixture();
  await apply([{ type: 'project.mute', id: 'docs', muted: true }]);
  const agent = await fixture('agent');
  assert.equal(at(await apply([{ type: 'nodes.send', ids: ['pr'], projectId: 'docs' }]), 'pr').projectId, 'docs');
  assert.equal(at(await agent.apply([{ type: 'nodes.send', ids: ['pr'], projectId: 'docs' }]), 'pr').projectId, 'docs');
});

test('move targets list the map\'s projects in to-do order with the shared project current; floating and mixed selections have none', async () => {
  const { apply } = await fixture();
  let state = await apply([note('loose', { x: 6000, y: 6000 }), { type: 'project.create', id: 'old', title: 'Old', summary: '', position: { x: 6000, y: 0 } }, { type: 'project.create', id: 'deep', title: 'Deep', summary: '', position: { x: 9000, y: 0 } },
    { type: 'node.archive', id: 'old' }, { type: 'node.below', id: 'deep' }, { type: 'project.mute', id: 'docs', muted: true }]);
  const targets = (ids: string[]) => moveTargets(state, ids).map(target => [target.title, target.current]);
  assert.deepEqual(targets(['pr']), [['Billing', true], ['Docs', false], ['Empty', false]]);
  assert.deepEqual(targets(['pr', 'spec']), [['Billing', true], ['Docs', false], ['Empty', false]]);
  assert.deepEqual(targets(['pr', 'guide']), [['Billing', false], ['Docs', false], ['Empty', false]]);
  assert.deepEqual(targets(['loose']), [['Billing', false], ['Docs', false], ['Empty', false]]);
  state = await apply([todo('first', { x: 3000, y: 400 }, 'docs'), todo('second', { x: 0, y: 800 }, 'billing')]);
  state = await apply([{ type: 'todos.reorder', scope: 'projects', ids: ['docs', 'billing'] }]);
  assert.deepEqual(targets(['pr']), [['Docs', false], ['Billing', true], ['Empty', false]]);
});
