import test from 'node:test';
import assert from 'node:assert/strict';
import { UPDATE_REFUSED, afterUpdate, failureReason } from './update-restart-check.mjs';

test('after the updater, success needs the installed version; a checkout left on the tag by a failed build is rebuilt', () => {
  assert.equal(afterUpdate({ tag: 'v0.7.0', installed: '0.7.0', tagsAtHead: ['v0.7.0'] }), 'installed');
  assert.equal(afterUpdate({ tag: 'v0.7.0', installed: '0.10.0', tagsAtHead: [] }), 'installed', 'versions compare by number');
  assert.equal(afterUpdate({ tag: 'v0.7.0', installed: '0.6.0', tagsAtHead: ['v0.7.0'] }), 'rebuild');
  assert.equal(afterUpdate({ tag: 'v0.7.0', installed: undefined, tagsAtHead: ['v0.7.0'] }), 'rebuild');
  assert.equal(afterUpdate({ tag: 'v0.7.0', installed: '0.6.0', tagsAtHead: ['v0.8.0'] }), 'rebuild', 'a release newer than the one offered counts');
  assert.equal(afterUpdate({ tag: 'v0.7.0', installed: '0.6.0', tagsAtHead: ['v0.6.0', ''] }), 'failed');
});

test('a refusal reaches Settings with its reason, however many files it lists', () => {
  const files = Array.from({ length: 17 }, (_, index) => `  src/file-${index}.ts`);
  const refusal = `The checkout has local changes; commit, stash or discard them first:\n${files.join('\n')}`;
  assert.equal(failureReason(`${UPDATE_REFUSED}${refusal}\n`), refusal);
  assert.equal(failureReason(`warning: redirecting to the remote\n${UPDATE_REFUSED}No release tag (vX.Y.Z) was found on the remote.\n`), 'No release tag (vX.Y.Z) was found on the remote.');
});

test('a thrown error reports its own line, and output without one reports its end', () => {
  assert.equal(failureReason('node:internal/errors:1\n\nError: Command failed: npm ci\n    at run (update-local.mjs:10:1)\n'), 'Command failed: npm ci');
  assert.equal(failureReason('TypeError: no\n    at main\n'), 'no');
  const log = Array.from({ length: 20 }, (_, index) => `line ${index}`);
  assert.equal(failureReason(log.join('\n')), log.slice(-12).join('\n'));
});
