import test from 'node:test';
import assert from 'node:assert/strict';
import { cueCount, fitIndicators } from './card-indicators.ts';

test('only pure count phrases and fractions have a count form', () => {
  assert.equal(cueCount('3 unseen comments'), '3');
  assert.equal(cueCount('12 comments'), '12');
  assert.equal(cueCount('2 running'), '2');
  assert.equal(cueCount('1/3 done'), '1/3');
  assert.equal(cueCount('4/7 jobs'), '4/7');
  assert.equal(cueCount('gate <1m'), undefined);
  assert.equal(cueCount('Approved'), undefined);
  assert.equal(cueCount('3 days ago'), undefined);
  assert.equal(cueCount('12m 4s'), undefined);
  assert.equal(cueCount('attempt 2'), undefined);
  assert.equal(cueCount('Validating · Codex · 2/5'), undefined);
});

test('status cues keep their labels while they fit, then counts shrink to their number and other cues truncate', () => {
  assert.deepEqual(fitIndicators(['Approved', '3 unseen comments'], 400), [{ text: 'Approved', short: false }, { text: '3 unseen comments', short: false }]);
  assert.deepEqual(fitIndicators(['Approved', '3 unseen comments'], 150), [{ text: 'Approved', short: false }, { text: '3', short: true }], 'the later cue gives way first');
  assert.deepEqual(fitIndicators(['Checks failing on main', '12 unseen comments'], 70), [{ text: 'Checks failing on main', short: true }, { text: '12', short: true }], 'a cue without a count keeps its label to truncate');
  assert.deepEqual(fitIndicators(['Waiting approval', 'gate <1m', '1/3 done'], 200), [{ text: 'Waiting approval', short: false }, { text: 'gate <1m', short: true }, { text: '1/3', short: true }]);
  assert.deepEqual(fitIndicators([], 100), []);
});
