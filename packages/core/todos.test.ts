import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkspaceControl } from './control.ts';
import type { WorkspaceCommand } from './control.ts';
import { MemoryStore } from './control.ts';
import { groupWorkspaceTodos } from '../../src/graph/todos.ts';
import { attachTodo, completeTodo, detachTodo, renameTodo } from './todos.ts';
import { registryWithSinglePartner, singlePartner } from '../../tests/fixtures/single-partner.ts';

test('overlay attachments and completion reuse map records and shared one-partner relationship validation', async () => {
  const control = new WorkspaceControl(new MemoryStore(), registryWithSinglePartner());
  const apply = async (commands: WorkspaceCommand[]) => control.dispatch({ commandId: crypto.randomUUID(), expectedRevision: (await control.read()).revision, actor: { kind: 'user', id: 'test' }, commands });
  await apply([
    { type: 'project.create', id: 'p', title: 'Work', summary: '', position: { x: 0, y: 0 } },
    { type: 'item.add', id: 'task', resourceId: 'task-r', pluginId: 'workspace.todo', title: 'Check results', data: {}, projectId: 'p', position: { x: 200, y: 0 } },
    { type: 'item.add', id: 'device', resourceId: 'device-r', pluginId: singlePartner.id, title: 'Build host', data: { deviceId: 'box' }, position: { x: 500, y: 0 } },
  ]);
  let state = await control.read();
  const task = groupWorkspaceTodos(state)[0].items[0];
  assert.deepEqual(attachTodo(state, undefined, 'task', 'unused'), [], 'dragging a map task onto its own list creates no duplicate');
  await apply(attachTodo(state, task, 'device', 'link'));
  state = await control.read();
  const linked = groupWorkspaceTodos(state)[0].items[0];
  assert.deepEqual(linked.nodeIds, ['device']);
  await assert.rejects(apply([{ type: 'link.save', link: { id: 'occupied', sourceId: 'device', targetId: 'p', kind: 'reference', label: '' } }]), /one|already|single/i);
  await apply([completeTodo(linked, true)]);
  state = await control.read(); assert.ok(state.nodes.find(n => n.id === 'task')!.completedAt); assert.equal(state.todos.length, 0);
  await apply(detachTodo(state, linked, 'device')); assert.equal((await control.read()).links.length, 0);
  await apply(attachTodo(await control.read(), undefined, 'p', 'checklist'));
  state = await control.read(); assert.equal(groupWorkspaceTodos(state)[0].items[0].id, 'checklist');
  await apply(attachTodo(state, groupWorkspaceTodos(state)[0].items[0], 'p', 'duplicate'));
  assert.deepEqual((await control.read()).todos[0].nodeIds, ['p']);
  await apply([{ type: 'node.archive', id: 'p' }, { type: 'node.delete', id: 'p' }]);
  assert.equal(groupWorkspaceTodos(await control.read())[0].title, 'No project');
});


test('title edits preserve map identity and checklist links/completion through shared validation', async () => {
  const control = new WorkspaceControl(new MemoryStore());
  const apply = async (commands: WorkspaceCommand[]) => control.dispatch({ commandId: crypto.randomUUID(), expectedRevision: (await control.read()).revision, actor: { kind: 'user', id: 'fixture' }, commands });
  await apply([
    { type: 'item.add', id: 'task', resourceId: 'task-r', pluginId: 'workspace.todo', title: 'Original', data: { notes: 'Keep notes' }, position: { x: 200, y: 100 } },
    { type: 'todo.save', todo: { id: 'list', title: 'List title', completed: true, nodeIds: ['task'] } },
  ]);
  const before = await control.read();
  for (const entry of groupWorkspaceTodos(before)[0].items) await apply([renameTodo(entry, '  Updated ' + entry.title + '  ')]);
  const after = await control.read();
  assert.ok(after.nodes[0].todoTouchedAt && after.todos[0].touchedAt, 'an edit is a touch');
  assert.deepEqual(after.nodes, before.nodes.map(node => ({ ...node, title: 'Updated Original', todoTouchedAt: after.nodes[0].todoTouchedAt })));
  assert.deepEqual(after.resources, before.resources.map(resource => ({ ...resource, title: 'Updated Original' })));
  assert.deepEqual(after.todos, [{ ...before.todos[0], title: 'Updated List title', touchedAt: after.todos[0].touchedAt }]);
  for (const entry of groupWorkspaceTodos(after)[0].items) await assert.rejects(apply([renameTodo(entry, ' ')]));
  assert.deepEqual(await control.read(), after);
});

test('Linear task membership and manual row/group order survive edits, archive and SQLite reload', async () => {
  const { SqliteStore } = await import('../workspace-service/sqlite-store.ts');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const directory = await mkdtemp(join(tmpdir(), 'craft-task-order-'));
  let store = new SqliteStore(join(directory, 'workspace.sqlite')), control = new WorkspaceControl(store);
  const apply = async (commands: WorkspaceCommand[]) => control.dispatch({ commandId: crypto.randomUUID(), expectedRevision: (await control.read()).revision, actor: { kind: 'user', id: 'fixture' }, commands });
  try {
    await apply([
      { type: 'project.create', id: 'p', title: 'First', position: { x: 0, y: 0 }, summary: '' },
      { type: 'project.create', id: 'q', title: 'Second', position: { x: 1500, y: 0 }, summary: '' },
      { type: 'item.add', id: 'ticket', resourceId: 'ticket-r', pluginId: 'linear.ticket', title: 'Ticket title', projectId: 'p', position: { x: 500, y: 0 }, data: { issueId: 'BIL-128' } },
      { type: 'item.add', id: 'task', resourceId: 'task-r', pluginId: 'workspace.todo', title: 'Task', projectId: 'q', position: { x: 1500, y: 200 }, data: {} },
      { type: 'todo.save', todo: { id: 'check', title: 'Checklist', completed: false, nodeIds: ['p'] } },
      { type: 'node.todo', id: 'ticket', enabled: true },
    ]);
    const initial = await control.read();
    const entry = groupWorkspaceTodos(initial)[0].items.find(item => item.nodeId === 'ticket')!;
    assert.equal(entry.providerTask, true); assert.equal(initial.todos.length, 1);
    await apply([{ type: 'todos.reorder', scope: 'projects', ids: ['q', 'p'] }, { type: 'todos.reorder', scope: 'items', ids: ['map:ticket', 'check'] }, completeTodo(entry, true)]);
    await apply([renameTodo(groupWorkspaceTodos(await control.read())[1].items[1], 'Edited checklist')]);
    await apply([{ type: 'node.update', id: 'ticket', title: 'Provider refresh' }, { type: 'node.archive', id: 'ticket' }]);
    assert.deepEqual(groupWorkspaceTodos(await control.read())[1].items.map(item => item.id), ['check']);
    await apply([{ type: 'node.restore', id: 'ticket' }]);
    store.close(); store = new SqliteStore(join(directory, 'workspace.sqlite')); control = new WorkspaceControl(store);
    const restored = await control.read(), groups = groupWorkspaceTodos(restored);
    assert.deepEqual(groups.map(group => group.projectId), ['q', 'p']);
    assert.deepEqual(groups[1].items.map(item => item.id), ['map:ticket', 'check']);
    assert.equal(groups[1].items[0].title, 'Provider refresh'); assert.equal(groups[1].items[0].completed, true);
    assert.equal(restored.resources[0].pluginId, initial.resources[0].pluginId);
    await assert.rejects(apply([{ type: 'todos.reorder', scope: 'items', ids: ['map:ticket', 'map:task'] }]), /within one group/, 'a done row and an open one are in different groups');
    await assert.rejects(apply([{ type: 'todos.reorder', scope: 'projects', ids: ['p', 'p'] }]), /Duplicate/);
    await assert.rejects(apply([{ type: 'node.todo', id: 'p', enabled: true }]), /cannot/);
    await apply([{ type: 'node.todo', id: 'ticket', enabled: false }]);
    assert.equal(groupWorkspaceTodos(await control.read())[1].items.length, 1);
    assert.equal((await control.read()).nodes.find(node => node.id === 'ticket')?.completedAt, restored.nodes.find(node => node.id === 'ticket')?.completedAt);
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('a checklist to-do records when it was done; edits keep it, reopening clears it, and a caller cannot set it', async () => {
  const control = new WorkspaceControl(new MemoryStore());
  const apply = async (commands: WorkspaceCommand[]) => (await control.dispatch({ commandId: crypto.randomUUID(), expectedRevision: (await control.read()).revision, actor: { kind: 'user', id: 'fixture' }, commands })).state;
  let state = await apply([{ type: 'todo.save', todo: { id: 'list', title: 'Write the report', completed: false, nodeIds: [] } }]);
  assert.equal(state.todos[0].doneAt, undefined);
  state = await apply([{ type: 'todo.save', todo: { id: 'list', title: 'Write the report', completed: true, nodeIds: [] } }]);
  const doneAt = state.todos[0].doneAt!; assert.ok(Date.parse(doneAt) <= Date.now());
  state = await apply([{ type: 'todo.save', todo: { id: 'list', title: 'Write the standup report', completed: true, nodeIds: [] } }]);
  assert.equal(state.todos[0].doneAt, doneAt);
  state = await apply([{ type: 'todo.save', todo: { id: 'list', title: 'Write the standup report', completed: false, nodeIds: [] } }]);
  assert.equal(state.todos[0].doneAt, undefined);
  state = await apply([{ type: 'todo.save', todo: { id: 'list', title: 'Write the standup report', completed: true, nodeIds: [], doneAt: '2020-01-01T00:00:00.000Z' } as never }]);
  assert.notEqual(state.todos[0].doneAt, '2020-01-01T00:00:00.000Z');
});
