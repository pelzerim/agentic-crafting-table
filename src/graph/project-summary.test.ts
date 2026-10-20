import test from 'node:test';
import assert from 'node:assert/strict';
import { activityAge } from './project-summary.ts';

test('activity age reads as recency in minutes, hours or days', () => {
  const now = Date.parse('2026-09-30T10:08:00.000Z');
  assert.equal(activityAge('2026-09-30T10:05:00.000Z', now), 'active 3m ago');
  assert.equal(activityAge('2026-09-30T10:07:40.000Z', now), 'active just now');
  assert.equal(activityAge('2026-09-30T07:08:00.000Z', now), 'active 3h ago');
  assert.equal(activityAge('2026-09-28T10:08:00.000Z', now), 'active 2d ago');
  assert.equal(activityAge(undefined, now), '');
});
