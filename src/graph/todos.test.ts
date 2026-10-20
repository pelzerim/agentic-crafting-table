import assert from 'node:assert/strict';
import test from 'node:test';
import { archiveDue, groupWorkspaceTodos, oldestTodo, todoEntries, todoList, untouchedDays, withoutMuted } from './todos.ts';
import type { GraphNode } from './graph.ts';

const nodes: GraphNode[] = [
  { id: 'p1', title: 'Billing', position: { x: 0, y: 0 } },
  { id: 'p2', title: 'Docs', position: { x: 500, y: 0 } },
  { id: 'agent', resourceId: 'agent-r', projectId: 'p1', title: 'Agent', position: { x: 20, y: 0 } },
  { id: 'task', resourceId: 'task-r', projectId: 'p2', title: 'Write example', position: { x: 520, y: 0 } },
  { id: 'floating', resourceId: 'floating-r', title: 'Choose a name', position: { x: 900, y: 0 } },
];
const state = {
  nodes,
  resources: [{ id: 'task-r', pluginId: 'workspace.todo' }, { id: 'floating-r', pluginId: 'workspace.todo' }],
  links: [{ id: 'context', sourceId: 'task', targetId: 'agent', kind: 'context' as const, label: 'Context' }],
  todos: [
    { id: 't1', title: 'Review billing', completed: false, nodeIds: ['p1', 'agent'] },
    { id: 't2', title: 'Across projects', completed: false, nodeIds: ['p1', 'p2'] },
    { id: 't3', title: 'Unattached', completed: false, nodeIds: [] },
  ],
};

test('map membership wins over links; checklist entries use only an unambiguous linked project', () => {
  const groups = groupWorkspaceTodos(state);
  assert.deepEqual(groups.map(group => [group.title, group.items.map(item => item.id)]), [
    ['Billing', ['t1']], ['Docs', ['map:task']], ['No project', ['t2', 't3', 'map:floating']],
  ]);
  assert.deepEqual(groups[1].items[0].nodeIds, ['agent']);
});

test('moving and completing a map task updates its group without copying or changing checklist tasks', () => {
  const updated = { ...state, nodes: nodes.map(n => n.id === 'task' ? { ...n, projectId: 'p1', completedAt: '2026-09-24T10:00:00Z' } : n) };
  const groups = groupWorkspaceTodos(updated);
  const task = groups[0].items.find(item => item.nodeId === 'task')!;
  assert.equal(task.completed, true);
  assert.equal(groups.some(group => group.projectId === 'p2'), false);
  assert.equal(state.todos[0].completed, false);
  assert.equal(state.nodes.find(n => n.id === 'task')?.projectId, 'p2');
});

test('archived map tasks stay out of the active list and missing project references remain ungrouped', () => {
  const groups = groupWorkspaceTodos({ ...state, nodes: nodes.filter(n => n.id !== 'p1').map(n => n.id === 'p2' ? { ...n, archivedAt: '2026-09-24T10:00:00Z' } : n) });
  assert.equal(groups.some(group => group.items.some(item => item.nodeId === 'task')), false);
  assert.equal(groups.find(group => !group.projectId)?.items.some(item => item.id === 't1'), true);
});

test('map tasks in Undermap, directly or through their project, leave the list until they return', () => {
  const at = '2026-09-29T10:00:00Z';
  const direct = groupWorkspaceTodos({ ...state, nodes: nodes.map(n => n.id === 'floating' ? { ...n, belowAt: at } : n) });
  assert.equal(direct.some(group => group.items.some(item => item.nodeId === 'floating')), false);
  const project = groupWorkspaceTodos({ ...state, nodes: nodes.map(n => n.id === 'p2' ? { ...n, belowAt: at } : n) });
  assert.equal(project.some(group => group.items.some(item => item.nodeId === 'task')), false);
  assert.equal(project.flatMap(group => group.items).some(item => item.id === 't2'), true, 'checklist to-dos stay');
});

test('tickets waiting in the inbox form the first group, whatever they are attached to, and only while any exist; taken ones join their project', () => {
  const triage = (key: string) => ({ source: 'linear', key, label: key.toUpperCase(), url: `https://linear.app/fixture/issue/${key}`, item: { pluginId: 'linear.ticket', connectionId: 'c', title: key, data: { issueId: key } } });
  const groups = groupWorkspaceTodos({ ...state, todos: [...state.todos,
    { id: 'i1', title: 'BIL-1 First', completed: false, nodeIds: [], triage: triage('bil-1'), todoOrder: 1, horizon: 'inbox' as const },
    { id: 'i2', title: 'BIL-2 Second', completed: false, nodeIds: ['agent'], triage: triage('bil-2'), todoOrder: 0, horizon: 'inbox' as const },
    { id: 'i3', title: 'BIL-3 Archived', completed: false, nodeIds: [], triage: triage('bil-3'), archivedAt: '2026-09-29T10:00:00Z', horizon: 'inbox' as const },
    { id: 'i4', title: 'BIL-4 Taken', completed: false, nodeIds: [], triage: triage('bil-4'), todoOrder: 5, horizon: 'next' as const },
  ] });
  assert.deepEqual(groups.map(group => [group.title, group.triage ?? false, group.projectId, group.items.map(item => item.id)]), [
    ['Triage', true, undefined, ['i2', 'i1']], ['Billing', false, 'p1', ['t1']], ['Docs', false, 'p2', ['map:task']], ['No project', false, undefined, ['i4', 't2', 't3', 'map:floating']],
  ]);
  assert.deepEqual(groups[0].items[1].triage, { source: 'linear', key: 'bil-1', label: 'BIL-1', url: 'https://linear.app/fixture/issue/bil-1' });
  assert.equal(groups[0].items[0].projectId, undefined);
  assert.equal(groupWorkspaceTodos(state).some(group => group.triage), false);
});

test('the list sorts by when, not where: inbox, Next and Later in their order, Done newest first', () => {
  const triage = (key: string) => ({ source: 'linear', key, label: key.toUpperCase(), item: { pluginId: 'linear.ticket', title: key, data: { issueId: key } } });
  const list = todoList({ ...state,
    nodes: nodes.map(n => n.id === 'task' ? { ...n, todoHorizon: 'later' as const, todoOrder: 0 } : n.id === 'floating' ? { ...n, completedAt: '2026-10-01T10:00:00.000Z' } : n),
    todos: [
      { id: 't1', title: 'Review billing', completed: false, nodeIds: ['p1'], horizon: 'next' as const, todoOrder: 1 },
      { id: 't2', title: 'Plan', completed: false, nodeIds: [], todoOrder: 0 },
      { id: 't3', title: 'Old', completed: true, nodeIds: [], doneAt: '2026-10-03T10:00:00.000Z' },
      { id: 'i1', title: 'First', completed: false, nodeIds: [], horizon: 'inbox' as const, triage: triage('bil-1') },
      { id: 'i2', title: 'Hidden', completed: false, nodeIds: [], horizon: 'inbox' as const, triage: triage('bil-2'), dismissed: { at: '2026-10-01T10:00:00.000Z', title: 'Hidden' } },
    ] });
  assert.deepEqual([list.inbox, list.next, list.later, list.done].map(group => group.map(entry => entry.id)), [['i1'], ['t2', 't1'], ['map:task'], ['t3', 'map:floating']]);
  assert.equal(list.next[1].projectId, 'p1', 'the project stays a property of the row');
  assert.equal(todoEntries(state).every(entry => entry.horizon === 'next'), true, 'rows saved before horizons read as Next');
});

test('an item kept in the list ticks there without its provider, and follows the provider when it reports done', () => {
  const kept = { ...state, resources: [...state.resources, { id: 'ticket-r', pluginId: 'linear.ticket' }], nodes: [...nodes, { id: 'ticket', resourceId: 'ticket-r', inTodoList: true, title: 'BIL-1 Ticket', position: { x: 0, y: 900 }, todoDoneAt: '2026-10-02T10:00:00.000Z' }] };
  const entry = todoEntries(kept).find(entry => entry.nodeId === 'ticket')!;
  assert.equal(entry.completed, true); assert.equal(entry.doneAt, '2026-10-02T10:00:00.000Z'); assert.equal(entry.providerDone, undefined);
  const mirrored = todoEntries({ ...kept, nodes: kept.nodes.map(n => n.id === 'ticket' ? { ...n, todoDoneAt: undefined, completedAt: '2026-10-04T10:00:00.000Z' } : n) }).find(entry => entry.nodeId === 'ticket')!;
  assert.equal(mirrored.completed, true); assert.equal(mirrored.providerDone, true);
});

test('Done is due for Archive a number of days after the later of done and touched; Later rows age from their last touch', () => {
  const day = 86_400_000, now = Date.parse('2026-10-12T12:00:00.000Z');
  const done = { completed: true, doneAt: new Date(now - 4 * day).toISOString(), touchedAt: new Date(now - 2 * day).toISOString() };
  assert.equal(archiveDue(done, 3, now), false, 'a touch after ticking restarts the wait');
  assert.equal(archiveDue(done, 1, now), true);
  assert.equal(archiveDue(done, undefined, now), false, 'never');
  assert.equal(archiveDue({ completed: false, touchedAt: new Date(now - 9 * day).toISOString() }, 3, now), false);
  assert.equal(untouchedDays({ touchedAt: new Date(now - 34 * day).toISOString() }, now), 34);
  assert.equal(untouchedDays({}, now), 0, 'a row without a recorded touch has no age');
});

test('the soft limit picks the Next row untouched longest, else the last one', () => {
  const at = (days: number) => new Date(Date.parse('2026-10-12T00:00:00.000Z') - days * 86_400_000).toISOString();
  const rows = ['a', 'b', 'c'].map((id, i) => ({ id, touchedAt: at([3, 9, 1][i]) }));
  assert.equal(oldestTodo(rows)?.id, 'b');
  assert.equal(oldestTodo([{ id: 'x', touchedAt: undefined }, { id: 'y', touchedAt: undefined }])?.id, 'y');
  assert.equal(oldestTodo([]), undefined);
});

test('the list leaves out to-dos of muted projects in every group and keeps the inbox, floating and cross-project rows', () => {
  const muted = { ...state, nodes: [{ ...nodes[0], mutedAt: '2026-10-19T09:00:00.000Z' }, ...nodes.slice(1)],
    todos: [...state.todos, { id: 'done', title: 'Ticked billing', completed: true, nodeIds: ['p1'] }, { id: 'ticket', title: 'Billing ticket', completed: false, nodeIds: ['p1'], horizon: 'inbox' as const }] };
  const list = withoutMuted(todoList(muted), muted.nodes), ids = (rows: { id: string }[]) => rows.map(row => row.id);
  assert.deepEqual(ids(list.next).sort(), ['map:floating', 'map:task', 't2', 't3']);
  assert.deepEqual(ids(list.done), []);
  assert.deepEqual(ids(list.inbox), ['ticket']);
  assert.deepEqual(withoutMuted(todoList(state), state.nodes), todoList(state));
});
