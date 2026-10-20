import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore, WorkspaceControl } from './control.ts';
import type { CommandEnvelope, WorkspaceCommand } from './control.ts';
import { todoList } from '../../src/graph/todos.ts';
import { completeTodo } from './todos.ts';

const ticket = (number: number) => ({ source: 'linear', key: `ticket-${number}`, label: `BIL-${number}`, status: 'Todo',
  item: { pluginId: 'linear.ticket', connectionId: 'linear-fixture', title: `BIL-${number} · Ticket ${number}`, data: { issueId: `ticket-${number}` } } });
async function fixture() {
  const control = new WorkspaceControl(new MemoryStore());
  const as = (actor: CommandEnvelope['actor']) => async (commands: WorkspaceCommand[]) => (await control.dispatch({ commandId: crypto.randomUUID(), expectedRevision: (await control.read()).revision, actor, commands })).state;
  const apply = as({ kind: 'user', id: 'test' });
  await apply([
    { type: 'project.create', id: 'billing', title: 'Billing', summary: '', position: { x: 0, y: 0 } },
    { type: 'item.add', id: 'card', resourceId: 'card-r', pluginId: 'workspace.todo', title: 'Card', data: {}, projectId: 'billing', position: { x: 40, y: 40 } },
    ...['a', 'b', 'c'].map(id => ({ type: 'todo.save' as const, todo: { id, title: id.toUpperCase(), completed: false, nodeIds: id === 'a' ? ['billing'] : [] } })),
  ]);
  const ids = async () => { const list = todoList(await control.read()); return { inbox: list.inbox.map(e => e.id), next: list.next.map(e => e.id), later: list.later.map(e => e.id), done: list.done.map(e => e.id) }; };
  return { control, apply, as, ids };
}

test('new to-dos go to Next; todo.move files rows between Next and Later at a position without changing their project', async () => {
  const { control, apply, ids } = await fixture();
  assert.deepEqual((await ids()).next, ['a', 'b', 'c', 'map:card']);
  await apply([{ type: 'todo.move', id: 'a', horizon: 'later' }, { type: 'todo.move', id: 'map:card', horizon: 'later', index: 0 }]);
  assert.deepEqual(await ids(), { inbox: [], next: ['b', 'c'], later: ['map:card', 'a'], done: [] });
  let state = await control.read();
  assert.equal(state.nodes.find(node => node.id === 'card')!.projectId, 'billing'); assert.deepEqual(state.todos.find(todo => todo.id === 'a')!.nodeIds, ['billing']);
  assert.equal(todoList(state).later[1].projectId, 'billing');
  await apply([{ type: 'todo.move', id: 'c', horizon: 'next', index: 0 }, { type: 'todo.move', id: 'a', horizon: 'next', index: 1 }]);
  assert.deepEqual((await ids()).next, ['c', 'a', 'b']);
  state = await control.read();
  assert.ok(state.todos.every(todo => todo.horizon === 'next'));
  await assert.rejects(apply([{ type: 'todo.move', id: 'gone', horizon: 'next' }]), /no longer available/);
});

test('done keeps the horizon to return to; reopening without a position returns the row where it was', async () => {
  const { control, apply, ids } = await fixture();
  await apply([{ type: 'todo.move', id: 'b', horizon: 'done' }, { type: 'todo.move', id: 'map:card', horizon: 'done' }]);
  let state = await control.read();
  const now = await ids();
  assert.deepEqual([now.next, now.later, now.done.sort()], [['a', 'c'], [], ['b', 'map:card']]);
  assert.ok(state.todos.find(todo => todo.id === 'b')!.doneAt); assert.ok(state.nodes.find(node => node.id === 'card')!.completedAt, 'a map to-do completes like Mark done');
  await apply([{ type: 'todo.move', id: 'b', horizon: 'next' }, completeTodo(todoList(await control.read()).done.find(entry => entry.id === 'map:card')!, false)]);
  state = await control.read();
  assert.deepEqual((await ids()).next, ['a', 'b', 'c', 'map:card']);
  assert.equal(state.todos.find(todo => todo.id === 'b')!.doneAt, undefined);
});

test('an item kept in the list is ticked in the list only, never through its provider', async () => {
  const { control, apply } = await fixture();
  await apply([{ type: 'item.add', id: 'ticket', resourceId: 'ticket-r', pluginId: 'linear.ticket', title: 'BIL-1 Ticket', data: { issueId: 'BIL-1' }, position: { x: 900, y: 900 } }, { type: 'node.todo', id: 'ticket', enabled: true }]);
  await apply([{ type: 'todo.move', id: 'map:ticket', horizon: 'done' }]);
  let node = (await control.read()).nodes.find(node => node.id === 'ticket')!;
  assert.equal(node.completedAt, undefined); assert.ok(node.todoDoneAt);
  assert.equal(todoList(await control.read()).done[0].id, 'map:ticket');
  await apply([{ type: 'todo.move', id: 'map:ticket', horizon: 'later' }]);
  node = (await control.read()).nodes.find(node => node.id === 'ticket')!;
  assert.equal(node.todoDoneAt, undefined); assert.equal(node.todoHorizon, 'later');
  await apply([{ type: 'node.complete', id: 'ticket' }]);
  await assert.rejects(apply([{ type: 'todo.move', id: 'map:ticket', horizon: 'next' }]), /done in its provider/);
  await apply([{ type: 'node.reopen', id: 'ticket' }, { type: 'todo.move', id: 'map:ticket', horizon: 'done' }, { type: 'node.reopen', id: 'ticket' }]);
  assert.equal((await control.read()).nodes.find(node => node.id === 'ticket')!.todoDoneAt, undefined, 'reopening the item reopens its list tick too');
  await apply([{ type: 'node.complete', id: 'ticket' }]);
  await apply([{ type: 'todo.move', id: 'map:ticket', horizon: 'done' }, { type: 'node.todo', id: 'ticket', enabled: false }]);
  assert.equal((await control.read()).nodes.find(node => node.id === 'ticket')!.todoDoneAt, undefined, 'leaving the list forgets a list-only tick');
});

test('a person touching a row stamps it; provider and system writes do not', async () => {
  const { control, apply, as } = await fixture();
  const touched = async (id: string) => { const state = await control.read(); return id.startsWith('map:') ? state.nodes.find(node => `map:${node.id}` === id)!.todoTouchedAt : state.todos.find(todo => todo.id === id)!.touchedAt; };
  assert.ok(await touched('a'), 'a new to-do is touched when it is made');
  await as({ kind: 'provider', id: 'linear' })([{ type: 'todo.save', todo: { id: 'p', title: 'Imported', completed: false, nodeIds: [], triage: ticket(1), horizon: 'inbox' } }]);
  assert.equal(await touched('p'), undefined);
  await as({ kind: 'system', id: 'providers' })([{ type: 'node.complete', id: 'card' }, { type: 'node.reopen', id: 'card' }]);
  assert.equal(await touched('map:card'), undefined);
  for (const command of [{ type: 'node.update', id: 'card', title: 'Card edited' }, { type: 'todo.context', id: 'map:card', context: 'Why', mode: 'replace' }, { type: 'todo.move', id: 'map:card', horizon: 'later' }, { type: 'node.complete', id: 'card' }] as WorkspaceCommand[]) {
    const before = await touched('map:card'); await new Promise(resolve => setTimeout(resolve, 5));
    await apply([command]); assert.notEqual(await touched('map:card'), before, command.type);
  }
  const before = await touched('b'); await new Promise(resolve => setTimeout(resolve, 5));
  await apply([{ type: 'todos.reorder', scope: 'items', ids: ['c', 'b'] }]);
  assert.equal(await touched('b'), before, 'a reorder of others is not a touch');
});

test('agents file into Later with todo.save; a save without a horizon keeps it, and only an import can wait in the inbox', async () => {
  const { control, apply, as, ids } = await fixture();
  const agent = as({ kind: 'agent', id: 'agent-1' });
  await agent([{ type: 'todo.save', todo: { id: 'filed', title: 'Look at flaky test', completed: false, nodeIds: [], horizon: 'later' } }]);
  await apply([{ type: 'todo.save', todo: { id: 'filed', title: 'Look at the flaky test', completed: false, nodeIds: [] } }]);
  assert.deepEqual((await ids()).later, ['filed']);
  assert.equal((await control.read()).todos.find(todo => todo.id === 'filed')!.horizon, 'later');
  await assert.rejects(agent([{ type: 'todo.save', todo: { id: 'sneaky', title: 'Inbox', completed: false, nodeIds: [], horizon: 'inbox' } }]), /inbox/i);
});

test('an inbox ticket is taken by moving it, hidden by Not for me and shown again by undoing it', async () => {
  const { control, apply, as, ids } = await fixture();
  await as({ kind: 'provider', id: 'linear' })([1, 2, 3].map(number => ({ type: 'todo.save', todo: { id: `t${number}`, title: `Ticket ${number}`, completed: false, nodeIds: [], triage: ticket(number) } })));
  assert.deepEqual((await ids()).inbox, ['t1', 't2', 't3'], 'an import without a horizon waits in the inbox');
  await apply([{ type: 'todo.move', id: 't2', horizon: 'later', index: 0 }, { type: 'todo.dismiss', id: 't3', dismissed: true }]);
  assert.deepEqual(await ids(), { inbox: ['t1'], next: ['a', 'b', 'c', 'map:card'], later: ['t2'], done: [] });
  const state = await control.read(), dismissed = state.todos.find(todo => todo.id === 't3')!;
  assert.equal(dismissed.dismissed?.title, 'Ticket 3'); assert.equal(dismissed.dismissed?.status, 'Todo');
  assert.deepEqual(state.todos.find(todo => todo.id === 't2')!.triage, ticket(2), 'a taken ticket keeps its pending attachment');
  await apply([{ type: 'todo.dismiss', id: 't3', dismissed: false }]);
  assert.deepEqual((await ids()).inbox, ['t1', 't3']);
  await assert.rejects(apply([{ type: 'todo.dismiss', id: 't2', dismissed: true }]), /inbox/);
  await apply([{ type: 'todo.move', id: 't1', horizon: 'done' }]);
  assert.deepEqual((await ids()).done, ['t1'], 'ticking an inbox ticket takes it');
});

test('a reorder stays inside one group, also for a subgroup of it', async () => {
  const { control, apply, ids } = await fixture();
  await apply([{ type: 'todos.reorder', scope: 'items', ids: ['c', 'a'] }]);
  assert.deepEqual((await ids()).next, ['c', 'b', 'a', 'map:card']);
  await apply([{ type: 'todo.move', id: 'b', horizon: 'later' }]);
  await assert.rejects(apply([{ type: 'todos.reorder', scope: 'items', ids: ['b', 'c'] }]), /within one group/);
  assert.ok((await control.read()).todos.every(todo => todo.todoOrder !== undefined));
});

test('a placed ticket to-do keeps its horizon and remembers the ticket item it brought', async () => {
  const { control, apply, as } = await fixture();
  await as({ kind: 'provider', id: 'linear' })([{ type: 'todo.save', todo: { id: 't1', title: 'Ticket 1', completed: false, nodeIds: [], triage: ticket(1) } }]);
  await apply([{ type: 'todo.move', id: 't1', horizon: 'later' }, { type: 'todo.send', id: 't1', projectId: 'billing', nodeId: 'placed', resourceId: 'placed-r' }]);
  const node = (await control.read()).nodes.find(node => node.id === 'placed')!;
  assert.equal(node.todoHorizon, 'later'); assert.equal(node.todoTicketId, 'placed:item'); assert.ok(node.todoTouchedAt);
});
