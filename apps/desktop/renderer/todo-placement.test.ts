import test from 'node:test';
import assert from 'node:assert/strict';
import { createResourcePluginRegistry } from '../../../src/resource-plugins/builtins.ts';
import { reduceCommands, stateSchema } from '../../../packages/core/control.ts';
import type { WorkspaceState } from '../../../packages/core/control.ts';
import { moveTodo } from '../../../packages/core/todos.ts';
import { todoList } from '../../../src/graph/todos.ts';
import type { TodoList } from '../../../src/graph/todos.ts';
import { placeRows, placementFor } from './todo-placement.ts';

const workspace = (): WorkspaceState => stateSchema.parse({ version: 1, revision: 1, view: { camera: { x: 0, y: 0, zoom: 1 } }, nodes: [], resources: [], links: [], todos: [
  ...['a', 'b', 'c', 'd'].map((id, index) => ({ id, title: id, completed: false, nodeIds: [], horizon: 'next', todoOrder: index })),
  ...['e', 'f'].map((id, index) => ({ id, title: id, completed: false, nodeIds: [], horizon: 'later', todoOrder: index })),
  { id: 'g', title: 'g', completed: true, nodeIds: [], horizon: 'next', todoOrder: 9, doneAt: '2026-10-01T00:00:00.000Z' },
  { id: 'h', title: 'h', completed: false, nodeIds: [], horizon: 'inbox', todoOrder: 0, triage: { source: 'linear', key: 'h', label: 'APP-1', item: { pluginId: 'linear.ticket', title: 'h', data: {} } } },
] });
const ids = (list: TodoList) => Object.fromEntries((['inbox', 'next', 'later', 'done'] as const).map(group => [group, list[group].map(entry => entry.id)]));
const registry = createResourcePluginRegistry();

test('a pending move shows where its save will file the row', () => {
  // Each case: the move, then the same move through the reducer; the list shown before the save matches the one after it.
  const cases: [string, 'next' | 'later' | 'done', number | undefined][] = [
    ['d', 'next', 0], ['a', 'next', 3], ['b', 'later', 1], ['e', 'next', undefined], ['h', 'later', undefined], ['c', 'done', undefined], ['g', 'next', undefined], ['g', 'later', 0], ['f', 'later', undefined],
  ];
  for (const [id, group, index] of cases) {
    const before = workspace(), list = todoList(before), entry = [...list.inbox, ...list.next, ...list.later, ...list.done].find(row => row.id === id)!;
    const shown = placeRows(list, [placementFor(list, entry, group, index)]);
    const saved = todoList(reduceCommands(before, [moveTodo(entry, group, index)], before.revision, registry, undefined, { kind: 'user', id: 'test' }));
    assert.deepEqual(ids(shown), ids(saved), `${id} → ${group}${index === undefined ? '' : ` @${index}`}`);
    assert.equal(shown.done.some(row => row.id === id), group === 'done', 'a row in Done shows ticked, and one moved out of it unticked');
  }
});

test('moves queued before their saves land stack, and a move that already landed shows once', () => {
  let state = workspace(); const pending = [];
  for (let press = 0; press < 3; press++) {
    const list = placeRows(todoList(state), pending), at = list.next.findIndex(row => row.id === 'd');
    pending.push(placementFor(list, list.next[at], 'next', at - 1));
  }
  assert.deepEqual(placeRows(todoList(state), pending).next.map(row => row.id), ['d', 'a', 'b', 'c']);
  // The saves land one by one; the list never shows another order on the way.
  for (const [press, index] of [2, 1, 0].entries()) {
    state = reduceCommands(state, [{ type: 'todo.move', id: 'd', horizon: 'next', index }], state.revision, registry);
    assert.deepEqual(placeRows(todoList(state), pending.slice(press)).next.map(row => row.id), ['d', 'a', 'b', 'c']);
    assert.deepEqual(placeRows(todoList(state), pending).next.map(row => row.id), ['d', 'a', 'b', 'c'], 'a landed move is not applied twice');
  }
});

test('a move before a row that has gone files the row last', () => {
  const list = todoList(workspace()), shown = placeRows(list, [{ id: 'a', group: 'later', at: { before: 'missing' } }]);
  assert.deepEqual(shown.later.map(row => row.id), ['e', 'f', 'a']);
  assert.deepEqual(placeRows(list, [{ id: 'missing', group: 'next', at: 'end' }]), list, 'a move of a row that has gone changes nothing');
});
