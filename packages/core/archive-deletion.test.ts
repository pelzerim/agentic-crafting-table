import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from '../workspace-service/sqlite-store.ts';
import { WorkspaceControl } from './control.ts';
import type { WorkspaceCommand } from './control.ts';
import { groupWorkspaceTodos } from '../../src/graph/todos.ts';

test('archive-only deletion rejects active records atomically, preserves inherited archives and survives SQLite restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'craft-archive-delete-')), path = join(directory, 'workspace.sqlite');
  let store = new SqliteStore(path), control = new WorkspaceControl(store);
  const apply = async (commands: WorkspaceCommand[]) => control.dispatch({ commandId: crypto.randomUUID(), expectedRevision: (await control.read()).revision, actor: { kind: 'agent', id: 'fixture' }, commands });
  try {
    await apply([
      { type: 'project.create', id: 'project', title: 'Release', summary: '', position: { x: 0, y: 0 } },
      { type: 'item.add', id: 'task', resourceId: 'resource', pluginId: 'workspace.todo', title: 'Ship', data: {}, projectId: 'project', position: { x: 0, y: 0 } },
      { type: 'item.add', id: 'child', resourceId: 'child-resource', pluginId: 'workspace.note', title: 'Note', data: { text: 'Keep this note' }, projectId: 'project', position: { x: 300, y: 0 } },
      { type: 'todo.save', todo: { id: 'checklist', title: 'Verify rollout', nodeIds: ['task'], completed: true } },
    ]);
    const original = await control.read();
    await assert.rejects(apply([{ type: 'node.update', id: 'task', title: 'Must roll back' }, { type: 'node.delete', id: 'task' }]), /Archive/);
    await assert.rejects(apply([{ type: 'node.delete', id: 'project' }]), /Archive/);
    await assert.rejects(apply([{ type: 'todo.remove', id: 'checklist' }]), /Archive/);
    assert.deepEqual(await control.read(), original);
    await apply([{ type: 'todo.archive', id: 'checklist' }, { type: 'node.archive', id: 'project' }]);
    assert.deepEqual(groupWorkspaceTodos(await control.read()), []);
    const archived = await control.read(); const at = archived.todos[0].archivedAt;
    // A delayed title/completion save must not silently restore a checklist.
    await apply([{ type: 'todo.save', todo: { ...original.todos[0], title: 'Updated title' } }]);
    assert.equal((await control.read()).todos[0].archivedAt, at);
    store.close(); store = new SqliteStore(path); control = new WorkspaceControl(store);
    assert.equal((await control.read()).todos[0].archivedAt, at);
    await apply([{ type: 'todo.restore', id: 'checklist' }]);
    assert.deepEqual((await control.read()).todos[0].nodeIds, ['task']);
    assert.equal((await control.read()).todos[0].completed, true);
    await apply([{ type: 'node.delete', id: 'task' }]); // Inherited archive qualifies.
    assert.deepEqual((await control.read()).todos[0].nodeIds, []);
    await apply([{ type: 'node.delete', id: 'project' }]);
    const child = (await control.read()).nodes[0];
    assert.equal(child.id, 'child'); assert.equal(child.projectId, undefined);
    assert.equal(child.archivedAt, archived.nodes[0].archivedAt);
    assert.deepEqual(child.position, original.nodes.find(node => node.id === 'child')!.position);
    await apply([{ type: 'node.restore', id: 'child' }, { type: 'todo.archive', id: 'checklist' }, { type: 'todo.remove', id: 'checklist' }]);
    assert.equal((await control.read()).todos.length, 0);
    await assert.rejects(apply([{ type: 'node.delete', id: 'child' }]), /Archive/);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});
