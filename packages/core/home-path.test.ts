import test from 'node:test';
import assert from 'node:assert/strict';
import { expandHomePath } from './home-path.ts';

test('a leading ~ stands for the home directory; any other path is returned as it is', () => {
  assert.equal(expandHomePath('~', '/Users/example'), '/Users/example');
  assert.equal(expandHomePath('~/notes/plan.md', '/Users/example'), '/Users/example/notes/plan.md');
  assert.equal(expandHomePath('/work/plan.md', '/Users/example'), '/work/plan.md');
  assert.equal(expandHomePath('~other/plan.md', '/Users/example'), '~other/plan.md');
  assert.equal(expandHomePath('notes/~/plan.md', '/Users/example'), 'notes/~/plan.md');
});
