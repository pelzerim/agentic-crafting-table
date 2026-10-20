import test from 'node:test';
import assert from 'node:assert/strict';
import { neighborhoodStylePin, pinNeighborhoodStyle, pinnedNeighborhoodStyle } from './neighborhood-style-pin.ts';
import { DEFAULT_NEIGHBORHOOD_APPEARANCE } from '../../src/graph/neighborhood-fill.ts';

test('only a test run can pin how neighborhoods are drawn', () => {
  assert.equal(neighborhoodStylePin(true, 'plain'), 'plain'); assert.equal(neighborhoodStylePin(true, 'biome'), 'biome');
  for (const value of [undefined, '', 'setting', 'fancy']) assert.equal(neighborhoodStylePin(true, value), undefined);
  assert.equal(neighborhoodStylePin(false, 'plain'), undefined);
});

test('the pin reaches the renderer in the page address and replaces only the drawn style', () => {
  assert.equal(pinnedNeighborhoodStyle('?neighborhoods=plain'), 'plain'); assert.equal(pinnedNeighborhoodStyle('?spike=1&neighborhoods=biome'), 'biome');
  for (const search of ['', '?spike=1', '?neighborhoods=fancy']) assert.equal(pinnedNeighborhoodStyle(search), undefined);
  const saved = { ...DEFAULT_NEIGHBORHOOD_APPEARANCE, pixelSize: 32, texture: 'full' as const };
  assert.deepEqual(pinNeighborhoodStyle(saved, 'plain'), { ...saved, style: 'plain' });
  assert.equal(pinNeighborhoodStyle(saved, undefined), saved); assert.equal(pinNeighborhoodStyle(saved, 'biome'), saved);
});
