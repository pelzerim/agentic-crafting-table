import test from 'node:test';
import assert from 'node:assert/strict';
import { placeClear } from './placement.ts';
import { intersects } from '../../../../src/graph/label-placement.ts';

const canvas = { width: 1280, height: 800 }, size = { width: 300, height: 280 };

test('a panel opens beside its endpoints without covering either of them', () => {
  const source = { x: 750, y: 285, width: 120, height: 50 }, target = { x: 520, y: 235, width: 145, height: 65 };
  const at = placeClear(size, [source, target], [], canvas);
  const panel = { ...at, ...size };
  assert.ok(!intersects(panel, source, 0) && !intersects(panel, target, 0), JSON.stringify(at));
  assert.ok(at.x >= 12 && at.y >= 12 && at.x + size.width <= canvas.width - 12 && at.y + size.height <= canvas.height - 12);
});

test('it also avoids floating chrome and falls back to the least covered spot', () => {
  const source = { x: 900, y: 300, width: 150, height: 50 };
  const chrome = [{ x: 1046, y: 600, width: 220, height: 190 }, { x: 12, y: 108, width: 56, height: 160 }];
  const panel = { ...placeClear(size, [source], chrome, canvas), ...size };
  for (const rect of [source, ...chrome]) assert.ok(!intersects(panel, rect, 0), JSON.stringify(panel));
  const crowded = placeClear(size, [{ x: 0, y: 0, width: 1280, height: 800 }], [], canvas);
  assert.ok(crowded.x >= 12 && crowded.y >= 12);
});
