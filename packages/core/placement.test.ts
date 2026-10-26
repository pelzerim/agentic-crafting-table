import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkspaceControl, MemoryStore, stateSchema, RevisionConflict } from './control.ts';
import { itemFootprint } from '../../src/graph/footprints.ts';
import { overlaps } from '../../src/graph/spatial.ts';
import { layoutFootprints } from '../../src/graph/movement.ts';
import { groupWorkspaceTodos } from '../../src/graph/todos.ts';

test('creation reserves detailed space across plugin sizes without moving existing items', async () => {
  const control = new WorkspaceControl(new MemoryStore());
  await control.apply({ type: 'project.create', id: 'project', title: 'Project', workingDirectory: '/repo', position: { x: -50, y: -100 } }, 0);
  for (let i = 0; i < 24; i++) {
    const before = await control.read();
    await control.apply({ type: 'item.add', id: `item-${i}`, resourceId: `resource-${i}`, pluginId: i % 2 ? 'agent.session' : 'github.pull-request', title: `Item ${i}`, projectId: 'project', position: { x: -50, y: -100 }, data: i % 2 ? { sessionId: `session-${i}`, provider: 'claude' } : { owner: 'fixture', repo: 'test', number: i + 1 } }, before.revision);
    const after = await control.read();
    assert.deepEqual(after.nodes.slice(0, -1).map(node => node.position), before.nodes.map(node => node.position));
  }
  const state = await control.read(), boxes = state.nodes.map(node => itemFootprint(node, state.resources, control.registry));
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) assert.equal(overlaps(boxes[i], boxes[j]), false);
  assert.equal(state.nodes[0].workingDirectory, '/repo');
});

test('UI/agent move commands commit displacement once, preserve links/resources and roll back stale or invalid batches', async () => {
  const initial = stateSchema.parse({ version: 1, revision: 0, view: {}, todos: [], nodes: [
    { id: 'project', title: 'Project', position: { x: -800, y: -400 } },
    { id: 'agent', title: 'Agent', resourceId: 'agent-r', projectId: 'project', position: { x: 0, y: 0 } },
    { id: 'pr', title: 'PR', resourceId: 'pr-r', projectId: 'project', position: { x: 500, y: 0 } },
  ], resources: [
    { id: 'agent-r', pluginId: 'agent.session', schemaVersion: 1, title: 'Agent', data: { sessionId: 'native-session', provider: 'claude' } },
    { id: 'pr-r', pluginId: 'github.pull-request', schemaVersion: 1, title: 'PR', data: { owner: 'fixture', repo: 'test', number: 1 } },
  ], links: [{ id: 'link', sourceId: 'agent', targetId: 'pr', kind: 'reference' }] });
  const control = new WorkspaceControl(new MemoryStore(initial));
  const input = { commandId: 'move', expectedRevision: 0, actor: { kind: 'agent', id: 'fixture' }, commands: [{ type: 'node.move', id: 'agent', position: { x: 500, y: 0 } }] };
  const result = await control.dispatch(input);
  assert.equal(result.state.revision, 1);
  assert.deepEqual(result.state.nodes[1].position, { x: 500, y: 0 });
  assert.notDeepEqual(result.state.nodes[2].position, initial.nodes[2].position);
  assert.deepEqual(result.state.nodes[0], initial.nodes[0]);
  assert.deepEqual(result.state.resources, initial.resources); assert.deepEqual(result.state.links, initial.links);
  const boxes = layoutFootprints(result.state.nodes, result.state.resources, control.registry);
  assert.equal(overlaps(boxes[0], boxes[1], 20), false);
  assert.deepEqual((await control.dispatch(input)).state, result.state);
  assert.equal((await control.read()).revision, 1);
  await assert.rejects(control.dispatch({ ...input, commandId: 'stale' }), RevisionConflict);
  await assert.rejects(control.dispatch({ ...input, commandId: 'invalid', expectedRevision: 1, commands: [
    { type: 'node.update', id: 'agent', title: 'Must roll back' },
    { type: 'nodes.move', positions: [{ id: 'agent', position: { x: 0, y: 0 } }, { id: 'pr', position: { x: 0, y: 0 } }] },
  ] }), /positions overlap/);
  assert.deepEqual(await control.read(), result.state);
});


test('reopening and restoring retain the item position while clearing newly occupied space', async () => {
  const control = new WorkspaceControl();
  const apply = async (command: unknown) => control.apply(command, (await control.read()).revision);
  await apply({ type: 'item.add', id: 'agent', resourceId: 'agent-r', pluginId: 'agent.session', title: 'Agent', data: { provider: 'claude', sessionId: 'local' }, position: { x: 0, y: 0 } });
  const open = await control.read();
  await apply({ type: 'node.complete', id: 'agent' });
  const done = await control.read();
  assert.deepEqual(itemFootprint(done.nodes[0], done.resources, control.registry), itemFootprint(open.nodes[0], open.resources, control.registry), 'done keeps its size');
  await apply({ type: 'item.add', id: 'todo', resourceId: 'todo-r', pluginId: 'workspace.todo', title: 'Task', data: {}, position: { x: 180, y: 0 } });
  const small = await control.read(), placed = layoutFootprints(small.nodes, small.resources, control.registry);
  assert.equal(overlaps(placed[0], placed[1], 20), false, 'placement keeps clear of the done item at its full size');
  for (const action of ['node.reopen', 'node.restore']) {
    if (action === 'node.restore') {
      await apply({ type: 'node.archive', id: 'agent' });
      await apply({ type: 'node.move', id: 'todo', position: { x: 0, y: 0 } });
    }
    await apply({ type: action, id: 'agent' });
    const state = await control.read(), boxes = layoutFootprints(state.nodes, state.resources, control.registry);
    assert.deepEqual(state.nodes[0].position, { x: 0, y: 0 });
    assert.equal(overlaps(boxes[0], boxes[1], 20), false);
    assert.deepEqual(state.resources, small.resources);
  }
});

test('project transfer and collision placement commit atomically without changing resources, links or session identity', async () => {
  const control = new WorkspaceControl(new MemoryStore(stateSchema.parse({ version: 1, revision: 0, view: {},
    nodes: [
      { id: 'source', title: 'Source', position: { x: -1000, y: -500 } },
      { id: 'target', title: 'Target', position: { x: 1200, y: 0 } },
      { id: 'agent', title: 'Agent', resourceId: 'agent-r', projectId: 'source', position: { x: 0, y: 0 }, activity: 'working', summary: 'Keep working' },
      { id: 'task', title: 'Task', resourceId: 'task-r', projectId: 'source', position: { x: 500, y: 0 } },
    ], resources: [
      { id: 'agent-r', pluginId: 'agent.session', schemaVersion: 1, title: 'Agent', data: { sessionId: 'native-session', provider: 'claude', cwd: '/original' } },
      { id: 'task-r', pluginId: 'workspace.todo', schemaVersion: 1, title: 'Task', data: {} },
    ], links: [{ id: 'context', sourceId: 'task', targetId: 'agent', kind: 'context' }],
    todos: [{ id: 'check', title: 'Check work', completed: false, nodeIds: ['agent'] }],
  })));
  const before = await control.read();
  const request = { commandId: 'transfer', expectedRevision: 0, actor: { kind: 'user', id: 'fixture' }, commands: [
    { type: 'node.attach', id: 'agent', projectId: 'target' },
    { type: 'node.move', id: 'agent', position: { x: 1200, y: 0 } },
  ] };
  const { state } = await control.dispatch(request);
  assert.equal(state.revision, 1);
  assert.deepEqual(state.nodes[2], { ...before.nodes[2], projectId: 'target', position: { x: 1200, y: 0 } });
  assert.deepEqual(state.nodes.filter(node => node.id !== 'agent'), before.nodes.filter(node => node.id !== 'agent'), 'an empty destination anchor is not displaced');
  assert.deepEqual(state.resources, before.resources); assert.deepEqual(state.links, before.links); assert.deepEqual(state.todos, before.todos);
  assert.equal(groupWorkspaceTodos(state).find(group => group.items.some(item => item.id === 'check'))?.projectId, 'target');
  assert.deepEqual((await control.dispatch(request)).state, state);
  await assert.rejects(control.dispatch({ ...request, commandId: 'invalid', expectedRevision: 1, commands: [
    { type: 'node.attach', id: 'agent', projectId: 'source' }, { type: 'node.move', id: 'missing', position: { x: 0, y: 0 } },
  ] }), /Node not found/);
  assert.deepEqual(await control.read(), state);
  await control.apply({ type: 'node.move', id: 'source', position: { x: -900, y: -500 } }, 1);
  assert.deepEqual((await control.read()).nodes[2], state.nodes[2], 'moving the old project no longer moves its former member');
  assert.equal((await control.dispatch({ ...request, commandId: 'stale' })).state.revision, 3, 'the user\'s stale transfer lands on the current revision');
});

test('with snapping on, a dropped or created centre lands on the grid, a selection keeps its offsets and the store without a layout snaps nothing', async () => {
  class SnappingStore extends MemoryStore { readMapLayout() { return { sizes: {}, snap: 48 }; } }
  const initial = stateSchema.parse({ version: 1, revision: 0, view: {}, todos: [], nodes: [
    { id: 'project', title: 'Project', position: { x: -800, y: -400 } },
    { id: 'agent', title: 'Agent', resourceId: 'agent-r', projectId: 'project', position: { x: 0, y: 0 } },
    { id: 'pr', title: 'PR', resourceId: 'pr-r', projectId: 'project', position: { x: 500, y: 0 } },
  ], resources: [
    { id: 'agent-r', pluginId: 'agent.session', schemaVersion: 1, title: 'Agent', data: { sessionId: 'native-session', provider: 'claude' } },
    { id: 'pr-r', pluginId: 'github.pull-request', schemaVersion: 1, title: 'PR', data: { owner: 'fixture', repo: 'test', number: 1 } },
  ], links: [] });
  const control = new WorkspaceControl(new SnappingStore(initial)), at = async (id: string) => (await control.read()).nodes.find(node => node.id === id)!.position;
  await control.apply({ type: 'node.move', id: 'agent', position: { x: 1003, y: -70 } }, 0);
  assert.deepEqual(await at('agent'), { x: 1008, y: -48 });
  await control.apply({ type: 'node.move', id: 'project', position: { x: -790, y: -410 } }, 1);
  assert.deepEqual(await at('project'), { x: -768, y: -432 });
  assert.deepEqual(await at('agent'), { x: 1040, y: -80 }, 'members follow the project by its snapped delta');
  await control.apply({ type: 'node.move', id: 'pr', position: { x: 1040, y: -80 } }, 2);
  assert.deepEqual(await at('pr'), { x: 1056, y: -96 });
  const pushed = await at('agent');
  assert.ok(pushed.x % 48 === 0 && pushed.y % 48 === 0, `pushed aside onto the grid: ${pushed.x},${pushed.y}`);
  await control.apply({ type: 'item.add', id: 'note', resourceId: 'note-r', pluginId: 'workspace.note', title: 'Note', position: { x: 13, y: 500 }, data: { text: 'hi' } }, 3);
  assert.deepEqual(await at('note'), { x: 0, y: 480 });
  await control.apply({ type: 'nodes.move', positions: [{ id: 'pr', position: { x: 2001, y: 1 } }, { id: 'agent', position: { x: 2401, y: 1 } }] }, 4);
  assert.deepEqual(await at('pr'), { x: 2001, y: 1 }, 'a selection is moved as the user laid it out');
  const plain = new WorkspaceControl(new MemoryStore(initial));
  await plain.apply({ type: 'node.move', id: 'agent', position: { x: 1003, y: -70 } }, 0);
  assert.deepEqual((await plain.read()).nodes[1].position, { x: 1003, y: -70 });
});

test('with solid collisions, a moved item stops at the item in its way and leaves it in place', async () => {
  class SolidStore extends MemoryStore { readMapLayout() { return { sizes: {}, collisions: 'solid' as const }; } }
  const initial = stateSchema.parse({ version: 1, revision: 0, view: {}, todos: [], nodes: [
    { id: 'agent', title: 'Agent', resourceId: 'agent-r', position: { x: -800, y: 0 } },
    { id: 'pr', title: 'PR', resourceId: 'pr-r', position: { x: 0, y: 0 } },
  ], resources: [
    { id: 'agent-r', pluginId: 'agent.session', schemaVersion: 1, title: 'Agent', data: { sessionId: 'native-session', provider: 'claude' } },
    { id: 'pr-r', pluginId: 'github.pull-request', schemaVersion: 1, title: 'PR', data: { owner: 'fixture', repo: 'test', number: 1 } },
  ], links: [] });
  const control = new WorkspaceControl(new SolidStore(initial)), at = async (id: string) => (await control.read()).nodes.find(node => node.id === id)!.position;
  await control.apply({ type: 'node.move', id: 'agent', position: { x: 0, y: 0 } }, 0);
  assert.deepEqual(await at('pr'), { x: 0, y: 0 });
  const stopped = await at('agent');
  assert.ok(stopped.x < -100 && stopped.x > -800 && stopped.y === 0, `stopped at ${stopped.x},${stopped.y}`);
  await control.apply({ type: 'nodes.move', positions: [{ id: 'agent', position: { x: 10, y: 10 } }] }, 1);
  assert.deepEqual(await at('pr'), { x: 0, y: 0 });
});
