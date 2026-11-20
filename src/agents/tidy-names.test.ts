import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRegroupReply } from './tidy-names.ts';

const sample = { project: 'Acme', plots: [{ id: 'p1', name: 'Checkout flow' }, { id: 'p2', name: 'Search index' }],
  items: [{ id: 'a', title: 'Fix cart total', plot: 'p2' }, { id: 'b', title: 'Rebuild index', plot: 'p2' }, { id: 'c', title: 'Invoice email', plot: null }] };

test('regroup keeps only valid moves to known plots or plain new names', () => {
  const reply = JSON.stringify({ moves: [
    { item: 'a', plot: 'p1' }, { item: 'a', plot: 'p2' }, { item: 'b', plot: 'p2' }, { item: 'c', newPlot: 'Invoice emails' },
    { item: 'ghost', plot: 'p1' }, { item: 'b', plot: 'elsewhere' }, { item: 'b', plot: 'p1', newPlot: 'Both' }, { item: 'c', newPlot: '<b>x</b>' },
  ] });
  assert.deepEqual(parseRegroupReply(reply, sample), [{ itemId: 'a', plotId: 'p1' }, { itemId: 'c', newPlot: 'Invoice emails' }]);
  for (const bad of ['not json', '{"moves":{}}', 'null', '[]']) assert.deepEqual(parseRegroupReply(bad, sample), []);
});

