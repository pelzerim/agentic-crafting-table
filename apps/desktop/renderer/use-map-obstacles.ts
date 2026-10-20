import { useLayoutEffect, useState } from 'react';
import type { RefObject } from 'react';
import type { ScreenRect } from '../../../src/graph/label-placement.ts';

export function useMapObstacles(container: RefObject<HTMLDivElement | null>, width: number, height: number, focused: boolean, selector = '.map-status,.map-locator,.zoom-markers,.tool-rail') {
  const [rectangles, setRectangles] = useState<ScreenRect[]>([]);
  useLayoutEffect(() => {
    const area = container.current!, root = area.parentElement!;
    const elements = [...root.querySelectorAll<HTMLElement>(selector)];
    const measure = () => {
      const origin = area.getBoundingClientRect();
      const next = elements.map(element => element.getBoundingClientRect()).filter(rect => rect.width && rect.height)
        .map(rect => ({ x: rect.x - origin.x, y: rect.y - origin.y, width: rect.width, height: rect.height }));
      setRectangles(old => JSON.stringify(old) === JSON.stringify(next) ? old : next);
    };
    const resize = new ResizeObserver(measure), changes = new MutationObserver(measure);
    for (const element of elements) { resize.observe(element); changes.observe(element, { attributes: true, attributeFilter: ['style', 'class', 'hidden'] }); }
    measure(); return () => { resize.disconnect(); changes.disconnect(); };
  }, [container, width, height, focused, selector]);
  return rectangles;
}
