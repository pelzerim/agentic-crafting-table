import assert from 'node:assert/strict';
import test from 'node:test';
import { stepMarks } from './mark-clock.ts';

const animation = (overrides: Record<string, unknown> = {}) => ({ animationName: 'graze-walk', playState: 'running', playbackRate: 1, currentTime: 1000, effect: { getTiming: () => ({ iterations: Infinity }) }, ...overrides });
const step = (...animations: ReturnType<typeof animation>[]) => stepMarks({ getAnimations: () => animations } as unknown as Element);

test('a looping mark stops running every frame and moves one tick at a time', () => {
  const mark = animation();
  step(mark); step(mark);
  assert.equal(mark.playbackRate, 0);
  assert.equal(mark.currentTime, 1250);
});

test('a mark the stylesheet paused stays where it is, behind an open item or in a muted project', () => {
  const mark = animation({ playState: 'paused', playbackRate: 0 });
  step(mark);
  assert.equal(mark.currentTime, 1000);
});

test('a one-shot moment and other map animations keep their own timing', () => {
  const moment = animation({ animationName: 'graze-trot', effect: { getTiming: () => ({ iterations: 5 }) } }), locator = animation({ animationName: 'locator-pulse' });
  step(moment, locator);
  for (const other of [moment, locator]) { assert.equal(other.playbackRate, 1); assert.equal(other.currentTime, 1000); }
});
