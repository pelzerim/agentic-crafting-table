import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyState } from '../../packages/core/control.ts';
import type { WorkspaceState } from '../../packages/core/control.ts';
import { shareUnchanged } from './share-state.ts';

const node = (id: string, title = id) => ({ id, title, position: { x: 0, y: 0 }, summary: '', activity: 'idle' as const, attention: 'none' as const });
const state = (over: Partial<WorkspaceState>): WorkspaceState => ({ ...emptyState(), ...over });

test('a new snapshot keeps the previous object for everything that did not change, so unchanged cards keep their identity', () => {
  const previous = state({ revision: 3, nodes: [node('a'), node('b'), node('c')], links: [{ id: 'l', sourceId: 'a', targetId: 'b', kind: 'reference', label: '' }],
    resources: [{ id: 'r', pluginId: 'workspace.note', schemaVersion: 1, title: 'r', data: { text: 'x' } }], todos: [] });
  const next = state({ revision: 4, nodes: [node('a'), node('b', 'Renamed'), node('c')], links: [{ id: 'l', sourceId: 'a', targetId: 'b', kind: 'reference', label: '' }],
    resources: [{ id: 'r', pluginId: 'workspace.note', schemaVersion: 1, title: 'r', data: { text: 'x' } }], todos: [] });
  const shared = shareUnchanged(previous, next);
  assert.equal(shared.revision, 4);
  assert.equal(shared.nodes[0], previous.nodes[0]); assert.equal(shared.nodes[2], previous.nodes[2]);
  assert.notEqual(shared.nodes[1], previous.nodes[1]); assert.equal(shared.nodes[1].title, 'Renamed');
  assert.equal(shared.links, previous.links, 'an array with no changed member is the previous array');
  assert.equal(shared.resources, previous.resources);
  assert.deepEqual(shared, next, 'the content is the new snapshot');
});

test('sharing follows ids, not positions, and never resurrects a removed item', () => {
  const previous = state({ revision: 1, nodes: [node('a'), node('b')] });
  const next = state({ revision: 2, nodes: [node('b'), node('c')] });
  const shared = shareUnchanged(previous, next);
  assert.equal(shared.nodes[0], previous.nodes[1]);
  assert.deepEqual(shared.nodes.map(item => item.id), ['b', 'c']);
  assert.equal(shareUnchanged(undefined, next), next, 'without a previous state the snapshot is used as it is');
});

test('a malformed snapshot is passed through untouched, so the map reports it the way it always did', () => {
  const previous = state({ revision: 1, nodes: [node('a')] });
  const malformed = { ...state({ revision: 2 }), nodes: 5 } as unknown as WorkspaceState;
  assert.equal(shareUnchanged(previous, malformed), malformed);
});
