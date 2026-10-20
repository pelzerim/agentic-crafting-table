import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyState, stateSchema } from './control.ts';
import { relatedResourceItems } from './related-items.ts';
import { createResourcePluginRegistry } from '../../src/resource-plugins/builtins.ts';
const registry = createResourcePluginRegistry();
test('related items follow direct links across aliases, deduplicate resources and exclude archived neighborhoods', () => {
  const graph = stateSchema.parse({ ...emptyState(),
    nodes: [
      { id: 'pr', title: 'PR', resourceId: 'pull' }, { id: 'alias', title: 'PR alias', resourceId: 'pull' },
      { id: 'review', title: 'Review', resourceId: 'r', summary: 'Saved result', activity: 'complete' },
      { id: 'review-alias', title: 'Review alias', resourceId: 'r' },
      { id: 'project', title: 'Archived project', archivedAt: '2026-09-28T00:00:00Z' },
      { id: 'archived-child', title: 'Child', projectId: 'project' },
      { id: 'unconnected', title: 'Unconnected' }, { id: 'context', title: 'Context' },
    ].map(node => ({ ...node, position: { x: 0, y: 0 } })),
    resources: [{ id: 'pull', pluginId: 'github.pull-request', schemaVersion: 1, title: 'PR', data: {} }, { id: 'r', pluginId: 'code.review', schemaVersion: 1, title: 'Review', data: { sourcePrId: 'alias' } }],
    links: [['alias','review'], ['review-alias','pr'], ['context','pr'], ['pr','archived-child']].map(([sourceId,targetId], i) => ({ id: String(i), sourceId, targetId, kind: 'reference' })),
  });
  const result = relatedResourceItems(graph, 'pr', registry);
  assert.deepEqual(result.map(item => item.nodeId), ['review', 'context']);
  assert.equal(result[0].parentResourceId, 'pull'); assert.equal(result[0].summary, 'Saved result');
  assert.deepEqual(relatedResourceItems(graph, 'missing', registry), []);
  graph.links = [];
  assert.deepEqual(relatedResourceItems(graph, 'pr', registry), []);
});
