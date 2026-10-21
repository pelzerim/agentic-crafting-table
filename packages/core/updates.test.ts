import test from 'node:test';
import assert from 'node:assert/strict';
import { compareVersions, newestTag, parseVersionTag, updateOffers } from './updates.ts';

test('release tags are v-prefixed dotted numbers; anything else is not a release', () => {
  assert.deepEqual(parseVersionTag('v1.2.3'), [1, 2, 3]);
  assert.deepEqual(parseVersionTag('v0.10.0'), [0, 10, 0]);
  assert.deepEqual(parseVersionTag('1.2.3'), [1, 2, 3]);
  for (const tag of ['v1.2', 'v1.2.3-rc.1', 'latest', 'v1.2.3^{}', 'va.b.c', '', 'v01.2.3']) assert.equal(parseVersionTag(tag), undefined, tag);
});

test('versions compare numerically per part, so v1.10.0 is newer than v1.9.9', () => {
  assert.ok(compareVersions([1, 10, 0], [1, 9, 9]) > 0);
  assert.ok(compareVersions([0, 2, 0], [0, 2, 1]) < 0);
  assert.equal(compareVersions([2, 0, 0], [2, 0, 0]), 0);
});

test('the newest tag ignores non-release names and dereferenced annotated tags', () => {
  assert.equal(newestTag(['v0.1.0', 'v0.2.0', 'v0.2.0^{}', 'v0.10.0', 'nightly', 'v0.9.1']), 'v0.10.0');
  assert.equal(newestTag(['main', 'latest']), undefined);
  assert.equal(newestTag([]), undefined);
});

test('an offer is made only for a newer release the person has not dismissed', () => {
  const tags = ['v0.1.0', 'v0.2.0'];
  assert.deepEqual(updateOffers({ current: '0.1.0', tags }), { latest: 'v0.2.0', available: true });
  assert.deepEqual(updateOffers({ current: '0.2.0', tags }), { latest: 'v0.2.0', available: false });
  assert.deepEqual(updateOffers({ current: '0.3.0', tags }), { latest: 'v0.2.0', available: false });
  assert.deepEqual(updateOffers({ current: '0.1.0', tags, dismissed: 'v0.2.0' }), { latest: 'v0.2.0', available: false });
  assert.deepEqual(updateOffers({ current: '0.1.0', tags: ['v0.3.0'], dismissed: 'v0.2.0' }), { latest: 'v0.3.0', available: true }, 'a dismissal covers one version only');
  assert.deepEqual(updateOffers({ current: '0.1.0', tags: [] }), { latest: undefined, available: false });
  assert.deepEqual(updateOffers({ current: 'dev', tags }), { latest: 'v0.2.0', available: false }, 'an unversioned build is never offered an update');
});
