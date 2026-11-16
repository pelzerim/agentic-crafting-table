/** A mark changes its picture a few times a second, yet the browser recalculates style for a running `steps()` animation
 * on every frame. The clock holds each looping mark at rate 0 and moves it only when its picture is due to change. */

/** 24 looks a second: the pictures of the marks stay 125, 167, 250 or 500 ms, which is 3, 4, 6 or 12 looks, so each mark keeps an even pace. */
const TICK_MS = 1000 / 24;
/** How often the clock looks for new marks while it holds none. */
const IDLE_MS = 250;
/** A mark moves on the look nearest to its change, so it can arrive early. This much more puts it past the jump for certain. */
const PAST_JUMP_MS = 0.01;

/** A mark the clock holds: the time it has not shown yet, the time from its shown picture to its next one, and where in one
 * turn its picture changes. False: not a mark the clock holds. */
type Held = { owed: number; due: number; duration: number; jumps: number[] };
const held = new WeakMap<Animation, Held | false>();

const isLoopingMark = (animation: Animation) => Boolean((animation as CSSAnimation).animationName?.startsWith('graze-')) && animation.effect?.getTiming().iterations === Infinity;

/** Where in one turn the picture changes. Undefined when a part of the animation moves smoothly: the browser keeps that one. */
function pictureJumps(effect: KeyframeEffect) {
  const frames = effect.getKeyframes(), jumps = [0, 1];
  if (frames.length < 2) return undefined;
  for (const [index, frame] of frames.slice(0, -1).entries()) {
    const steps = Number(/^steps\((\d+)\)$/.exec(frame.easing)?.[1]), from = frame.computedOffset, span = frames[index + 1].computedOffset - from;
    if (!steps) return undefined;
    for (let step = 0; step < steps; step++) jumps.push(from + span * step / steps);
  }
  return jumps;
}

/** The next change of picture after `time`, as `due` milliseconds from it. Undefined when the clock cannot hold the animation. */
export function nextPicture(animation: Animation, time: number, known?: Pick<Held, 'duration' | 'jumps'>) {
  const effect = animation.effect as KeyframeEffect, { delay = 0, duration, direction = 'normal' } = effect.getTiming();
  if (typeof duration !== 'number' || !(duration > 0)) return undefined;
  // Reading keyframes is slow. Every mark ties its step count to its duration, so its jumps hold until the duration changes.
  const jumps = known?.duration === duration ? known.jumps : pictureJumps(effect);
  if (!jumps) return undefined;
  const turns = (time - delay) / duration, turn = Math.floor(turns);
  if (turns < 0) return { duration, jumps, due: -turns * duration };
  // A step holds its picture from its own start up to the next start, so a turn that runs backwards changes just below a jump.
  const back = direction === 'reverse' || (direction.startsWith('alternate') && (turn % 2 === 1) !== (direction === 'alternate-reverse'));
  const at = back ? 1 - (turns - turn) : turns - turn;
  return { duration, jumps, due: (back ? at - Math.max(...jumps.filter(jump => jump <= at)) : Math.min(...jumps.filter(jump => jump > at)) - at) * duration };
}

/** Counts `elapsed` milliseconds for every running mark and moves those whose picture is due. Returns how many marks run.
 * Rate 0 ends the per-frame work. Unlike `pause()`, it leaves the play state with the stylesheet, which pauses marks
 * behind an open item and in a muted project: those report `paused` and stay where they are. */
export function stepMarks(area: Element, elapsed: number) {
  // Reading an animation's state flushes style, so read every mark before moving any.
  const moves: (() => void)[] = [];
  let running = 0;
  for (const animation of area.getAnimations({ subtree: true })) {
    const mark = held.get(animation);
    if (mark === false || animation.playState !== 'running') continue;
    if (mark && (mark.owed += elapsed) < mark.due - TICK_MS / 2) { running++; continue; }
    const moved = mark ? Math.max(mark.owed, mark.due + PAST_JUMP_MS) : 0, time = Number(animation.currentTime) + moved;
    const next = mark || isLoopingMark(animation) ? nextPicture(animation, time, mark) : undefined;
    // Time moved ahead of the clock stays owed as a negative amount, so the pace of the mark stays exact.
    held.set(animation, next ? { ...next, owed: mark ? mark.owed - moved : 0 } : false);
    if (next) running++;
    // A mark seen for the first time is only held. A mark the clock can no longer hold goes back to the browser.
    // The rate is set only when it changes: setting it costs as much as a move.
    if (mark || next) moves.push(() => { if (!mark || !next) animation.playbackRate = next ? 0 : 1; if (mark) animation.currentTime = time; });
  }
  for (const move of moves) move();
  return running;
}

export function startMarkClock(area: Element) {
  let last = performance.now(), timer: ReturnType<typeof setTimeout>;
  const look = () => {
    const now = performance.now();
    let running = 0;
    // The next look is set in every case, so one failed look does not stop the clock.
    try { if (!document.hidden) running = stepMarks(area, now - last); } finally { last = now; timer = setTimeout(look, running ? TICK_MS : IDLE_MS); }
  };
  timer = setTimeout(look, TICK_MS);
  return () => clearTimeout(timer);
}
