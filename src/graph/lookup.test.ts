import assert from 'node:assert/strict';
import test from 'node:test';
import { findById, nodesOfResource } from './lookup.ts';
import { isOffMap } from './archive.ts';
import type { GraphNode } from './graph.ts';

/** An array that counts the elements its searches visit. */
class Counted<T> extends Array<T> {
  static visits = 0;
  static get [Symbol.species]() { return Array; }
  override find(...args: Parameters<T[]['find']>) { Counted.visits += this.length; return super.find(...args); }
  override filter(...args: Parameters<T[]['filter']>) { Counted.visits += this.length; return super.filter(...args); }
}
const many = (count: number) => {
  const nodes = Counted.from<GraphNode>([{ id: 'project', title: 'Project', position: { x: 0, y: 0 }, belowAt: '2026-11-06T00:00:00.000Z' }]) as Counted<GraphNode>;
  for (let i = 0; i < count; i++) nodes.push({ id: `node-${i}`, title: `Node ${i}`, resourceId: `resource-${i % (count / 2)}`, ...(i % 3 ? { projectId: 'project' } : {}), position: { x: i, y: 0 } });
  return nodes;
};

test('lookups on a frozen list find what a search finds, in list order, and search it only once', () => {
  const nodes = Object.freeze(many(400));
  for (const node of nodes) Object.freeze(node);
  Counted.visits = 0;
  for (const node of nodes) {
    assert.equal(findById(nodes, node.id), node);
    assert.deepEqual(nodesOfResource(nodes, node.resourceId), nodes.filter(candidate => node.resourceId !== undefined && candidate.resourceId === node.resourceId));
    assert.equal(isOffMap(node, nodes), node.id === 'project' || node.projectId === 'project');
  }
  Counted.visits = 0;
  for (const node of nodes) { findById(nodes, node.id); nodesOfResource(nodes, node.resourceId); isOffMap(node, nodes); }
  assert.ok(Counted.visits < 2 * nodes.length, `${Counted.visits} elements visited`);
  assert.equal(findById(nodes, 'missing'), undefined);
  assert.deepEqual(nodesOfResource(nodes, 'missing'), []);
  assert.deepEqual(nodesOfResource(nodes, undefined), []);
});

test('a list that can still change is searched each time, so a lookup never misses a later change', () => {
  const nodes: GraphNode[] = [{ id: 'a', title: 'A', resourceId: 'r', position: { x: 0, y: 0 } }];
  assert.equal(findById(nodes, 'a'), nodes[0]);
  nodes.push({ id: 'b', title: 'B', resourceId: 'r', position: { x: 1, y: 0 } });
  assert.equal(findById(nodes, 'b'), nodes[1]);
  assert.deepEqual(nodesOfResource(nodes, 'r').map(node => node.id), ['a', 'b']);
  nodes.splice(0, 1);
  assert.equal(findById(nodes, 'a'), undefined);
});
