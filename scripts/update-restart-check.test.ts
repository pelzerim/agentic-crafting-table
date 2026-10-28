import test from 'node:test';
import assert from 'node:assert/strict';
import { afterUpdate } from './update-restart-check.mjs';

test('after the updater, success needs the installed version; a checkout left on the tag by a failed build is rebuilt', () => {
  assert.equal(afterUpdate({ tag: 'v0.7.0', installed: '0.7.0', tagsAtHead: ['v0.7.0'] }), 'installed');
  assert.equal(afterUpdate({ tag: 'v0.7.0', installed: '0.10.0', tagsAtHead: [] }), 'installed', 'versions compare by number');
  assert.equal(afterUpdate({ tag: 'v0.7.0', installed: '0.6.0', tagsAtHead: ['v0.7.0'] }), 'rebuild');
  assert.equal(afterUpdate({ tag: 'v0.7.0', installed: undefined, tagsAtHead: ['v0.7.0'] }), 'rebuild');
  assert.equal(afterUpdate({ tag: 'v0.7.0', installed: '0.6.0', tagsAtHead: ['v0.8.0'] }), 'rebuild', 'a release newer than the one offered counts');
  assert.equal(afterUpdate({ tag: 'v0.7.0', installed: '0.6.0', tagsAtHead: ['v0.6.0', ''] }), 'failed');
});
