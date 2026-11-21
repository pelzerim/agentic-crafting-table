import test from 'node:test';
import assert from 'node:assert/strict';
import { plotJoinIds } from './plot-join.ts';
import { detectPlots } from '../../../src/graph/plots.ts';

test('a drop pins into a plot only items that land in its project, so a mixed selection never gets the whole pin refused', () => {
  const landed = [{ id: 'own', resourceId: 'own-r', projectId: 'acme' }, { id: 'other', resourceId: 'other-r', projectId: 'beta' }, { id: 'acme', projectId: undefined }, { id: 'held', resourceId: 'held-r', projectId: 'acme' }, { id: 'free', resourceId: 'free-r', projectId: 'acme' }];
  assert.deepEqual(plotJoinIds({ projectId: 'acme', memberIds: ['held'], locked: true }, landed, new Set(), 20), ['own', 'free']);
  assert.deepEqual(plotJoinIds({ projectId: 'acme', memberIds: [] }, landed, new Set(['own', 'other']), 20), ['own'], 'an open plot pins only what another plot holds');
  assert.deepEqual(plotJoinIds({ projectId: 'acme', memberIds: [], locked: true }, landed.filter(node => node.projectId !== 'acme'), new Set(), 20), []);
});

test('a drop that would grow an open plot past what nearness holds pins the item, so the plot never dissolves', () => {
  const box = (id: string, x: number) => ({ id, projectId: 'acme', x, y: 0, width: 80, height: 60 });
  const boxes = [box('a', 0), box('b', 100), box('c', 200), box('d', 300), box('e', 3000)], plot = { id: 'P', projectId: 'acme', memberIds: ['a', 'b', 'c'] };
  assert.deepEqual(detectPlots(boxes, [plot], () => 'new'), [], 'nearness alone dissolves the plot');
  const ids = plotJoinIds(plot, [{ id: 'd', resourceId: 'd-r', projectId: 'acme' }], new Set(), boxes.length);
  assert.deepEqual(ids, ['d']);
  assert.deepEqual(detectPlots(boxes, [plot], () => 'new', [], [{ plotId: 'P', projectId: 'acme', memberIds: ids }]), [{ id: 'P', projectId: 'acme', memberIds: ['a', 'b', 'c', 'd'] }]);
  assert.deepEqual(plotJoinIds(plot, [{ id: 'd', resourceId: 'd-r', projectId: 'acme' }], new Set(), 20), [], 'a bigger project holds it by nearness');
});
