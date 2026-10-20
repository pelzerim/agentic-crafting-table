import { useLayoutEffect } from 'react';
import type { RefObject } from 'react';

export type BubbleBounds = Pick<DOMRect, 'x' | 'y' | 'width' | 'height'>;
export const BUBBLE_MOTION_MS = 280;

/** Project the same surface from its previous screen bounds. Lay out its content
 * once at the destination size; only the compositor animates, not terminal fits
 * or graph geometry. The parent may be a scaled React Flow viewport. */
export function useBubbleMotion(ref: RefObject<HTMLElement | null>, from: BubbleBounds | undefined, settled?: () => void) {
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || !from) return;
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) { settled?.(); return; }
    const to = element.getBoundingClientRect();
    if (!to.width || !to.height || !from.width || !from.height) { settled?.(); return; }
    const style = getComputedStyle(element), transform = new DOMMatrix(style.transform);
    // offsetWidth rounds fractional map dimensions, shifting a long return
    // translation by a pixel. Computed border-box width retains that precision.
    const parentScale = to.width / parseFloat(style.width) / transform.a;
    const start = `translate(${(from.x - to.x) / parentScale}px, ${(from.y - to.y) / parentScale}px) scale(${transform.a * from.width / to.width}, ${transform.d * from.height / to.height})`;
    const animation = element.animate([{ transform: start }, { transform: transform.toString() }], {
      duration: BUBBLE_MOTION_MS, easing: 'cubic-bezier(.2,.8,.2,1)',
    });
    animation.id = 'bubble-expansion';
    animation.onfinish = () => settled?.();
    return () => animation.cancel();
  }, [from]);
}
