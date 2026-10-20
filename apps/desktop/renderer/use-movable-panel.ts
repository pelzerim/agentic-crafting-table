import { useLayoutEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';

/** Move the overlay independently of the world position where its item will be created. */
export function useMovablePanel(initial: { x: number; y: number }, surfaceKey?: unknown) {
  const panel = useRef<HTMLFormElement>(null);
  const drag = useRef<{ pointerId: number; x: number; y: number; left: number; top: number }>(undefined);
  const [position, setPosition] = useState(initial);
  const [dragging, setDragging] = useState(false);
  const clamp = (next: { x: number; y: number }) => {
    const element = panel.current, parent = element?.offsetParent as HTMLElement | null;
    if (!element || !parent) return next;
    return { x: Math.max(12, Math.min(next.x, parent.clientWidth - element.offsetWidth - 12)), y: Math.max(12, Math.min(next.y, parent.clientHeight - element.offsetHeight - 12)) };
  };
  useLayoutEffect(() => {
    if (!panel.current) return;
    const fit = () => setPosition(old => { const next = clamp(old); return next.x === old.x && next.y === old.y ? old : next; });
    const observer = new ResizeObserver(fit);
    observer.observe(panel.current!);
    if (panel.current?.offsetParent) observer.observe(panel.current.offsetParent);
    fit();
    return () => observer.disconnect();
  }, [surfaceKey]);
  const end = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = undefined; setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  return { panel, position, dragging, moveTo: (next: { x: number; y: number }) => setPosition(clamp(next)), handle: {
    onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
      if (event.button !== 0 || (event.target as HTMLElement).closest('button')) return;
      event.preventDefault(); event.stopPropagation();
      drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, left: position.x, top: position.y };
      event.currentTarget.setPointerCapture(event.pointerId); setDragging(true);
    },
    onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
      const start = drag.current;
      if (!start || start.pointerId !== event.pointerId) return;
      event.stopPropagation();
      setPosition(clamp({ x: start.left + event.clientX - start.x, y: start.top + event.clientY - start.y }));
    },
    onPointerUp: end, onPointerCancel: end, onLostPointerCapture: end,
  } };
}
