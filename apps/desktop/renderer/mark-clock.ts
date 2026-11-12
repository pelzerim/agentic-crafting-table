/** Marks change their picture about 8 times a second at most, yet the browser recalculates style for a running
 * `steps()` animation on every frame. */
const TICK_MS = 125;

const isLoopingMark = (animation: Animation) => (animation as CSSAnimation).animationName?.startsWith('graze-') && animation.effect?.getTiming().iterations === Infinity;

/** Moves every looping mark one tick. Rate 0 ends its per-frame work. Unlike `pause()`, it leaves the play state with the
 * stylesheet, which pauses marks behind an open item and in a muted project: those report `paused` and stay where they are. */
export function stepMarks(area: Element) {
  // Reading an animation's state flushes style, so read every mark before moving any.
  const marks = area.getAnimations({ subtree: true }).filter(animation => animation.playState === 'running' && isLoopingMark(animation)).map(animation => ({ animation, time: Number(animation.currentTime) }));
  for (const { animation, time } of marks) {
    if (animation.playbackRate) animation.playbackRate = 0;
    animation.currentTime = time + TICK_MS;
  }
}

export function startMarkClock(area: Element) {
  const timer = setInterval(() => { if (!document.hidden) stepMarks(area); }, TICK_MS);
  return () => clearInterval(timer);
}
