import test from 'node:test';
import assert from 'node:assert/strict';
import { freshnessCopy, staleNotice } from './view-header.ts';

const now = new Date(2026, 8, 30, 14, 4).getTime(), observedAt = new Date(2026, 8, 30, 14, 2).toISOString();

test('fresh reads say when they were read, with the full time in the tooltip', () => {
  assert.deepEqual(freshnessCopy({ observedAt, provider: 'Notion' }, now), { text: 'Read 2 min ago', title: 'Read from Notion Sep 30, 2026, 14:02', stale: false });
  assert.equal(freshnessCopy({ observedAt: new Date(now - 10_000).toISOString(), provider: 'GitHub' }, now).text, 'Read just now');
});

test('stale reads are a saved copy stamped with the saved time and carry the error', () => {
  assert.deepEqual(freshnessCopy({ observedAt, stale: true, error: 'Page access was removed.', provider: 'Notion' }, now), { text: 'Saved copy · 14:02', title: 'Page access was removed.', stale: true });
  assert.equal(freshnessCopy({ observedAt: new Date(2026, 8, 25, 9, 14).toISOString(), stale: true, provider: 'Slack' }, now).text, 'Saved copy · Sep 25, 09:14');
  assert.equal(freshnessCopy({ stale: true, provider: 'Slack' }, now).text, 'Saved copy');
});

test('one stale banner wording for every provider', () => {
  assert.equal(staleNotice({ observedAt, stale: true, error: 'Page access was removed.', provider: 'Notion' }, now), 'Couldn’t refresh from Notion. Page access was removed. You’re reading the copy saved at 14:02.');
  assert.equal(staleNotice({ stale: true, error: 'Slack is unreachable', provider: 'Slack' }, now), 'Couldn’t refresh from Slack. Slack is unreachable.');
  assert.equal(staleNotice({ observedAt, stale: true, provider: 'GitHub' }, now), 'Couldn’t refresh from GitHub. Refresh is unavailable. You’re reading the copy saved at 14:02.');
});
