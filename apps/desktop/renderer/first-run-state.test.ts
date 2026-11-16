import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialFirstRunActive } from './first-run-state.ts';

test('only a pristine workspace opens the guide automatically', () => {
  assert.equal(initialFirstRunActive({ revision: 0, nodes: [], resources: [] }, 0), true);
  assert.equal(initialFirstRunActive({ revision: 1, nodes: [], resources: [] }, 0), false, 'clearing an existing workspace is not first run');
  assert.equal(initialFirstRunActive({ revision: 0, nodes: [{}], resources: [] }, 0), false);
  assert.equal(initialFirstRunActive({ revision: 0, nodes: [], resources: [{}] }, 0), false);
  assert.equal(initialFirstRunActive({ revision: 0, nodes: [], resources: [] }, 2), false, 'Undermap is existing work');
});
