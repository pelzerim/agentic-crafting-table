import test from 'node:test';
import assert from 'node:assert/strict';
import { belowSummary, layerNodes, presentLayer } from './layers.ts';
import { isBelow } from './archive.ts';
import type { GraphLink, GraphNode } from './graph.ts';

const AT = '2026-10-27T08:00:00.000Z';
const item = (id: string, projectId: string | undefined, extra: Partial<GraphNode> = {}): GraphNode => ({ id, title: id, resourceId: `r-${id}`, ...(projectId ? { projectId } : {}), position: { x: 0, y: 0 }, ...extra });
const link = (sourceId: string, targetId: string): GraphLink => ({ id: `${sourceId}-${targetId}`, sourceId, targetId, kind: 'reference', label: '' });
const nodes: GraphNode[] = [
  { id: 'live', title: 'Live', position: { x: 0, y: 0 } },
  { id: 'stored', title: 'Stored', position: { x: 2000, y: 0 }, belowAt: AT },
  { id: 'gone', title: 'Gone', position: { x: 4000, y: 0 }, archivedAt: AT },
  item('on-map', 'live'), item('floating', undefined), item('hidden', 'live', { hiddenAt: AT, hideLabel: 'Review' }),
  item('sent-down', 'live', { belowAt: AT }), item('in-stored', 'stored'), item('loose-below', undefined, { belowAt: AT }),
  item('linked-below', 'stored'), item('todo-below', 'stored'), item('archived', 'live', { archivedAt: AT }), item('in-gone', 'gone'),
  item('alias-map', 'live', { resourceId: 'shared' }), item('alias-below', 'stored', { resourceId: 'shared' }),
];
const links = [link('on-map', 'linked-below'), link('in-stored', 'loose-below'), link('on-map', 'floating'), link('sent-down', 'in-stored')];
const resources = [...new Set(nodes.flatMap(node => node.resourceId ? [node.resourceId] : []))].map(id => ({ id, pluginId: 'workspace.note', schemaVersion: 1, title: id, data: {} }));
const state = { revision: 3, nodes, links, resources, todos: [{ id: 't', title: 'Check', completed: false, nodeIds: ['todo-below'] }] };
const below = new Set(nodes.filter(node => node.resourceId && isBelow(node, nodes)).map(node => node.id));

test('the map layer leaves out what lies below, except what a map item links to or a to-do holds', () => {
  const { state: map, layers } = presentLayer(state, 'map');
  const ids = map.nodes.map(node => node.id);
  assert.deepEqual(ids.filter(id => below.has(id)).sort(), ['linked-below', 'todo-below']);
  for (const id of ['live', 'stored', 'gone', 'on-map', 'floating', 'hidden', 'archived', 'in-gone', 'alias-map']) assert.ok(ids.includes(id), id);
  assert.ok(map.resources.every(resource => map.nodes.some(node => node.resourceId === resource.id)), 'no resource only below items use');
  assert.deepEqual(map.resources.map(resource => resource.id).sort(), ['r-archived', 'r-floating', 'r-hidden', 'r-in-gone', 'r-linked-below', 'r-on-map', 'r-todo-below', 'shared']);
  assert.deepEqual(map.links.map(entry => entry.id), ['on-map-linked-below', 'on-map-floating'], 'no link with an end that stays below');
  assert.deepEqual(map.todos, state.todos); assert.equal(map.revision, 3);
  assert.deepEqual(layers, { below: { items: below.size, projects: ['live', 'stored'] } });
  assert.equal(layers.below.items, 6);
});

test('the below layer is the whole workspace, so Needs me and the to-do list keep the map while below', () => {
  const { state: whole, layers } = presentLayer(state, 'below');
  assert.equal(whole, state);
  assert.deepEqual(layers, { below: belowSummary(nodes) });
});

test('a layer draws the same nodes from the whole workspace as from its own presented part', () => {
  for (const layer of ['map', 'below'] as const) {
    const drawn = (list: readonly GraphNode[]) => layerNodes(list, layer).map(node => node.id).sort();
    assert.deepEqual(drawn(presentLayer(state, layer).state.nodes), drawn(nodes), layer);
  }
  assert.deepEqual(layerNodes(nodes, 'map').map(node => node.id), ['live', 'gone', 'on-map', 'floating', 'archived', 'in-gone', 'alias-map']);
  assert.deepEqual(layerNodes(nodes, 'below').map(node => node.id), ['live', 'stored', 'sent-down', 'in-stored', 'loose-below', 'linked-below', 'todo-below', 'alias-below']);
});

test('a map with nothing below or hidden is drawn as it is', () => {
  const plain = nodes.filter(node => !below.has(node.id) && !node.belowAt && !node.hiddenAt);
  assert.equal(layerNodes(plain, 'map'), plain);
  assert.deepEqual(belowSummary(plain), { items: 0, projects: [] });
});

test('a malformed state is passed through untouched, so the window reports it as it always did', () => {
  const malformed = { nodes: 5, links: 5, resources: 5, todos: 5 } as unknown as Parameters<typeof presentLayer>[0];
  assert.deepEqual(presentLayer(malformed, 'map'), { state: malformed, layers: { below: { items: 0, projects: [] } } });
});
