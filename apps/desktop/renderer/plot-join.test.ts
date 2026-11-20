import test from 'node:test';
import assert from 'node:assert/strict';
import { plotJoinIds } from './plot-join.ts';

test('a drop pins into a plot only items that land in its project, so a mixed selection never gets the whole pin refused', () => {
  const landed = [{ id: 'own', resourceId: 'own-r', projectId: 'acme' }, { id: 'other', resourceId: 'other-r', projectId: 'beta' }, { id: 'acme', projectId: undefined }, { id: 'held', resourceId: 'held-r', projectId: 'acme' }, { id: 'free', resourceId: 'free-r', projectId: 'acme' }];
  assert.deepEqual(plotJoinIds({ projectId: 'acme', memberIds: ['held'], locked: true }, landed, new Set()), ['own', 'free']);
  assert.deepEqual(plotJoinIds({ projectId: 'acme', memberIds: [] }, landed, new Set(['own', 'other'])), ['own'], 'an open plot pins only what another plot holds');
  assert.deepEqual(plotJoinIds({ projectId: 'acme', memberIds: [], locked: true }, landed.filter(node => node.projectId !== 'acme'), new Set()), []);
});
