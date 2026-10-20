import assert from 'node:assert/strict';
import test from 'node:test';
import type { GraphLink, GraphNode } from './graph.ts';
import { projectLinks } from './project-links.ts';
import { visibleGraph } from './archive.ts';

const node = (id: string, projectId?: string, acceptsContext = false): GraphNode =>
  ({ id, title: id, projectId, acceptsContext, position: { x: 0, y: 0 } });
const link = (sourceId: string, targetId: string, kind: GraphLink['kind'] = 'reference'): GraphLink =>
  ({ id: sourceId + '-' + targetId, sourceId, targetId, kind, label: '' });
const targets = (nodes: GraphNode[], links: GraphLink[]) => projectLinks(nodes, links).map(edge => edge.targetId).sort();

test('a ticket connects through its agent while membership and context are preserved', () => {
  const nodes = [node('project'), node('ticket', 'project'), node('agent', 'project', true)];
  const links = [link('ticket', 'agent', 'context')];
  assert.deepEqual(targets(nodes, links), ['agent']);
  assert.deepEqual(targets(nodes, []), ['agent', 'ticket']);
  assert.equal(nodes[1].projectId, 'project');
  assert.equal(links[0].kind, 'context');
});

test('cycles and reverse informational edges keep one deterministic project anchor', () => {
  const nodes = [node('project'), node('page', 'project'), node('pr', 'project'), node('review', 'project')];
  const links = [link('page', 'pr'), link('pr', 'review'), link('review', 'page')];
  const priority = (node: GraphNode) => node.id === 'pr' ? 2 : 1;
  assert.deepEqual(projectLinks(nodes, links, priority), [{ sourceId: 'project', targetId: 'pr', kind: 'family' }]);
  assert.deepEqual(projectLinks([...nodes].reverse(), links.map(l => ({ ...l, sourceId: l.targetId, targetId: l.sourceId })), priority), projectLinks(nodes, links, priority));
});

test('archiving an intermediary reconnects visible items and restoring collapses them again', () => {
  const nodes = [node('project'), node('page', 'project'), node('pr', 'project'), node('agent', 'project', true)];
  const links = [link('page', 'pr'), link('pr', 'agent', 'context')];
  const active = visibleGraph(nodes.map(n => n.id === 'pr' ? { ...n, archivedAt: '2026-09-24' } : n), links);
  assert.deepEqual(targets(active.nodes, active.links), ['agent', 'page']);
  assert.deepEqual(targets(nodes, links), ['agent']);
});

test('cross-project links keep each project attached and explicit project links are not duplicated', () => {
  const nodes = [node('a'), node('b'), node('page', 'a'), node('agent', 'b', true)];
  assert.deepEqual(targets(nodes, [link('page', 'agent', 'context')]), ['agent', 'page']);
  assert.deepEqual(targets(nodes, [link('page', 'a'), link('missing', 'agent')]), ['agent']);
});
