import { useLayoutEffect } from 'react';
import type { RefObject } from 'react';

const easing = 'cubic-bezier(.2,.8,.2,1)';

/** Positions are already final; only transforms/opacity animate on the compositor.
 * Cancelling leaves the normal CSS layout, including when motion is reduced. */
export function usePickerMotion(seed: RefObject<HTMLElement | null>, ring: RefObject<HTMLElement | null>, layer: string) {
  useLayoutEffect(() => {
    const center = seed.current;
    if (!center) return;
    const media = matchMedia('(prefers-reduced-motion: reduce)');
    if (media.matches) return;
    const animation = center.animate([
      { transform: 'translate(-50%,-50%) scale(0)', opacity: 0 },
      { transform: 'translate(-50%,-50%) scale(1)', opacity: 1 },
    ], { duration: 180, easing });
    animation.id = 'picker-seed-enter';
    const reduce = () => { if (media.matches) animation.cancel(); };
    media.addEventListener('change', reduce);
    return () => { animation.cancel(); media.removeEventListener('change', reduce); };
  }, [seed]);

  useLayoutEffect(() => {
    const center = seed.current;
    if (!center) return;
    const media = matchMedia('(prefers-reduced-motion: reduce)');
    if (media.matches) return;
    if (!ring.current) return;
    const animations = [...ring.current.querySelectorAll<HTMLElement>('.picker-choice')].map((choice, index) => {
      const dx = center.offsetLeft - choice.offsetLeft, dy = center.offsetTop - choice.offsetTop;
      const animation = choice.animate([
        { transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) scale(0)`, opacity: 0 },
        { transform: 'translate(-50%,-50%) scale(1)', opacity: 1 },
      ], { duration: 280, delay: 60 + index * 12, easing, fill: 'backwards' });
      animation.id = 'picker-choice-enter';
      return animation;
    });
    const reduce = () => { if (media.matches) animations.forEach(animation => animation.cancel()); };
    media.addEventListener('change', reduce);
    return () => { animations.forEach(animation => animation.cancel()); media.removeEventListener('change', reduce); };
  }, [seed, ring, layer]);
}
