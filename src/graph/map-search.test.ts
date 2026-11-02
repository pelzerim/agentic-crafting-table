import test from 'node:test';
import assert from 'node:assert/strict';
import type { GraphNode } from './graph.ts';
import { recentOnMap, rememberOpened, searchMap } from './map-search.ts';

const AT = '2026-11-02T00:00:00.000Z';
const project = (id: string, title: string, extra: Partial<GraphNode> = {}): GraphNode => ({ id, title, position: { x: 0, y: 0 }, ...extra });
const item = (id: string, title: string, projectId?: string, extra: Partial<GraphNode> = {}): GraphNode => ({ id, title, resourceId: `${id}-r`, projectId, position: { x: 0, y: 0 }, ...extra });

const nodes: GraphNode[] = [
  project('billing', 'Billing redesign'), project('infra', 'Infra'), project('old', 'Old work', { belowAt: AT }),
  item('plan', 'Plan switcher', 'billing'), item('invoice', 'Invoice emails', 'billing'), item('runner', 'Runner plan review', 'infra'),
  item('loose', 'Loose plan note'), item('sent', 'Plan from last month', 'billing', { belowAt: AT }), item('gone', 'Plan archived', 'billing', { archivedAt: AT }),
  item('quiet', 'Plan hidden', 'infra', { hiddenAt: AT }), item('buried', 'Plan in old work', 'old'),
];

test('finds items on the map whose title or project holds every word, titles that start with the query first', () => {
  assert.deepEqual(searchMap(nodes, 'plan').map(match => match.id), ['plan', 'runner', 'loose']);
  assert.deepEqual(searchMap(nodes, 'billing plan'), [{ id: 'plan', title: 'Plan switcher', project: 'Billing redesign' }]);
  assert.deepEqual(searchMap(nodes, 'INVOICE'), [{ id: 'invoice', title: 'Invoice emails', project: 'Billing redesign' }]);
});

test('leaves out projects, and items below the map, archived or hidden', () => {
  const found = searchMap(nodes, 'plan', Infinity).map(match => match.id);
  for (const id of ['sent', 'gone', 'quiet', 'buried', 'billing']) assert.ok(!found.includes(id), id);
  assert.deepEqual(searchMap(nodes, 'infra').map(match => match.id), ['runner']);
});

test('an empty query finds nothing, and the limit caps the list', () => {
  assert.deepEqual(searchMap(nodes, '  '), []);
  assert.equal(searchMap(nodes, 'plan', 2).length, 2);
});

test('an item outside any project has no project line', () => {
  assert.deepEqual(searchMap(nodes, 'loose'), [{ id: 'loose', title: 'Loose plan note', project: undefined }]);
});

test('the most recently opened items on the map come first, without the ones no longer on it', () => {
  assert.deepEqual(recentOnMap(nodes, ['runner', 'gone', 'plan', 'missing', 'sent', 'loose']).map(match => match.id), ['runner', 'plan', 'loose']);
  assert.deepEqual(recentOnMap(nodes, ['plan']), [{ id: 'plan', title: 'Plan switcher', project: 'Billing redesign' }]);
  assert.equal(recentOnMap(nodes, ['runner', 'plan', 'loose'], 2).length, 2);
});

test('opening an item puts it first in the recent list, once, and the list keeps twenty', () => {
  assert.deepEqual(rememberOpened(['a', 'b', 'c'], 'b'), ['b', 'a', 'c']);
  assert.deepEqual(rememberOpened(undefined, 'a'), ['a']);
  const long = Array.from({ length: 20 }, (_, index) => `n${index}`);
  assert.deepEqual(rememberOpened(long, 'new'), ['new', ...long.slice(0, 19)]);
});
