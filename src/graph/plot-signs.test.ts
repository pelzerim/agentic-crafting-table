import test from 'node:test';
import assert from 'node:assert/strict';
import { PLOT_SIGN_SPOTS, placePlotSigns, plotSignSize } from './plot-signs.ts';

const plot = { id: 'billing', bounds: { left: 0, top: 0, right: 600, bottom: 300 }, width: 160, height: 20 };

test('six candidate spots on the plot edge, the first free one in reading order', () => {
  assert.equal(PLOT_SIGN_SPOTS.length, 6);
  const placed = placePlotSigns([plot], [], [], new Map());
  assert.deepEqual(placed.get('billing'), { x: 0, y: -20, spot: 0 });
});

test('a spot is rejected if it would cover a card, the project title or another sign', () => {
  const card = { x: -10, y: -40, width: 200, height: 30 }, title = { x: 200, y: -60, width: 220, height: 48 };
  assert.deepEqual(placePlotSigns([plot], [card, title], [], new Map()).get('billing'), { x: 440, y: -20, spot: 2 });
  const second = { ...plot, id: 'uploads' };
  const both = placePlotSigns([plot, second], [], [], new Map());
  assert.equal(both.get('billing')!.spot, 0); assert.equal(both.get('uploads')!.spot, 1, 'signs never cover each other');
});

test('among free spots the one crossing the fewest links wins, then reading order', () => {
  const link = { from: { x: 80, y: -100 }, to: { x: 80, y: 100 } };
  assert.equal(placePlotSigns([plot], [], [link], new Map()).get('billing')!.spot, 1);
});

test('a chosen spot is kept while it stays valid, so the sign does not wander', () => {
  assert.equal(placePlotSigns([plot], [], [], new Map([['billing', 4]])).get('billing')!.spot, 4);
  const card = { x: 200, y: 290, width: 200, height: 40 };
  assert.equal(placePlotSigns([plot], [card], [], new Map([['billing', 4]])).get('billing')!.spot, 0, 'an invalid kept spot is replaced');
});

test('with every spot covered the sign sits at the inner top-left, behind cards', () => {
  const cover = { x: -500, y: -500, width: 2000, height: 2000 };
  assert.deepEqual(placePlotSigns([plot], [cover], [], new Map()).get('billing'), { x: 8, y: 8, spot: -1 });
});

test('sign size is constant on screen, so it grows in world units as the map zooms out', () => {
  const near = plotSignSize('Billing plan switch', 1), mid = plotSignSize('Billing plan switch', .5);
  assert.equal(near.height, 20); assert.equal(mid.height, 40); assert.equal(mid.width, near.width * 2);
  assert.ok(plotSignSize('Image cache leak investigation', 1).width <= plotSignSize('x'.repeat(24), 1).width, 'long names are cut at 24 characters');
  assert.equal(plotSignSize('Billing plan switch', 1, true).width, near.width + 14, 'a pinned sign holds an 8 px pin and its gap');
  assert.equal(plotSignSize('Billing plan switch', .5, true).width, mid.width + 28);
});
