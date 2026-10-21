import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore, WorkspaceControl, RevisionConflict, CommandIdConflict, emptyState } from './control.ts';
import { createResourcePluginRegistry } from '../../src/resource-plugins/builtins.ts';
import { layoutFootprints, ITEM_GAP } from '../../src/graph/movement.ts';
import { overlaps } from '../../src/graph/spatial.ts';

const actor = { kind: 'user', id: 'test' };
const project = (id: string) => ({ type: 'project.create', id, title: id, position: { x: 0, y: 0 } });
const envelope = (commandId: string, expectedRevision: number, commands: unknown[]) => ({ commandId, expectedRevision, actor, commands });

test('partial node updates preserve activity, attention and lifecycle unless explicitly changed', async () => {
  const control = new WorkspaceControl();
  let state = await control.apply(project('a'), 0);
  state = await control.apply({ type: 'node.update', id: 'a', activity: 'working', attention: 'input' }, state.revision);
  for (const patch of [{ title: 'Renamed' }, { summary: 'Current activity' }, { workingDirectory: '/tmp' }]) {
    state = await control.apply({ type: 'node.update', id: 'a', ...patch }, state.revision);
    assert.equal(state.nodes[0].activity, 'working');
    assert.equal(state.nodes[0].attention, 'input');
  }
  state = await control.apply({ type: 'node.complete', id: 'a' }, state.revision);
  state = await control.apply({ type: 'node.archive', id: 'a' }, state.revision);
  const before = structuredClone(state.nodes[0]);
  state = await control.apply({ type: 'node.update', id: 'a', summary: 'Finished work' }, state.revision);
  assert.deepEqual(state.nodes[0], { ...before, summary: 'Finished work' });
  state = await control.apply({ type: 'node.update', id: 'a', activity: 'idle', attention: 'none' }, state.revision);
  assert.equal(state.nodes[0].activity, 'idle');
  assert.equal(state.nodes[0].attention, 'none');
  assert.equal(state.nodes[0].archivedAt, before.archivedAt);
  assert.equal(state.nodes[0].completedAt, before.completedAt);
});

test('atomic command batches commit once and replay exactly without rewriting newer state', async () => {
  const control = new WorkspaceControl();
  const input = envelope('create', 0, [project('a'), project('b')]);
  const first = await control.dispatch(input);
  assert.equal(first.state.revision, 1);
  await control.dispatch(envelope('move', 1, [{ type: 'nodes.move', positions: [{ id: 'a', position: { x: 20, y: 30 } }, { id: 'b', position: { x: 390, y: 30 } }] }]));
  const replay = await control.dispatch(input);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.state, first.state);
  assert.equal((await control.read()).revision, 2);
  assert.deepEqual((await control.read()).nodes[0].position, { x: 20, y: 30 });
  await assert.rejects(control.dispatch({ ...input, commands: [project('c')] }), CommandIdConflict);
});

test('later validation failures and stale writes roll back the entire batch', async () => {
  const control = new WorkspaceControl();
  const before = await control.read();
  await assert.rejects(control.dispatch(envelope('invalid', 0, [project('a'), { type: 'node.move', id: 'missing', position: { x: 1, y: 2 } }])), /Node not found/);
  assert.deepEqual(await control.read(), before);
  await control.dispatch(envelope('invalid', 0, [project('a')]));
  await assert.rejects(control.dispatch(envelope('stale', 0, [project('b')])), (error: unknown) => error instanceof RevisionConflict && error.currentRevision === 1);
  assert.equal((await control.read()).nodes.length, 1);
});

test('the user\'s moves land on the current revision when other writes came first; agent moves and mixed batches still conflict', async () => {
  const control = new WorkspaceControl();
  await control.dispatch(envelope('create', 0, [project('a'), project('b')]));
  await control.dispatch(envelope('other-write', 1, [{ type: 'node.update', id: 'b', summary: 'Changed elsewhere' }]));
  const moved = await control.dispatch(envelope('late-move', 1, [{ type: 'node.move', id: 'a', position: { x: 40, y: 900 } }]));
  assert.equal(moved.state.revision, 3);
  assert.deepEqual(moved.state.nodes.find(node => node.id === 'a')!.position, { x: 40, y: 900 });
  assert.equal(moved.state.nodes.find(node => node.id === 'b')!.summary, 'Changed elsewhere');
  const many = await control.dispatch(envelope('late-many', 1, [{ type: 'nodes.move', positions: [{ id: 'a', position: { x: 40, y: 1400 } }, { id: 'b', position: { x: 900, y: 1400 } }] }]));
  assert.equal(many.state.revision, 4);
  assert.deepEqual(many.state.nodes.find(node => node.id === 'b')!.position, { x: 900, y: 1400 });
  assert.deepEqual((await control.dispatch(envelope('late-move', 1, [{ type: 'node.move', id: 'a', position: { x: 40, y: 900 } }]))).replayed, true);
  await assert.rejects(control.dispatch({ ...envelope('late-agent', 1, [{ type: 'node.move', id: 'a', position: { x: 0, y: 0 } }]), actor: { kind: 'agent', id: 'a' } }), RevisionConflict);
  await assert.rejects(control.dispatch(envelope('late-mixed', 1, [{ type: 'node.move', id: 'a', position: { x: 0, y: 0 } }, { type: 'node.update', id: 'b', title: 'Stale rename' }])), RevisionConflict);
  await assert.rejects(control.dispatch(envelope('late-missing', 1, [{ type: 'node.move', id: 'gone', position: { x: 0, y: 0 } }])), /Node not found/);
  assert.equal((await control.read()).revision, 4);
});

test('placement rejects duplicate/missing items atomically and view state does not conflict with graph writes', async () => {
  const store = new MemoryStore(), control = new WorkspaceControl(store);
  await control.dispatch(envelope('create', 0, [project('a')]));
  const before = await control.read();
  const entry = { id: 'a', position: { x: 20, y: 30 } };
  await assert.rejects(control.dispatch(envelope('duplicate', 1, [{ type: 'nodes.move', positions: [entry, entry] }])), /only once/);
  assert.deepEqual(await control.read(), before);
  await store.writeView('window-a', { mode: 'workspace', camera: { x: 10, y: 20, zoom: .5 } });
  assert.equal((await control.read()).revision, 1);
  assert.deepEqual((await store.readView('window-a')).camera, { x: 10, y: 20, zoom: .5 });
  assert.equal((await store.readView('window-b')).camera, undefined);
  await control.dispatch(envelope('new', 1, [project('b')]));
});

test('layout repair is explicit, atomic, replayable and preserves resources, links, status and camera', async () => {
  const seed = emptyState();
  for (const id of ['one', 'two', 'three']) {
    seed.resources.push({ id: id + '-r', pluginId: 'linear.ticket', schemaVersion: 1, title: id, data: { issueId: id } });
    seed.nodes.push({ id, resourceId: id + '-r', title: id, position: { x: 100, y: 100 }, summary: 'Preserve', activity: 'working', attention: 'input' });
  }
  seed.links.push({ id: 'connected', sourceId: 'one', targetId: 'two', kind: 'reference', label: '' });
  seed.todos.push({ id: 'task', title: 'Check', completed: false, nodeIds: ['one'] });
  seed.view.camera = { x: 10, y: 20, zoom: .8 };
  const control = new WorkspaceControl(new MemoryStore(seed)), before = await control.read();
  const input = envelope('repair', 0, [{ type: 'layout.repair' }]);
  await assert.rejects(control.dispatch({ ...input, commands: [...input.commands, { type: 'node.move', id: 'absent', position: { x: 0, y: 0 } }] }), /Node not found/);
  assert.deepEqual(await control.read(), before);
  const { state } = await control.dispatch(input), boxes = layoutFootprints(state.nodes, state.resources, createResourcePluginRegistry());
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) assert.equal(overlaps(boxes[i], boxes[j], ITEM_GAP), false);
  assert.deepEqual(state.nodes.map(({ position, ...node }) => node), before.nodes.map(({ position, ...node }) => node));
  for (const key of ['resources', 'links', 'todos', 'view'] as const) assert.deepEqual(state[key], before[key]);
  assert.equal(state.revision, 1);
  assert.equal((await control.dispatch(input)).replayed, true);
  await assert.rejects(control.dispatch(envelope('stale-repair', 0, input.commands)), RevisionConflict);
  assert.deepEqual(await control.read(), state);
});

test('plugin identity reuses a PR resource across UI/MCP aliases while isolating accounts and preserving existing state', async () => {
  const control = new WorkspaceControl();
  const add = (id: string, owner = 'Acme', connectionId = 'github-main') => ({ type: 'item.add', id, resourceId: id + '-resource', pluginId: 'github.pull-request', title: id, data: { owner, repo: 'Example', number: 42 }, connectionId, position: { x: 50, y: 50 } });
  let state = await control.apply(add('first'), 0);
  state = await control.apply({ type: 'node.update', id: 'first', title: 'Authoritative PR title', activity: 'working', attention: 'review' }, state.revision);
  state = await control.apply({ type: 'node.complete', id: 'first' }, state.revision);
  state = await control.apply({ type: 'node.archive', id: 'first' }, state.revision);
  const original = structuredClone(state.nodes[0]), resource = structuredClone(state.resources[0]);
  const input = envelope('alias', state.revision, [add('alias', 'acme')]);
  state = (await control.dispatch(input)).state;
  assert.equal(state.resources.length, 1); assert.equal(state.nodes.length, 2);
  assert.equal(state.nodes[1].resourceId, resource.id); assert.equal(state.nodes[1].title, resource.title);
  assert.equal(state.nodes[1].attention, 'review'); assert.equal(state.nodes[1].activity, 'working');
  assert.equal(state.nodes[1].archivedAt, undefined); assert.equal(state.nodes[1].completedAt, undefined);
  assert.deepEqual(state.nodes[0], original); assert.deepEqual(state.resources[0], resource);
  assert.equal((await control.dispatch(input)).replayed, true);
  state = await control.apply(add('other-account', 'acme', 'github-other'), state.revision);
  assert.equal(state.resources.length, 2); assert.notEqual(state.nodes[2].resourceId, resource.id);
  state = await control.apply({ type: 'item.create', id: 'ui-alias', resource: { ...resource, id: 'new-ui-resource', title: 'Stale pasted title' }, position: { x: 400, y: 400 } }, state.revision);
  assert.equal(state.resources.length, 2); assert.equal(state.nodes.at(-1)!.resourceId, resource.id);
  await assert.rejects(control.apply({ type: 'item.create', id: 'collision', resource: { ...resource, connectionId: 'different-account' }, position: { x: 0, y: 0 } }, state.revision), /already exists/);
  assert.deepEqual(await control.read(), state);
});

test('identity is a plugin contract, not a GitHub branch, and conflicting identity edits roll back atomically', async () => {
  const registry = createResourcePluginRegistry();
  registry.register({ id: 'fixture.external', apiVersion: 1, schemaVersion: 1, name: 'External', icon: 'circle', preferredView: 'focus', creation: { label: 'Attach' }, validateData: data => typeof data.key === 'string', providerIdentity: data => String(data.key).toLowerCase() });
  const descriptions = registry.describe(); assert.ok(!JSON.stringify(descriptions).includes('providerIdentity'));
  const control = new WorkspaceControl(new MemoryStore(), registry);
  const add = (id: string, key: string) => ({ type: 'item.add', id, resourceId: id + '-r', pluginId: 'fixture.external', title: id, data: { key }, position: { x: 0, y: 0 } });
  let state = (await control.dispatch(envelope('batch', 0, [add('a', 'ONE'), add('b', 'one'), add('c', 'two')]))).state;
  assert.equal(state.resources.length, 2); assert.equal(state.nodes[0].resourceId, state.nodes[1].resourceId);
  await assert.rejects(control.dispatch(envelope('edit', state.revision, [{ type: 'node.move', id: 'a', position: { x: 999, y: 999 } }, { type: 'item.update', id: 'c', data: { key: 'one' } }])), /already represents/);
  assert.deepEqual(await control.read(), state);
});

test('binding an older unbound PR reconciles provider identity while preserving aliases, references and lifecycle', async () => {
  const control = new WorkspaceControl();
  const add = (id: string, connectionId?: string) => ({ type: 'item.add', id, resourceId: id + '-r', pluginId: 'github.pull-request', title: id, data: { owner: 'acme', repo: 'example', number: 42 }, connectionId, position: { x: id === 'old' ? 30 : 430, y: 50 } });
  let state = (await control.dispatch(envelope('setup', 0, [add('old'), add('connected', 'github'), { type: 'project.create', id: 'project', title: 'Project', position: { x: 0, y: 0 } }, { type: 'link.save', link: { id: 'link', sourceId: 'old', targetId: 'project', kind: 'reference' } }, { type: 'todo.save', todo: { id: 'todo', title: 'Review', nodeIds: ['old'] } }, { type: 'node.archive', id: 'old' }, { type: 'node.complete', id: 'old' }]))).state;
  const before = structuredClone(state), input = envelope('bind', state.revision, [{ type: 'item.bind', id: 'old', connectionId: 'github' }]);
  state = (await control.dispatch(input)).state;
  assert.equal(state.resources.length, 1); assert.equal(state.resources[0].id, 'connected-r');
  assert.deepEqual(state.nodes[0], { ...before.nodes[0], resourceId: 'connected-r' }); assert.deepEqual(state.nodes[1], before.nodes[1]);
  assert.deepEqual(state.links, before.links); assert.deepEqual(state.todos, before.todos); assert.deepEqual(state.view, before.view);
  assert.equal((await control.dispatch(input)).replayed, true);
  await assert.rejects(control.dispatch(envelope('bad-bind', state.revision, [{ type: 'item.bind', id: 'old', connectionId: 'other' }, { type: 'node.move', id: 'missing', position: { x: 0, y: 0 } }])), /Node not found/);
  assert.deepEqual(await control.read(), state);
});

test('acknowledging one provider reason preserves native attention and other reasons across aliases', async () => {
  const control = new WorkspaceControl();
  const add = (id: string) => ({ type: 'item.add', id, resourceId: id, pluginId: 'github.pull-request', title: id, data: { owner: 'fixture', repo: 'repo', number: 42 }, position: { x: 0, y: 0 } });
  let state = (await control.dispatch(envelope('setup', 0, [add('one'), add('two'), { type: 'node.update', id: 'one', attention: 'input' }, { type: 'attention.set', id: 'one', source: 'github.assignment', reason: 'assigned' }, { type: 'attention.set', id: 'two', source: 'workflow.review', reason: 'error' }]))).state;
  assert.deepEqual(state.nodes.map(node => node.attentionSources), [{ 'github.assignment': 'assigned', 'workflow.review': 'error' }, { 'github.assignment': 'assigned', 'workflow.review': 'error' }]);
  state = (await control.dispatch(envelope('viewed', state.revision, [{ type: 'attention.set', id: 'two', source: 'github.assignment', reason: null }]))).state;
  assert.equal(state.nodes[0].attention, 'input'); assert.deepEqual(state.nodes.map(node => node.attentionSources), [{ 'workflow.review': 'error' }, { 'workflow.review': 'error' }]);
});

test('placing checklist tasks on the map preserves completion, attachments and order without duplicate rows', async () => {
  const control = new WorkspaceControl();
  let state = await control.apply(project('p'), 0);
  state = await control.apply({ type: 'todo.save', todo: { id: 'task', title: 'Ship it', completed: true, nodeIds: ['p'], todoOrder: 2 } }, state.revision);
  state = await control.apply({ type: 'todo.place', id: 'task', nodeId: 'placed', resourceId: 'placed-r', projectId: 'p', position: { x: 600, y: 500 } }, state.revision);
  assert.equal(state.todos.length, 0);
  const item = state.nodes.find(n => n.id === 'placed')!;
  assert.equal(item.title, 'Ship it'); assert.ok(item.completedAt); assert.equal(item.todoOrder, 2); assert.equal(item.projectId, 'p');
  assert.ok(state.links.some(link => link.sourceId === 'placed' && link.targetId === 'p'));
  const resources = state.resources.length;
  state = await control.apply({ type: 'todo.place', id: 'map:placed', nodeId: 'unused', resourceId: 'unused-r', position: { x: 1200, y: 900 } }, state.revision);
  assert.equal(state.resources.length, resources); assert.equal(state.nodes.find(n => n.id === 'placed')?.projectId, 'p', 'an empty-space move keeps its project, as on the map');
  assert.deepEqual(state.nodes.find(n => n.id === 'placed')?.position, { x: 1200, y: 900 });
  state = await control.apply(project('q'), state.revision);
  state = await control.apply({ type: 'todo.place', id: 'map:placed', nodeId: 'unused', resourceId: 'unused-r', projectId: 'q', position: { x: 1400, y: 900 } }, state.revision);
  assert.equal(state.nodes.find(n => n.id === 'placed')?.projectId, 'q', 'a drop inside another project transfers it');
  assert.equal(state.nodes.filter(n => n.title === 'Ship it').length, 1);
  await assert.rejects(control.apply({ type: 'todo.place', id: 'task', nodeId: 'duplicate', resourceId: 'duplicate-r', position: { x: 0, y: 0 } }, state.revision), /no longer available/);
  state = await control.apply({ type: 'node.below', id: 'placed' }, state.revision);
  await assert.rejects(control.apply({ type: 'todo.place', id: 'map:placed', nodeId: 'unused', resourceId: 'unused-r', position: { x: 0, y: 0 } }, state.revision), /in Undermap/);
});

test('invalid checklist promotion rolls back creation and retains the list task', async () => {
  const control = new WorkspaceControl();
  let state = await control.apply({ type: 'todo.save', todo: { id: 'task', title: 'Keep me', nodeIds: [] } }, 0);
  await assert.rejects(control.apply({ type: 'todo.place', id: 'task', nodeId: 'new', resourceId: 'new-r', projectId: 'missing', position: { x: 0, y: 0 } }, state.revision));
  assert.deepEqual(await control.read(), state);
});

test('projects keep a neighborhood color from creation and settings; items cannot have one', async () => {
  const control = new WorkspaceControl(new MemoryStore(), createResourcePluginRegistry());
  let state = await control.apply({ ...project('a'), color: '#D0564C' }, 0);
  assert.equal(state.nodes[0].color, '#d0564c');
  state = await control.apply({ type: 'node.update', id: 'a', color: '#6fd6cf' }, state.revision);
  assert.equal(state.nodes[0].color, '#6fd6cf');
  state = await control.apply({ type: 'node.update', id: 'a', title: 'Renamed' }, state.revision);
  assert.equal(state.nodes[0].color, '#6fd6cf');
  await assert.rejects(control.apply({ type: 'node.update', id: 'a', color: 'red' }, state.revision));
  await assert.rejects(control.apply({ ...project('b'), color: '#12345' }, state.revision));
  state = await control.apply({ type: 'item.add', id: 'note', resourceId: 'note-resource', pluginId: 'github.pull-request', title: 'Note', data: { owner: 'Acme', repo: 'Example', number: 42 }, position: { x: 900, y: 0 } }, state.revision);
  await assert.rejects(control.apply({ type: 'node.update', id: 'note', color: '#6fd6cf' }, state.revision), /belong to projects/);
  assert.equal((await control.read()).nodes.find(node => node.id === 'b'), undefined);
});

test('Undermap neighborhoods are very dark versions of each project color', async () => {
  const { undermapColor } = await import('../../src/graph/project-colors.ts');
  assert.equal(undermapColor('#d0564c'), '#4f211d');
  assert.equal(undermapColor('#91B78B'), '#374635');
  assert.equal(undermapColor('not-a-color'), undermapColor('#91b78b'));
});

test('helpers are a plain count on a working node and never survive on one that is not working', async () => {
  const control = new WorkspaceControl(new MemoryStore());
  await control.apply({ type: 'item.add', id: 'agent', resourceId: 'conversation', pluginId: 'agent.session', title: 'Agent', position: { x: 0, y: 0 }, data: { provider: 'claude', sessionId: 'session' } }, 0);
  const node = async () => (await control.read()).nodes.find(node => node.id === 'agent')!;
  const update = async (patch: Record<string, unknown>) => control.apply({ type: 'node.update', id: 'agent', ...patch } as never, (await control.read()).revision);
  assert.equal((await node()).helpers, undefined);
  // A count on an item that is not working is dropped, not stored.
  await update({ helpers: 2 });
  assert.equal((await node()).helpers, undefined);
  await update({ activity: 'working', helpers: 2 });
  assert.equal((await node()).helpers, 2);
  await update({ summary: 'Reading' });
  assert.equal((await node()).helpers, 2, 'other updates leave it');
  await update({ helpers: 0 });
  assert.equal('helpers' in (await node()), false, 'none is an absent field');
  await update({ helpers: 3 }); await update({ activity: 'idle' });
  assert.equal('helpers' in (await node()), false);
  await update({ activity: 'working', helpers: 1 }); await update({ attention: 'input', activity: 'complete' });
  assert.equal('helpers' in (await node()), false);
  await assert.rejects(update({ activity: 'working', helpers: -1 })); await assert.rejects(update({ activity: 'working', helpers: 1.5 }));
});

test('waiting belongs to a working node with helpers and goes with either', async () => {
  const control = new WorkspaceControl(new MemoryStore());
  await control.apply({ type: 'item.add', id: 'agent', resourceId: 'conversation', pluginId: 'agent.session', title: 'Agent', position: { x: 0, y: 0 }, data: { provider: 'claude', sessionId: 'session' } }, 0);
  const node = async () => (await control.read()).nodes.find(node => node.id === 'agent')!;
  const update = async (patch: Record<string, unknown>) => control.apply({ type: 'node.update', id: 'agent', ...patch } as never, (await control.read()).revision);
  await update({ activity: 'working', waiting: true });
  assert.equal('waiting' in (await node()), false, 'nothing to wait on');
  await update({ helpers: 2, waiting: true });
  assert.deepEqual([(await node()).helpers, (await node()).waiting], [2, true]);
  await update({ summary: 'Waiting on 2 subagents' });
  assert.equal((await node()).waiting, true);
  await update({ waiting: false });
  assert.deepEqual([(await node()).helpers, 'waiting' in (await node())], [2, false]);
  await update({ waiting: true }); await update({ helpers: 0 });
  assert.equal('waiting' in (await node()), false);
  await update({ helpers: 1, waiting: true }); await update({ activity: 'idle' });
  assert.deepEqual(['helpers' in (await node()), 'waiting' in (await node())], [false, false]);
});

test('a pose lives only while it can be true, and an ended session keeps no decorations', async () => {
  const control = new WorkspaceControl(new MemoryStore());
  await control.apply({ type: 'item.add', id: 'agent', resourceId: 'conversation', pluginId: 'agent.session', title: 'Agent', position: { x: 0, y: 0 }, data: { provider: 'claude', sessionId: 'session' } }, 0);
  const node = async () => (await control.read()).nodes.find(node => node.id === 'agent')!;
  const update = async (patch: Record<string, unknown>) => control.apply({ type: 'node.update', id: 'agent', ...patch } as never, (await control.read()).revision);
  await update({ activity: 'idle', attention: 'input', attentionNote: 'Agent needs permission', pose: 'gate' });
  assert.equal((await node()).pose, 'gate');
  await update({ activity: 'working', attention: 'none' });
  assert.equal('pose' in (await node()), false, 'the answer takes the gate away in the same revision');
  await update({ pose: 'gate' }); assert.equal('pose' in (await node()), false, 'no prompt, no gate');
  await update({ pose: 'command' }); assert.equal((await node()).pose, 'command');
  await update({ pose: 'shearing' }); assert.equal((await node()).pose, 'shearing');
  await update({ pose: 'none' }); assert.equal('pose' in (await node()), false);
  await update({ pose: 'command' }); await update({ activity: 'idle' });
  assert.equal('pose' in (await node()), false);
  await update({ attention: 'error', attentionNote: 'Agent hit an error', pose: 'fallen' }); assert.equal((await node()).pose, 'fallen');
  await update({ attention: 'input', attentionNote: 'Agent waiting', pose: 'asking' }); assert.equal((await node()).pose, 'asking');
  await update({ attention: 'none' }); assert.equal('pose' in (await node()), false);
  // Decorations are plain values; 0, false and an empty list clear them.
  await update({ beside: 2, tasks: { done: 1, total: 3 }, bell: true, pen: true, moment: { kind: 'stumble', at: 1_700_000_000_000 } });
  assert.deepEqual([(await node()).beside, (await node()).tasks, (await node()).bell, (await node()).pen, (await node()).moment], [2, { done: 1, total: 3 }, true, true, { kind: 'stumble', at: 1_700_000_000_000 }]);
  await update({ bell: false, pen: false, beside: 0, tasks: { done: 0, total: 0 } });
  assert.deepEqual(['beside' in (await node()), 'tasks' in (await node()), 'bell' in (await node()), 'pen' in (await node())], [false, false, false, false]);
  await update({ activity: 'working', pose: 'ended' }); assert.equal('pose' in (await node()), false, 'a working item has not ended');
  await update({ activity: 'idle', beside: 1, tasks: { done: 2, total: 2 }, bell: true, pen: true, pose: 'ended' });
  const ended = await node();
  assert.deepEqual([ended.pose, 'beside' in ended, 'tasks' in ended, 'bell' in ended, 'pen' in ended], ['ended', false, false, false, false]);
  await update({ activity: 'working' }); assert.equal('pose' in (await node()), false);
  await assert.rejects(update({ pose: 'dancing' })); await assert.rejects(update({ tasks: { done: 3, total: 2 } })); await assert.rejects(update({ moment: { kind: 'leap', at: 1 } }));
});

test('a link can be kept off the map until one of its ends is in view, and only by hover', async () => {
  const control = new WorkspaceControl();
  const add = (id: string, number: number) => ({ type: 'item.add', id, resourceId: `${id}-r`, pluginId: 'github.pull-request', title: id, data: { owner: 'acme', repo: 'example', number }, position: { x: number * 600, y: 0 } });
  const save = (reveal?: unknown) => ({ type: 'link.save', link: { id: 'link', sourceId: 'a', targetId: 'b', kind: 'reference', label: '', ...(reveal === undefined ? {} : { reveal }) } });
  let state = (await control.dispatch(envelope('setup', 0, [add('a', 1), add('b', 2), save('hover')]))).state;
  assert.deepEqual(state.links, [{ id: 'link', sourceId: 'a', targetId: 'b', kind: 'reference', label: '', reveal: 'hover' }]);
  state = (await control.dispatch(envelope('always', state.revision, [save()]))).state;
  assert.equal('reveal' in state.links[0], false);
  await assert.rejects(control.dispatch(envelope('other', state.revision, [save('select')])));
});

test('an agent\'s last line is saved on its node and cleared with null', async () => {
  const control = new WorkspaceControl(new MemoryStore());
  await control.apply({ type: 'item.add', id: 'agent', resourceId: 'agent-r', pluginId: 'agent.session', title: 'Claude', position: { x: 0, y: 0 }, data: { sessionId: 's', provider: 'claude' } }, 0);
  await control.apply({ type: 'node.update', id: 'agent', lastLine: 'I pushed the fix to main.' }, 1);
  assert.equal((await control.read()).nodes[0].lastLine, 'I pushed the fix to main.');
  await control.apply({ type: 'node.update', id: 'agent', summary: 'Claude is working' }, 2);
  assert.equal((await control.read()).nodes[0].lastLine, 'I pushed the fix to main.', 'other updates leave it');
  await control.apply({ type: 'node.update', id: 'agent', lastLine: null }, 3);
  assert.equal((await control.read()).nodes[0].lastLine, undefined);
});
