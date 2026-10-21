import test from 'node:test';
import assert from 'node:assert/strict';
import { coversChrome } from './chrome-cover.ts';

const chrome = { rail: { x: 12, y: 108, width: 52, height: 380 }, trail: { x: 22, y: 24, width: 420, height: 24 } };
test('a view covers the chrome when it reaches the rail or the trail, and not when it keeps clear of both', () => {
  assert.equal(coversChrome({ x: 80, y: 72, width: 900, height: 600 }, chrome), false, 'the default view sits right of the rail and below the trail');
  assert.equal(coversChrome({ x: 12, y: 72, width: 900, height: 600 }, chrome), true, 'over the rail');
  assert.equal(coversChrome({ x: 80, y: 12, width: 900, height: 600 }, chrome), true, 'over the trail');
  assert.equal(coversChrome({ x: 500, y: 12, width: 600, height: 600 }, chrome), false, 'right of the trail text and the rail');
  assert.equal(coversChrome({ x: 64, y: 48, width: 900, height: 600 }, chrome), false, 'touching edges do not count');
});
