import test from 'node:test';
import assert from 'node:assert/strict';
import { selectionMoves } from './selection.ts';
import { contextMenuActions, sharedContextMenuActions } from '../../packages/core/context-menu.ts';

test('selection movement translates project members once and retains unrelated selections', () => {
  const nodes = [{ id: 'p', title: 'Project', position: { x: 0, y: 0 } }, { id: 'a', title: 'A', projectId: 'p', position: { x: 300, y: 100 } }, { id: 'b', title: 'B', position: { x: 700, y: 200 } }];
  assert.deepEqual(selectionMoves(nodes, ['p', 'a', 'b'], 'a', { x: 310, y: 80 }), [{ id: 'p', position: { x: 10, y: -20 } }, { id: 'b', position: { x: 710, y: 180 } }]);
  assert.deepEqual(selectionMoves(nodes, ['p', 'a'], 'b', { x: 800, y: 200 }), [{ id: 'b', position: { x: 800, y: 200 } }]);
});
test('batch menus expose only shared atomic actions, never single-item settings or launches', () => {
  assert.deepEqual(sharedContextMenuActions([contextMenuActions('item'), contextMenuActions('project')]).map(a => a.id), ['complete', 'below']);
  assert.deepEqual(sharedContextMenuActions([contextMenuActions('item', true), contextMenuActions('item')]).map(a => a.id), ['below']);
  const ticket = contextMenuActions('item', false, undefined, [], { enabled: false });
  assert.deepEqual(sharedContextMenuActions([ticket, ticket]).map(a => a.id), ['add-todo', 'complete', 'below']);
  const below = contextMenuActions('item', false, undefined, [], undefined, {});
  assert.deepEqual(sharedContextMenuActions([below, below]).map(a => a.label), ['Bring selection back', 'Archive selection']);
});

test('translating an existing overlapping selection preserves its offsets but new overlaps are rejected', async () => {
  const { moveItems } = await import('./movement.ts');
  const { createResourcePluginRegistry } = await import('../resource-plugins/builtins.ts');
  const registry = createResourcePluginRegistry();
  const resources = ['a', 'b'].map(id => ({ id, pluginId: 'workspace.todo', schemaVersion: 1, title: id, data: {} }));
  const nodes = resources.map(resource => ({ id: resource.id, resourceId: resource.id, title: resource.title, position: { x: 0, y: 0 } }));
  const moved = moveItems(nodes, resources, registry, selectionMoves(nodes, ['a', 'b'], 'a', { x: 100, y: 80 }));
  assert.deepEqual(moved.map(n => n.position), [{ x: 100, y: 80 }, { x: 100, y: 80 }]);
  const separate = nodes.map((node, i) => ({ ...node, position: { x: i * 500, y: 0 } }));
  assert.throws(() => moveItems(separate, resources, registry, [{ id: 'a', position: { x: 0, y: 0 } }, { id: 'b', position: { x: 0, y: 0 } }]), /overlap/);
});

test('shared actions support large selections atomically and reject partial failures', async () => {
  const { WorkspaceControl, MemoryStore, stateSchema } = await import('../../packages/core/control.ts');
  const nodes = Array.from({ length: 101 }, (_, i) => ({ id: `p${i}`, title: `Project ${i}`, position: { x: i * 500, y: 0 } }));
  const control = new WorkspaceControl(new MemoryStore(stateSchema.parse({ version: 1, revision: 0, nodes, resources: [], todos: [], links: [], view: {} })));
  await assert.rejects(control.apply({ type: 'nodes.action', action: 'archive', ids: ['p0', 'missing'] }, 0), /not found|does not exist/i);
  assert.equal((await control.read()).nodes.some(n => n.archivedAt), false);
  const result = await control.apply({ type: 'nodes.action', action: 'archive', ids: nodes.map(n => n.id) }, 0);
  assert.equal(result.nodes.filter(n => n.archivedAt).length, 101); assert.equal(result.revision, 1);
});
