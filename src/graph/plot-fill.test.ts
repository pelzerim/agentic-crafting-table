import test from 'node:test';
import assert from 'node:assert/strict';
import { plotFill } from './plot-fill.ts';

const rect = (left: number, top: number, right: number, bottom: number) => [{ x: left, y: top }, { x: right, y: top }, { x: right, y: bottom }, { x: left, y: bottom }];
function cells(fill: ReturnType<typeof plotFill>) {
  const result = new Map<string, number>();
  fill.paths.forEach((path, shade) => {
    for (const match of path.matchAll(/M(-?[\d.]+),(-?[\d.]+)h([\d.]+)v([\d.]+)h-[\d.]+Z/g)) {
      const [, x, y, width, height] = match.map(Number);
      for (let dy = 0; dy < height; dy += 24) for (let dx = 0; dx < width; dx += 24) result.set(`${x + dx},${y + dy}`, shade);
    }
  });
  return result;
}

test('the patch is painted on the 24 px world grid with a lighter interior and a softer edge ring', () => {
  const painted = cells(plotFill(rect(0, 0, 120, 120), rect(-1000, -1000, 1000, 1000)));
  assert.equal(painted.size, 25);
  assert.equal(painted.get('48,48'), 0, 'interior'); assert.equal(painted.get('0,0'), 1, 'edge'); assert.equal(painted.get('96,48'), 1);
});

test('the patch is clipped to its own project field', () => {
  const painted = cells(plotFill(rect(0, 0, 240, 120), rect(0, -500, 120, 500)));
  assert.equal(painted.size, 25);
  assert.ok([...painted.keys()].every(key => Number(key.split(',')[0]) < 120));
  assert.deepEqual(plotFill(rect(0, 0, 120, 120), rect(500, 500, 600, 600)).paths, ['', '']);
});
