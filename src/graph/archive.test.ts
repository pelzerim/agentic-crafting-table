import assert from 'node:assert/strict';
import test from 'node:test';
import { archiveNode, isArchived, restoreNode, visibleGraph } from './archive.ts';
import type { GraphLink, GraphNode } from './graph.ts';

const nodes: GraphNode[] = [
  { id: 'billing', title: 'Billing', position: { x: 10, y: 20 } },
  { id: 'agent', title: 'Agent', projectId: 'billing', resourceId: 'session-1', position: { x: 80, y: 90 } },
  { id: 'brief', title: 'Brief', projectId: 'billing', position: { x: -50, y: 40 } },
  { id: 'docs', title: 'Docs', position: { x: 100, y: 200 } },
  { id: 'alias', title: 'Shared session', projectId: 'docs', resourceId: 'session-1', position: { x: 160, y: 90 } },
];
const links: GraphLink[] = [{ id: 'context', sourceId: 'brief', targetId: 'agent', kind: 'context', label: 'Context' }];

test('archive and restore preserve node identity, positions, session data and links', () => {
  const withHistory = nodes.map(n => ({ ...n, history: ['original context'], status: 'working' }));
  const archived = archiveNode(withHistory, 'agent', 't1');
  assert.equal(withHistory[1].archivedAt, undefined);
  assert.equal(visibleGraph(archived, links).links.length, 0);
  assert.deepEqual(restoreNode(archived, 'agent'), withHistory);
  assert.deepEqual(visibleGraph(restoreNode(archived, 'agent'), links).links, links);
});

test('restoring a project keeps previously archived items archived', () => {
  const archived = archiveNode(archiveNode(nodes, 'brief', 't1'), 'billing', 't2');
  assert.equal(isArchived(archived[1], archived), true);
  assert.equal(archived[1].archivedAt, undefined);
  assert.throws(() => restoreNode(archived, 'agent'), /project first/);
  const restored = restoreNode(archived, 'billing');
  assert.equal(isArchived(restored[1], restored), false);
  assert.equal(isArchived(restored[2], restored), true);
  assert.equal(restored[2].archivedAt, 't1');
});

test('archive view retains parent context and does not archive aliases in other projects', () => {
  const archived = archiveNode(nodes, 'agent', 't1');
  assert.deepEqual(visibleGraph(archived, links, true).nodes.map(n => n.id), ['billing', 'agent']);
  assert.equal(isArchived(archived[4], archived), false);
  assert.deepEqual(visibleGraph(archiveNode(nodes, 'billing', 't2'), links).nodes.map(n => n.id), ['docs', 'alias']);
});

test('archive retries keep the original timestamp and reject unknown nodes', () => {
  const archived = archiveNode(nodes, 'agent', 't1');
  assert.equal(archiveNode(archived, 'agent', 't2')[1].archivedAt, 't1');
  assert.throws(() => archiveNode(nodes, 'missing', 't1'), /does not exist/);
  assert.throws(() => restoreNode(nodes, 'missing'), /does not exist/);
  assert.throws(() => archiveNode(nodes, 'agent', ''), /timestamp/);
});
