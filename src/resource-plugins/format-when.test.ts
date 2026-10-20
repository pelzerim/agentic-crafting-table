import test from 'node:test';
import assert from 'node:assert/strict';
import { formatWhen } from './format-when.ts';

const now = new Date(2026, 8, 30, 14, 2, 30).getTime();
const minutes = (count: number) => now - count * 60_000;

test('relative time within a day, never seconds', () => {
  assert.equal(formatWhen(now - 5_000, 'relative', now), 'just now');
  assert.equal(formatWhen(now + 20_000, 'relative', now), 'just now');
  assert.equal(formatWhen(minutes(2), 'relative', now), '2 min ago');
  assert.equal(formatWhen(minutes(18), 'relative', now), '18 min ago');
  assert.equal(formatWhen(minutes(3 * 60 + 5), 'relative', now), '3 h ago');
});

test('beyond a day the relative mode falls back to a short date with time', () => {
  assert.equal(formatWhen(new Date(2026, 8, 25, 14, 13, 20), 'relative', now), 'Sep 25, 14:13');
  assert.equal(formatWhen(new Date(2025, 11, 31, 9, 5), 'relative', now), 'Dec 31, 2025, 09:05');
});

test('time mode is the clock only, whatever the day', () => {
  assert.equal(formatWhen(minutes(1), 'time', now), '14:01');
  assert.equal(formatWhen(new Date(2026, 8, 29, 23, 59), 'time', now), '23:59');
});

test('stamp, short, day and full modes', () => {
  assert.equal(formatWhen(minutes(1), 'stamp', now), '14:01');
  assert.equal(formatWhen(new Date(2026, 8, 29, 23, 59), 'stamp', now), 'Sep 29, 23:59');
  assert.equal(formatWhen(new Date(2026, 8, 25, 14, 13, 20), 'short', now), 'Sep 25, 14:13');
  assert.equal(formatWhen(new Date(2026, 8, 25, 14, 13, 20), 'day', now), 'Sep 25');
  assert.equal(formatWhen(new Date(2024, 0, 2), 'day', now), 'Jan 2, 2024');
  assert.equal(formatWhen(new Date(2026, 8, 25, 14, 13, 20), 'full', now), 'Sep 25, 2026, 14:13');
});

test('accepts ISO strings and epoch numbers; invalid values format as empty', () => {
  const iso = new Date(2026, 8, 25, 14, 13).toISOString();
  assert.equal(formatWhen(iso, 'short', now), 'Sep 25, 14:13');
  assert.equal(formatWhen(Date.parse(iso), 'short', now), 'Sep 25, 14:13');
  for (const value of [undefined, null, '', 'not a date', Number.NaN]) assert.equal(formatWhen(value, 'full', now), '');
});
