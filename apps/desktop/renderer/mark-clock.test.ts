import assert from 'node:assert/strict';
import test from 'node:test';
import { nextPicture, stepMarks } from './mark-clock.ts';

const stepped = (steps: number, offsets = [0, 1]) => offsets.map(computedOffset => ({ computedOffset, easing: `steps(${steps})` }));
/** The leg of a walking sheep by default: two pictures in 333 ms. */
const animation = (overrides: Record<string, unknown> = {}, timing: Record<string, unknown> = {}, frames: { computedOffset: number; easing: string }[] = stepped(2)) => ({
  animationName: 'graze-leg', playState: 'running', playbackRate: 1, currentTime: 0, effect: { getTiming: () => ({ iterations: Infinity, duration: 333, delay: 0, direction: 'normal', ...timing }), getKeyframes: () => frames }, ...overrides });
const look = (elapsed: number, ...animations: ReturnType<typeof animation>[]) => stepMarks({ getAnimations: () => animations } as unknown as Element, elapsed);

test('a looping mark stops running every frame and moves only when its picture changes', () => {
  const leg = animation();
  assert.equal(look(40, leg), 1, 'the first look only holds it');
  assert.deepEqual([leg.playbackRate, leg.currentTime], [0, 0]);
  for (let looks = 0; looks < 3; looks++) look(40, leg);
  assert.equal(leg.currentTime, 0, '120 ms is still the first picture');
  look(40, leg);
  assert.equal(Math.round(leg.currentTime * 10), 1665, 'the look nearest to 166.5 ms shows the second picture, just past its jump');
  for (let looks = 0; looks < 3; looks++) look(40, leg);
  assert.equal(Math.round(leg.currentTime * 10), 1665);
  look(40, leg);
  assert.equal(Math.round(leg.currentTime), 333, 'the next turn');
});

test('marks of different pace each keep their own pace on the same looks', () => {
  const leg = animation(), walk = animation({ animationName: 'graze-walk' }, { duration: 1000 }, stepped(4));
  const holds = { leg: [] as number[], walk: [] as number[] };
  look(0, leg, walk);
  for (let looks = 1, shown = { leg: [0, 0], walk: [0, 0] }; looks <= 240; looks++) {
    look(1000 / 24, leg, walk);
    for (const [name, mark] of [['leg', leg], ['walk', walk]] as const) if (mark.currentTime !== shown[name][0]) { holds[name].push(looks - shown[name][1]); shown[name] = [mark.currentTime, looks]; }
  }
  assert.deepEqual(holds, { leg: Array(60).fill(4), walk: Array(40).fill(6) }, 'ten seconds: a leg picture every 4 looks, a walk step every 6');
});

test('a mark the stylesheet paused stays where it is, behind an open item or in a muted project, and goes on from there', () => {
  const leg = animation();
  look(0, leg); look(100, leg);
  leg.playState = 'paused';
  assert.equal(look(5000, leg), 0);
  assert.equal(leg.currentTime, 0);
  leg.playState = 'running';
  look(40, leg);
  assert.equal(leg.currentTime, 0, 'the paused time does not count');
  look(40, leg);
  assert.equal(Math.round(leg.currentTime), 180);
});

test('a one-shot moment, other map animations and a smooth mark keep their own timing', () => {
  const moment = animation({ animationName: 'graze-trot' }, { iterations: 5 }), locator = animation({ animationName: 'locator-pulse' });
  const smooth = animation({ animationName: 'graze-drift' }, {}, [{ computedOffset: 0, easing: 'linear' }, { computedOffset: 1, easing: 'linear' }]);
  assert.equal(look(0, moment, locator, smooth), 0);
  look(500, moment, locator, smooth);
  for (const other of [moment, locator, smooth]) assert.deepEqual([other.playbackRate, other.currentTime], [1, 0]);
});

test('a mark that changes its shape is read again, and one that starts to move smoothly goes back to the browser', () => {
  const frames = stepped(2), timing = { duration: 333 }, leg = animation({}, {}, frames);
  leg.effect.getTiming = () => ({ iterations: Infinity, delay: 0, direction: 'normal', ...timing });
  look(0, leg);
  // A card that changes its size gives the mark other steps and, with them, another duration.
  timing.duration = 400; frames[0].easing = 'steps(4)';
  look(200, leg); look(100, leg);
  assert.equal(Math.round(leg.currentTime), 300, 'the third of four pictures, which two steps would not show yet');
  timing.duration = 500; frames[0].easing = 'ease';
  look(100, leg);
  assert.deepEqual([leg.playbackRate, Math.round(leg.currentTime)], [1, 400]);
});

test('the next picture follows the lead, the direction and every keyframe of the animation', () => {
  const until = (time: number, timing: Record<string, unknown>, frames = stepped(4)) => { const next = nextPicture(animation({}, { duration: 1000, ...timing }, frames) as unknown as Animation, time); return next && Math.round(next.due * 1e6) / 1e6; };
  assert.equal(until(100, {}), 150);
  assert.equal(until(250, {}), 250, 'a picture starts on its jump');
  assert.equal(until(100, { delay: -200 }), 200, 'a lead is time the animation already ran');
  assert.equal(until(100, { delay: 300 }), 200, 'a mark that waits to start changes when it starts');
  assert.equal(until(1100, { direction: 'alternate' }), 150, 'the turn back runs the same steps');
  assert.equal(until(1250, { direction: 'alternate' }), 0, 'a turn back leaves a picture just below its jump');
  assert.equal(until(100, { direction: 'reverse' }), 150);
  // The flowers: one picture until 30%, the other until the end.
  const bloom = [{ computedOffset: 0, easing: 'steps(1)' }, { computedOffset: 0.3, easing: 'steps(1)' }, { computedOffset: 1, easing: 'steps(1)' }];
  assert.equal(until(100, {}, bloom), 200);
  assert.equal(until(300, {}, bloom), 700);
  assert.equal(until(100, {}, [{ computedOffset: 0, easing: 'steps(2)' }, { computedOffset: 1, easing: 'linear' }]), 400, 'the easing of the last keyframe leads nowhere');
  assert.equal(until(100, {}, [{ computedOffset: 0, easing: 'steps(2, start)' }, { computedOffset: 1, easing: 'linear' }]), undefined);
  assert.equal(until(100, { duration: 0 }), undefined);
});
