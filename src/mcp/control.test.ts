import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore, WorkspaceControl } from './control.ts';
import { FileStore } from './store.ts';

const project = { type: 'project.create', id: 'billing', title: 'Billing', summary: 'Improve plan changes', position: { x: 0, y: 0 } };
const item = { type: 'item.create', id: 'agent', projectId: 'billing', position: { x: 10, y: 20 }, resource: { id: 'session-1', pluginId: 'agent.session', schemaVersion: 1, title: 'Implementation', data: { sessionId: 'claude-1', provider: 'claude' } } };

test('project movement, task completion and archive preserve independent item state', async () => {
  const control = new WorkspaceControl();
  await control.apply(project, 0);
  await control.apply(item, 1);
  await control.apply({ type: 'todo.save', todo: { id: 'task', title: 'Ship', nodeIds: ['billing', 'agent', 'agent'], completed: true } }, 2);
  let state = await control.read();
  assert.deepEqual(state.todos[0].nodeIds, ['billing', 'agent']);
  assert.equal(state.nodes[1].activity, 'unknown');
  const beforeMove = { ...state.nodes[1].position };
  await control.apply({ type: 'node.archive', id: 'agent' }, 3);
  await control.apply({ type: 'node.move', id: 'billing', position: { x: 100, y: 80 } }, 4);
  state = await control.read();
  assert.deepEqual(state.nodes[1].position, { x: beforeMove.x + 100, y: beforeMove.y + 80 });
  assert.ok(state.nodes[1].archivedAt);
  await control.apply({ type: 'node.archive', id: 'billing' }, 5);
  await assert.rejects(control.apply({ type: 'node.restore', id: 'agent' }, 6), /Restore the project first/);
  await control.apply({ type: 'node.restore', id: 'billing' }, 6);
  assert.ok((await control.read()).nodes[1].archivedAt);
  await control.apply({ type: 'node.restore', id: 'agent' }, 7);
  assert.equal((await control.read()).nodes[1].archivedAt, undefined);
});

test('failed validation and stale edits leave the entire workspace unchanged', async () => {
  const control = new WorkspaceControl();
  await control.apply(project, 0);
  const before = await control.read();
  await assert.rejects(control.apply(item, 0), /Revision conflict/);
  await assert.rejects(control.apply({ ...item, resource: { ...item.resource, data: {} } }, 1), /invalid/);
  await assert.rejects(control.apply({ type: 'node.move', id: 'billing', position: { x: Infinity, y: 0 } }, 1));
  await assert.rejects(control.apply({ type: 'todo.save', todo: { id: 'missing', title: 'No', nodeIds: ['absent'] } }, 1), /Node not found/);
  assert.deepEqual(await control.read(), before);
});

test('done is persisted independently of live activity, archive, links and task completion', async () => {
  const control = new WorkspaceControl();
  await control.apply(project, 0);
  await control.apply(item, 1);
  await control.apply({ type: 'node.update', id: 'agent', activity: 'working', attention: 'input' }, 2);
  await control.apply({ type: 'link.save', link: { id: 'context', sourceId: 'billing', targetId: 'agent', kind: 'context' } }, 3);
  await control.apply({ type: 'todo.save', todo: { id: 'task', title: 'Ship', nodeIds: ['agent'] } }, 4);
  const before = await control.read();
  let state = await control.apply({ type: 'node.complete', id: 'agent' }, 5);
  const completedAt = state.nodes[1].completedAt;
  assert.ok(completedAt);
  assert.deepEqual(state.nodes[1], { ...before.nodes[1], completedAt });
  assert.deepEqual(state.links, before.links);
  assert.deepEqual(state.todos, before.todos);
  const restarted = new WorkspaceControl(new MemoryStore(state));
  state = await restarted.apply({ type: 'node.complete', id: 'agent' }, 6);
  assert.equal(state.nodes[1].completedAt, completedAt);
  await restarted.apply({ type: 'node.archive', id: 'agent' }, 7);
  state = await restarted.apply({ type: 'node.restore', id: 'agent' }, 8);
  assert.equal(state.nodes[1].completedAt, completedAt);
  state = await restarted.apply({ type: 'node.reopen', id: 'agent' }, 9);
  assert.deepEqual(state.nodes[1], before.nodes[1]);
});

test('delete removes dangling graph references and retains resources used by another alias', async () => {
  const control = new WorkspaceControl();
  await control.apply(project, 0);
  await control.apply(item, 1);
  await control.apply({ type: 'link.save', link: { id: 'context', sourceId: 'billing', targetId: 'agent', kind: 'context' } }, 2);
  await control.apply({ type: 'todo.save', todo: { id: 'task', title: 'Ship', nodeIds: ['billing', 'agent'] } }, 3);
  await control.apply({ type: 'view.set', view: { mode: 'item', nodeId: 'agent' } }, 4);
  const initial = await control.read();
  initial.nodes.push({ ...initial.nodes[1], id: 'alias', position: { x: 100, y: 100 } });
  const aliases = new WorkspaceControl(new MemoryStore(initial));
  await assert.rejects(aliases.apply({ type: 'node.delete', id: 'agent' }, 5), /Archive/);
  await aliases.apply({ type: 'node.archive', id: 'agent' }, 5);
  let state = await aliases.apply({ type: 'node.delete', id: 'agent' }, 6);
  assert.deepEqual(state.nodes.map(n => n.id), ['billing', 'alias']);
  assert.deepEqual(state.links, []);
  assert.deepEqual(state.todos[0].nodeIds, ['billing']);
  assert.equal(state.view.mode, 'workspace');
  assert.equal(state.view.nodeId, undefined);
  assert.deepEqual(state.resources, initial.resources);
  await aliases.apply({ type: 'node.archive', id: 'alias' }, 7);
  state = await aliases.apply({ type: 'node.delete', id: 'alias' }, 8);
  assert.deepEqual(state.resources, []);
  await assert.rejects(aliases.apply({ type: 'node.delete', id: 'billing' }, 6), /Revision conflict/);
  await assert.rejects(aliases.apply({ type: 'node.delete', id: 'missing' }, 9), /Node not found/);
  assert.deepEqual(await aliases.read(), state);
});

test('deleting a project detaches its members without losing their state or positions', async () => {
  const control = new WorkspaceControl();
  await control.apply(project, 0);
  await control.apply(item, 1);
  await control.apply({ type: 'node.complete', id: 'agent' }, 2);
  await control.apply({ type: 'node.archive', id: 'agent' }, 3);
  const before = await control.read();
  await control.apply({ type: 'node.archive', id: 'billing' }, 4);
  const state = await control.apply({ type: 'node.delete', id: 'billing' }, 5);
  const { projectId, ...floating } = before.nodes[1];
  assert.deepEqual(state.nodes, [floating]);
  assert.deepEqual(state.resources, before.resources);
});

test('context requires an agent target; reference links do not grant context', async () => {
  const control = new WorkspaceControl();
  await control.apply(project, 0);
  await control.apply(item, 1);
  const link = { id: 'context', sourceId: 'billing', targetId: 'agent', kind: 'context', label: 'Project context' };
  await control.apply({ type: 'link.save', link }, 2);
  await assert.rejects(control.apply({ type: 'link.save', link: { ...link, sourceId: 'agent', targetId: 'billing' } }, 3), /point to an agent/);
  assert.deepEqual((await control.read()).links, [link]);
});

test('multiple agent processes share persisted state and reject conflicting revisions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'benchgrove-mcp-'));
  try {
    const file = join(directory, 'workspace.state.json');
    const a = new WorkspaceControl(new FileStore(file));
    const b = new WorkspaceControl(new FileStore(file));
    const results = await Promise.allSettled([a.apply(project, 0), b.apply({ ...project, id: 'other' }, 0)]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    assert.match(String((results.find(r => r.status === 'rejected') as PromiseRejectedResult).reason), /Revision conflict/);
    const state = await a.read();
    assert.deepEqual(await b.read(), state);
    await b.apply({ type: 'node.update', id: state.nodes[0].id, summary: 'Changed by another agent' }, 1);
    assert.equal((await a.read()).nodes[0].summary, 'Changed by another agent');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('all proposal resource types can be created through the plugin registry', async () => {
  const control = new WorkspaceControl();
  for (const [pluginId, data] of [
    ['linear.ticket', { issueId: 'BIL-128' }],
    ['notion.page', { pageId: 'page-1' }],
    ['workspace.todo', { notes: 'Check downgrade confirmation copy.' }],
    ['slack.message', { workspaceHost: 'example.slack.com', channelId: 'C0123456789', messageTs: '1727172060.000002', scope: 'thread', threadTs: '1727172000.000001' }],
  ] as const) {
    const revision = (await control.read()).revision;
    await control.apply({ ...item, id: pluginId, projectId: undefined, resource: { ...item.resource, id: pluginId, pluginId, data } }, revision);
  }
  assert.equal((await control.read()).resources.length, 4);
});
