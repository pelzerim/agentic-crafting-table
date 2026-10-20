import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore, WorkspaceControl } from '../core/control.ts';
import type { WorkspaceCommand } from '../core/control.ts';
import { TodoSweeper } from './todo-sweeper.ts';
import todoPlugin from '../../src/resource-plugins/items/todo/plugin.ts';

const DAY = 86_400_000;
async function fixture(setting?: string) {
  const control = new WorkspaceControl(new MemoryStore()), settings: { doneArchiveDays?: string } = setting ? { doneArchiveDays: setting } : {};
  const apply = async (commands: WorkspaceCommand[]) => (await control.dispatch({ commandId: crypto.randomUUID(), expectedRevision: (await control.read()).revision, actor: { kind: 'user', id: 'test' }, commands })).state;
  let now = Date.now(), changes = 0;
  const sweeper = new TodoSweeper(control, () => settings, async () => { changes++; }, () => true, () => now);
  await apply([
    { type: 'item.add', id: 'card', resourceId: 'card-r', pluginId: 'workspace.todo', title: 'Card', data: {}, position: { x: 0, y: 0 } },
    { type: 'item.add', id: 'ticket', resourceId: 'ticket-r', pluginId: 'linear.ticket', title: 'BIL-1 Ticket', data: { issueId: 'BIL-1' }, position: { x: 600, y: 0 } }, { type: 'node.todo', id: 'ticket', enabled: true },
    ...['done', 'open'].map(id => ({ type: 'todo.save' as const, todo: { id, title: id, completed: false, nodeIds: [] } })),
  ]);
  await apply(['done', 'map:card', 'map:ticket'].map(id => ({ type: 'todo.move', id, horizon: 'done' })));
  return { control, apply, sweeper, settings, advance(ms: number) { now += ms; }, changes: () => changes };
}

test('the To-do settings offer 1, 3 or 7 days or never before Done goes to Archive, 3 by default', () => {
  const field = todoPlugin.settings!.fields.doneArchiveDays;
  assert.deepEqual([field.kind, field.options, field.default], ['select', ['1', '3', '7', 'never'], '3']);
  assert.deepEqual(field.optionLabels, { 1: '1 day', 3: '3 days', 7: '7 days', never: 'Never' });
});

test('Done rows go to Archive once their days have passed, the way Archive works from the list', async () => {
  const { control, sweeper, advance, changes } = await fixture();
  advance(2 * DAY); await sweeper.sweep();
  assert.equal(changes(), 0); assert.equal((await control.read()).todos.find(todo => todo.id === 'done')!.archivedAt, undefined);
  advance(DAY + 1000); await sweeper.sweep();
  const state = await control.read();
  assert.ok(state.todos.find(todo => todo.id === 'done')!.archivedAt, 'a list to-do is archived and can be restored');
  assert.ok(state.nodes.find(node => node.id === 'card')!.archivedAt, 'a map to-do is archived like its menu does');
  const ticket = state.nodes.find(node => node.id === 'ticket')!;
  assert.deepEqual([ticket.archivedAt, ticket.inTodoList], [undefined, false], 'a ticket kept in the list only leaves the list');
  assert.equal(state.todos.find(todo => todo.id === 'open')!.archivedAt, undefined);
  assert.equal(changes(), 1);
});

test('Never keeps Done rows, and 1 day is a day', async () => {
  const never = await fixture('never');
  never.advance(30 * DAY); await never.sweeper.sweep(); assert.equal(never.changes(), 0);
  const one = await fixture('1');
  one.advance(DAY / 2); await one.sweeper.sweep(); assert.equal(one.changes(), 0);
  one.advance(DAY / 2 + 1000); await one.sweeper.sweep();
  const state = await one.control.read();
  assert.ok(state.todos.find(todo => todo.id === 'done')!.archivedAt); assert.ok(state.nodes.find(node => node.id === 'card')!.archivedAt);
});
