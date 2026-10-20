import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore, WorkspaceControl } from './control.ts';
import type { WorkspaceCommand, WorkspaceState } from './control.ts';
import { groupWorkspaceTodos } from '../../src/graph/todos.ts';
import { completeTodo, renameTodo, sendTargets, sendTodo } from './todos.ts';
import { itemFootprint } from '../../src/graph/footprints.ts';
import { overlaps } from '../../src/graph/spatial.ts';
import { ITEM_GAP } from '../../src/graph/movement.ts';

const ticket = (number: number) => ({ source: 'linear', key: `aaaaaaaa-aaaa-4aaa-8aaa-00000000000${number}`, label: `BIL-${number}`, url: `https://linear.app/fixture/issue/BIL-${number}/ticket`,
  item: { pluginId: 'linear.ticket', connectionId: 'linear-fixture', title: `BIL-${number} · Ticket ${number}`, data: { issueId: `aaaaaaaa-aaaa-4aaa-8aaa-00000000000${number}` } } });
const imported = (number: number): WorkspaceCommand => ({ type: 'todo.save', todo: { id: `import-${number}`, title: `BIL-${number} Ticket ${number}`, completed: false, nodeIds: [], triage: ticket(number) } });
async function fixture() {
  const control = new WorkspaceControl(new MemoryStore());
  const apply = async (commands: WorkspaceCommand[]) => (await control.dispatch({ commandId: crypto.randomUUID(), expectedRevision: (await control.read()).revision, actor: { kind: 'user', id: 'test' }, commands })).state;
  await apply([
    { type: 'project.create', id: 'billing', title: 'Billing', summary: '', position: { x: 0, y: 0 } },
    { type: 'project.create', id: 'docs', title: 'Docs', summary: '', position: { x: 2000, y: 0 } },
    { type: 'project.create', id: 'empty', title: 'Empty', summary: '', position: { x: 0, y: 2000 } },
    { type: 'item.add', id: 'note', resourceId: 'note-r', pluginId: 'workspace.todo', title: 'Existing billing work', data: {}, projectId: 'billing', position: { x: 0, y: 0 } },
    { type: 'item.add', id: 'guide', resourceId: 'guide-r', pluginId: 'workspace.todo', title: 'Existing docs work', data: {}, projectId: 'docs', position: { x: 2000, y: 0 } },
  ]);
  return { control, apply };
}
function clear(state: WorkspaceState, control: WorkspaceControl) {
  const boxes = state.nodes.filter(node => node.resourceId).map(node => itemFootprint(node, state.resources, control.registry));
  return boxes.every(box => !boxes.some(other => other.id !== box.id && overlaps(box, other, ITEM_GAP)));
}

test('an imported to-do keeps its import through list edits and gains its item when it is placed on the map', async () => {
  const { control, apply } = await fixture();
  let state = await apply([imported(1)]);
  let entry = groupWorkspaceTodos(state)[0].items[0];
  assert.equal(groupWorkspaceTodos(state)[0].title, 'Triage'); assert.equal(entry.triage?.label, 'BIL-1');
  state = await apply([renameTodo(entry, 'BIL-1 Reworded'), completeTodo(entry, true)]);
  assert.deepEqual(state.todos[0].triage, ticket(1)); assert.equal(state.todos[0].completed, true); assert.equal(state.todos[0].horizon, 'next', 'ticking takes it out of the inbox');
  entry = groupWorkspaceTodos(state).flatMap(group => group.items).find(item => item.id === 'import-1')!;
  state = await apply([{ type: 'todo.place', id: entry.id, nodeId: 'placed', resourceId: 'placed-r', position: { x: 900, y: 900 } }]);
  const todo = state.nodes.find(node => node.id === 'placed')!, item = state.nodes.find(node => node.id === 'placed:item')!;
  assert.equal(todo.title, 'BIL-1 Reworded'); assert.ok(todo.completedAt); assert.equal(todo.projectId, undefined); assert.equal(item.projectId, undefined);
  assert.deepEqual(state.resources.find(resource => resource.id === item.resourceId), { id: 'placed-r:item', pluginId: 'linear.ticket', schemaVersion: 1, title: 'BIL-1 · Ticket 1', connectionId: 'linear-fixture', data: ticket(1).item.data });
  assert.deepEqual(state.links.map(link => [link.sourceId, link.targetId, link.kind]), [['placed', 'placed:item', 'reference']]);
  assert.deepEqual(state.todos, []); assert.equal(clear(state, control), true);
  assert.deepEqual(groupWorkspaceTodos(state).map(group => [group.title, group.items.map(item => [item.id, item.nodeIds])]), [['Billing', [['map:note', []]]], ['Docs', [['map:guide', []]]], ['No project', [['map:placed', ['placed:item']]]]]);
});

test('sending from Triage creates the to-do and its ticket beside the project\'s items without moving anything else', async () => {
  const { control, apply } = await fixture();
  let state = await apply([imported(1), imported(2)]);
  const before = structuredClone(state.nodes), entry = groupWorkspaceTodos(state)[0].items[0];
  assert.deepEqual(sendTargets(state, entry), [{ id: 'billing', title: 'Billing', current: false }, { id: 'docs', title: 'Docs', current: false }, { id: 'empty', title: 'Empty', current: false }]);
  state = await apply([sendTodo(entry, 'billing', { nodeId: 'sent', resourceId: 'sent-r' })]);
  const todo = state.nodes.find(node => node.id === 'sent')!, item = state.nodes.find(node => node.id === 'sent:item')!, note = state.nodes.find(node => node.id === 'note')!;
  assert.equal(todo.projectId, 'billing'); assert.equal(item.projectId, 'billing'); assert.equal(todo.title, 'BIL-1 Ticket 1');
  assert.equal(state.resources.find(resource => resource.id === item.resourceId)?.pluginId, 'linear.ticket');
  assert.deepEqual(state.links.map(link => [link.sourceId, link.targetId]), [['sent', 'sent:item']]);
  assert.deepEqual(state.nodes.filter(node => before.some(old => old.id === node.id)), before, 'existing items and projects stay put');
  assert.equal(clear(state, control), true);
  assert.ok(Math.hypot(todo.position.x - note.position.x, todo.position.y - note.position.y) < 400, 'lands near the project\'s items');
  assert.ok(item.position.y > todo.position.y && item.position.x === todo.position.x, 'the ticket sits below its to-do');
  assert.deepEqual(groupWorkspaceTodos(state).map(group => [group.title, group.items.map(item => item.id)]), [['Triage', ['import-2']], ['Billing', ['map:note', 'map:sent']], ['Docs', ['map:guide']]]);
  assert.deepEqual(state.todos.map(todo => todo.id), ['import-2']);
  state = await apply([sendTodo(groupWorkspaceTodos(state)[0].items[0], 'empty', { nodeId: 'second', resourceId: 'second-r' })]);
  assert.deepEqual(state.nodes.find(node => node.id === 'second')!.position, { x: 0, y: 2000 }, 'an empty project receives the block on its anchor');
  assert.equal(clear(state, control), true);
});

test('sending a map to-do moves it and its attached items as a block, leaving off-map and project attachments alone', async () => {
  const { control, apply } = await fixture();
  let state = await apply([
    { type: 'item.add', id: 'task', resourceId: 'task-r', pluginId: 'workspace.todo', title: 'Ship it', data: {}, projectId: 'billing', position: { x: 400, y: 0 } },
    { type: 'item.add', id: 'near', resourceId: 'near-r', pluginId: 'workspace.todo', title: 'Attached nearby', data: {}, projectId: 'billing', position: { x: 400, y: 120 } },
    { type: 'item.add', id: 'far', resourceId: 'far-r', pluginId: 'workspace.todo', title: 'Attached elsewhere', data: {}, position: { x: 5000, y: 5000 } },
    { type: 'item.add', id: 'sunk', resourceId: 'sunk-r', pluginId: 'workspace.todo', title: 'Attached below', data: {}, projectId: 'billing', position: { x: 400, y: 300 } },
    { type: 'link.save', link: { id: 'l1', sourceId: 'near', targetId: 'task', kind: 'reference', label: '' } },
    { type: 'link.save', link: { id: 'l2', sourceId: 'task', targetId: 'far', kind: 'reference', label: '' } },
    { type: 'link.save', link: { id: 'l3', sourceId: 'task', targetId: 'sunk', kind: 'reference', label: '' } },
    { type: 'link.save', link: { id: 'l4', sourceId: 'task', targetId: 'billing', kind: 'reference', label: '' } },
    { type: 'node.below', id: 'sunk' },
  ]);
  const before = state, entry = groupWorkspaceTodos(state).flatMap(group => group.items).find(item => item.id === 'map:task')!;
  assert.deepEqual(sendTargets(state, entry).map(target => [target.id, target.current]), [['billing', true], ['docs', false], ['empty', false]]);
  state = await apply([sendTodo(entry, 'docs', { nodeId: 'unused', resourceId: 'unused-r' })]);
  const at = (id: string, from = state) => from.nodes.find(node => node.id === id)!;
  assert.deepEqual(['task', 'near', 'far', 'sunk'].map(id => at(id).projectId), ['docs', 'docs', 'docs', 'billing']);
  assert.deepEqual({ x: at('near').position.x - at('task').position.x, y: at('near').position.y - at('task').position.y }, { x: 0, y: 120 }, 'items from the same project keep their layout');
  assert.equal(at('far').position.x, at('task').position.x); assert.ok(at('far').position.y > at('near').position.y, 'items from elsewhere stack below');
  assert.deepEqual(at('sunk'), at('sunk', before)); assert.deepEqual(at('guide'), at('guide', before)); assert.deepEqual(at('billing'), at('billing', before));
  assert.deepEqual(state.links, before.links); assert.equal(state.nodes.some(node => node.id === 'unused'), false);
  assert.equal(clear({ ...state, nodes: state.nodes.filter(node => !node.belowAt) }, control), true);
  assert.ok(Math.abs(at('task').position.x - at('guide').position.x) < 600);
  const settled = state; state = await apply([sendTodo({ ...entry, projectId: 'docs' }, 'docs', { nodeId: 'unused', resourceId: 'unused-r' })]);
  assert.deepEqual(state.nodes, settled.nodes, 'sending to the project it is already in changes nothing');
});

test('sending refuses unknown to-dos, non-project and off-map targets, and list-only to-dos without map ids', async () => {
  const { apply } = await fixture();
  await apply([imported(1), { type: 'node.below', id: 'docs' }]);
  await assert.rejects(apply([{ type: 'todo.send', id: 'missing', projectId: 'billing', nodeId: 'n', resourceId: 'r' }]), /no longer available/);
  await assert.rejects(apply([{ type: 'todo.send', id: 'import-1', projectId: 'note', nodeId: 'n', resourceId: 'r' }]), /not a project/);
  await assert.rejects(apply([{ type: 'todo.send', id: 'import-1', projectId: 'docs', nodeId: 'n', resourceId: 'r' }]), /back to the map/);
  await assert.rejects(apply([{ type: 'todo.send', id: 'import-1', projectId: 'billing' }]), /nodeId and resourceId/);
  await assert.rejects(apply([{ type: 'todo.send', id: 'map:guide', projectId: 'billing' }]), /Undermap/);
  const state = await apply([{ type: 'node.archive', id: 'empty' }]);
  assert.deepEqual(sendTargets(state, groupWorkspaceTodos(state)[0].items[0]).map(target => target.id), ['billing']);
});
