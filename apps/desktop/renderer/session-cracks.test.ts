import test from 'node:test';
import assert from 'node:assert/strict';
import { crackLabel, crackLevel, crackPaths } from './session-cracks.ts';

const DAY = 86_400_000, now = Date.parse('2026-03-30T12:00:00.000Z');
const ago = (days: number) => new Date(now - days * DAY).toISOString();

test('a session cracks once a week after its last activity, more at two weeks, most at four', () => {
  assert.equal(crackLevel({ activityAt: ago(6.9) }, now), 0);
  assert.equal(crackLevel({ activityAt: ago(7) }, now), 1);
  assert.equal(crackLevel({ activityAt: ago(13) }, now), 1);
  assert.equal(crackLevel({ activityAt: ago(14) }, now), 2);
  assert.equal(crackLevel({ activityAt: ago(27) }, now), 2);
  assert.equal(crackLevel({ activityAt: ago(28) }, now), 3);
  assert.equal(crackLevel({ activityAt: ago(400) }, now), 3);
});

test('the later of the last activity and the last turn end counts', () => {
  assert.equal(crackLevel({ activityAt: ago(30), turnEndedAt: ago(2) }, now), 0);
  assert.equal(crackLevel({ activityAt: ago(8), turnEndedAt: ago(20) }, now), 1);
  assert.equal(crackLevel({ turnEndedAt: ago(15) }, now), 2);
});

test('a working session or one with no known activity never cracks', () => {
  assert.equal(crackLevel({ activity: 'working', activityAt: ago(30) }, now), 0);
  assert.equal(crackLevel({}, now), 0);
  assert.equal(crackLevel({ activityAt: 'not a date' }, now), 0);
  assert.equal(crackLevel({ activityAt: ago(-3) }, now), 0);
});

test('the label says how long the session has been quiet', () => {
  assert.equal(crackLabel({ activityAt: ago(9) }, now), 'Quiet for 1 week');
  assert.equal(crackLabel({ activityAt: ago(16) }, now), 'Quiet for 2 weeks');
  assert.equal(crackLabel({ activityAt: ago(60) }, now), 'Quiet for 8 weeks');
  assert.equal(crackLabel({ activityAt: ago(2) }, now), undefined);
});

test('cracks start on the card edge, stay within 16 px of it, and each level adds to the one before', () => {
  for (const [width, height] of [[240, 110], [340, 48], [520, 260]]) {
    const counts = [1, 2, 3].map(level => crackPaths(level, width, height).length);
    assert.ok(counts[0] < counts[1] && counts[1] < counts[2], String(counts));
    assert.deepEqual(crackPaths(3, width, height).slice(0, counts[1]), crackPaths(2, width, height));
    for (const path of crackPaths(3, width, height)) {
      const points = [...path.matchAll(/-?\d+(?:\.\d+)? -?\d+(?:\.\d+)?/g)].map(match => match[0].split(' ').map(Number));
      for (const [x, y] of points) {
        assert.ok(x >= 0 && x <= width && y >= 0 && y <= height, `${path} inside ${width}×${height}`);
        assert.ok(Math.min(x, width - x, y, height - y) <= 16, `${path} near the edge of ${width}×${height}`);
      }
    }
    for (const path of crackPaths(3, width, height).filter((_, index) => [0, 2, 4, 5, 7, 8].includes(index))) {
      const [x, y] = path.slice(1).split(' L')[0].split(' ').map(Number);
      assert.ok(x === 0 || y === 0 || x === width || y === height, `${path} starts on the edge`);
    }
  }
});
