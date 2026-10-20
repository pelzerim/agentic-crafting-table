import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore, TODO_CONTEXT_LIMIT, WorkspaceControl, commandSchema } from './control.ts';
import type { WorkspaceCommand } from './control.ts';
import { groupWorkspaceTodos, todoContext } from '../../src/graph/todos.ts';
import { completeTodo, contextTodo, renameTodo, sendTodo } from './todos.ts';

const user = { kind: 'user' as const, id: 'desktop' }, agent = { kind: 'agent' as const, id: 'agent' };
async function fixture() {
  const control = new WorkspaceControl(new MemoryStore());
  const apply = async (commands: WorkspaceCommand[], actor: { kind: 'user' | 'agent'; id: string } = user, commandId: string = crypto.randomUUID()) =>
    (await control.dispatch({ commandId, expectedRevision: (await control.read()).revision, actor, commands })).state;
  await apply([
    { type: 'project.create', id: 'billing', title: 'Billing', summary: '', position: { x: 0, y: 0 } },
    { type: 'item.add', id: 'agent', resourceId: 'agent-r', pluginId: 'agent.session', title: 'Pricing agent', data: { sessionId: 'not-running', provider: 'claude' }, projectId: 'billing', position: { x: 0, y: 0 } },
    { type: 'item.add', id: 'task', resourceId: 'task-r', pluginId: 'workspace.todo', title: 'Check billing flows', data: {}, projectId: 'billing', position: { x: 600, y: 0 } },
    { type: 'todo.save', todo: { id: 'check', title: 'Review implementation', completed: false, nodeIds: [] } },
  ]);
  return { control, apply };
}
const entryOf = (state: Parameters<typeof groupWorkspaceTodos>[0], id: string) => groupWorkspaceTodos(state).flatMap(group => group.items).find(entry => entry.id === id)!;

test('an agent creates a to-do with context, stamped with the agent and the time', async () => {
  const { apply } = await fixture(), before = Date.now();
  const state = await apply([{ type: 'todo.save', todo: { id: 'new', title: 'Migrate invoices', completed: false, nodeIds: [], context: 'Reasoning: the old table is frozen.\n\nNext: run the backfill.' } }], agent);
  const todo = state.todos.find(todo => todo.id === 'new')!;
  assert.equal(todo.context, 'Reasoning: the old table is frozen.\n\nNext: run the backfill.');
  assert.deepEqual(todo.contextBy, { kind: 'agent', id: 'agent', title: 'Pricing agent' });
  assert.ok(Date.parse(todo.contextAt!) >= before);
  assert.deepEqual(entryOf(state, 'new').context, { text: todo.context, by: todo.contextBy, at: todo.contextAt });
  assert.deepEqual(todoContext(state, 'new'), entryOf(state, 'new').context);
});

test('a to-do without context reads as none, and a caller cannot set the writer', async () => {
  const { apply } = await fixture();
  let state = await apply([{ type: 'todo.save', todo: { id: 'plain', title: 'Plain', completed: false, nodeIds: [], context: '  \n ' } }]);
  const { todoOrder: _order, touchedAt: _touched, ...plain } = state.todos.find(todo => todo.id === 'plain')!;
  assert.deepEqual(plain, { id: 'plain', title: 'Plain', completed: false, nodeIds: [], horizon: 'next' });
  assert.equal(entryOf(state, 'plain').context, undefined); assert.equal(todoContext(state, 'plain'), undefined);
  const forged = commandSchema.parse({ type: 'todo.save', todo: { id: 'forged', title: 'Forged', context: 'Text', contextBy: { kind: 'user', id: 'someone' }, contextAt: '2020-01-01T00:00:00.000Z' } });
  state = await apply([forged], agent);
  const todo = state.todos.find(todo => todo.id === 'forged')!;
  assert.deepEqual(todo.contextBy, { kind: 'agent', id: 'agent', title: 'Pricing agent' }); assert.notEqual(todo.contextAt, '2020-01-01T00:00:00.000Z');
});

test('replace overwrites, append adds after a blank line, and an empty replace clears', async () => {
  const { apply } = await fixture();
  let state = await apply([{ type: 'todo.context', id: 'check', context: 'First finding.', mode: 'append' }], agent);
  assert.equal(state.todos[0].context, 'First finding.');
  state = await apply([{ type: 'todo.context', id: 'check', context: 'Second finding.', mode: 'append' }], agent);
  assert.equal(state.todos[0].context, 'First finding.\n\nSecond finding.');
  state = await apply([{ type: 'todo.context', id: 'check', context: 'Summary only.', mode: 'replace' }]);
  assert.equal(state.todos[0].context, 'Summary only.'); assert.deepEqual(state.todos[0].contextBy, { kind: 'user', id: 'desktop' });
  const kept = state.todos[0].contextAt;
  state = await apply([{ type: 'todo.context', id: 'check', context: 'Summary only.', mode: 'replace' }], agent);
  assert.deepEqual([state.todos[0].contextBy, state.todos[0].contextAt], [{ kind: 'user', id: 'desktop' }, kept], 'unchanged text keeps its writer');
  state = await apply([{ type: 'todo.context', id: 'check', context: '', mode: 'append' }], agent);
  assert.equal(state.todos[0].context, 'Summary only.');
  state = await apply([{ type: 'todo.context', id: 'check', context: '', mode: 'replace' }]);
  const { todoOrder: _order, touchedAt: _touched, ...cleared } = state.todos[0];
  assert.deepEqual(cleared, { id: 'check', title: 'Review implementation', completed: false, nodeIds: [], horizon: 'next' });
});

test('the limit is 8,000 characters: an append past it is refused with the numbers and changes nothing', async () => {
  const { control, apply } = await fixture();
  assert.equal(TODO_CONTEXT_LIMIT, 8000);
  let state = await apply([{ type: 'todo.context', id: 'check', context: 'a'.repeat(7990), mode: 'replace' }]);
  await assert.rejects(apply([{ type: 'todo.context', id: 'check', context: 'b'.repeat(20), mode: 'append' }], agent), /would be 8,012 characters; the limit is 8,000/);
  assert.deepEqual(await control.read(), state);
  state = await apply([{ type: 'todo.context', id: 'check', context: 'b'.repeat(8), mode: 'append' }], agent);
  assert.equal(state.todos[0].context!.length, 8000);
  assert.equal(commandSchema.safeParse({ type: 'todo.context', id: 'check', context: 'c'.repeat(8001), mode: 'replace' }).success, false);
  assert.equal(commandSchema.safeParse({ type: 'todo.save', todo: { id: 'long', title: 'Long', context: 'c'.repeat(8001) } }).success, false);
  assert.equal(commandSchema.safeParse({ type: 'todo.context', id: 'check', context: 'c' }).success, false, 'mode is required');
});

test('control characters are removed; line breaks, tabs and markup stay as text', async () => {
  const { apply } = await fixture();
  const state = await apply([{ type: 'todo.context', id: 'check', context: '  # Plan\r\n\tstep\u0000 one\u001b[31m\u0007\r<script>alert(1)</script>\u009b  ', mode: 'replace' }], agent);
  assert.equal(state.todos[0].context, '# Plan\n\tstep one[31m\n<script>alert(1)</script>');
});

test('context survives renaming, completion, reordering, archiving and the removal of the agent that wrote it', async () => {
  const { apply } = await fixture();
  let state = await apply([{ type: 'todo.context', id: 'check', context: 'Why: billing is blocked on this.', mode: 'replace' }, { type: 'todo.save', todo: { id: 'other', title: 'Other', completed: false, nodeIds: ['agent'] } }], agent);
  const written = todoContext(state, 'check')!;
  state = await apply([renameTodo(entryOf(state, 'check'), 'Review the implementation')]);
  state = await apply([completeTodo(entryOf(state, 'check'), true)]);
  state = await apply([{ type: 'todos.reorder', scope: 'items', ids: ['check'] }]);
  assert.deepEqual(todoContext(state, 'check'), written);
  assert.equal(state.todos.find(todo => todo.id === 'check')!.completed, true);
  state = await apply([{ type: 'todo.archive', id: 'check' }]);
  assert.deepEqual(todoContext(state, 'check'), written);
  state = await apply([{ type: 'todo.context', id: 'check', context: 'Added while archived.', mode: 'append' }, { type: 'todo.restore', id: 'check' }]);
  state = await apply([{ type: 'todo.context', id: 'check', context: written.text, mode: 'replace' }], agent);
  state = await apply([{ type: 'node.archive', id: 'agent' }]);
  state = await apply([{ type: 'node.delete', id: 'agent' }]);
  assert.equal(state.nodes.some(node => node.id === 'agent'), false);
  assert.equal(todoContext(state, 'check')!.text, written.text);
  assert.deepEqual(todoContext(state, 'check')!.by, { kind: 'agent', id: 'agent', title: 'Pricing agent' });
});

test('a map to-do keeps its context on its node, addressed as map:<nodeId>', async () => {
  const { apply } = await fixture();
  let state = await apply([{ type: 'todo.context', id: 'map:task', context: 'See https://example.com/runbook', mode: 'replace' }], agent);
  const node = state.nodes.find(node => node.id === 'task')!;
  assert.equal(node.todoContext, 'See https://example.com/runbook'); assert.deepEqual(node.todoContextBy, { kind: 'agent', id: 'agent', title: 'Pricing agent' }); assert.ok(node.todoContextAt);
  assert.deepEqual(entryOf(state, 'map:task').context, { text: node.todoContext, by: node.todoContextBy, at: node.todoContextAt });
  state = await apply([{ type: 'node.complete', id: 'task' }, { type: 'node.update', id: 'task', title: 'Check all billing flows' }]);
  state = await apply([{ type: 'todo.context', id: 'map:task', context: 'Done on staging.', mode: 'append' }]);
  assert.equal(todoContext(state, 'map:task')!.text, 'See https://example.com/runbook\n\nDone on staging.');
  await assert.rejects(apply([{ type: 'todo.context', id: 'map:agent', context: 'No', mode: 'replace' }]), /not a to-do/);
  await assert.rejects(apply([{ type: 'todo.context', id: 'missing', context: 'No', mode: 'replace' }]), /no longer available/);
  await assert.rejects(apply([{ type: 'todo.context', id: 'task', context: 'No', mode: 'replace' }]), /no longer available/);
});

test('a list-only to-do sent to a project takes its context, writer and time to the map to-do', async () => {
  const { apply } = await fixture();
  let state = await apply([{ type: 'todo.context', id: 'check', context: 'Carry me along.', mode: 'replace' }], agent);
  const written = todoContext(state, 'check')!;
  state = await apply([sendTodo(entryOf(state, 'check'), 'billing', { nodeId: 'sent', resourceId: 'sent-r' })]);
  assert.equal(state.todos.length, 0);
  assert.deepEqual(todoContext(state, 'map:sent'), written);
  assert.deepEqual(entryOf(state, 'map:sent').context, written);
  state = await apply([{ type: 'project.create', id: 'docs', title: 'Docs', summary: '', position: { x: 3000, y: 0 } }]);
  state = await apply([{ type: 'todo.send', id: 'map:sent', projectId: 'docs' }]);
  assert.equal(state.nodes.find(node => node.id === 'sent')!.projectId, 'docs'); assert.deepEqual(todoContext(state, 'map:sent'), written);
});

test('the list helper writes context through the shared command for either kind', async () => {
  const { apply } = await fixture();
  const state = await apply([{ type: 'todo.save', todo: { id: 'plain', title: 'Plain', completed: false, nodeIds: [] } }]);
  assert.deepEqual(contextTodo(entryOf(state, 'plain'), 'Text'), { type: 'todo.context', id: 'plain', context: 'Text', mode: 'replace' });
  assert.deepEqual(contextTodo(entryOf(state, 'map:task'), ''), { type: 'todo.context', id: 'map:task', context: '', mode: 'replace' });
});

test('a retry with the same commandId replays the first result instead of appending or stamping again', async () => {
  const { control, apply } = await fixture();
  const envelope = { commandId: 'append-once', expectedRevision: (await control.read()).revision, actor: agent, commands: [{ type: 'todo.context' as const, id: 'check', context: 'Only once.', mode: 'append' as const }] };
  const first = await control.dispatch(envelope);
  await apply([{ type: 'todo.save', todo: { id: 'later', title: 'Later', completed: false, nodeIds: [] } }]);
  const again = await control.dispatch(envelope);
  assert.equal(again.replayed, true); assert.deepEqual(again.state.todos[0], first.state.todos[0]);
  assert.equal((await control.read()).todos.find(todo => todo.id === 'check')!.context, 'Only once.');
});
