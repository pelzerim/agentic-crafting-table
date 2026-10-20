import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import { clampItemDimensions } from '../../../packages/core/item-map-sizes.ts';
import type { itemResizeLimits } from '../../../packages/core/item-map-sizes.ts';

type Point = { x: number; y: number };
type Dimensions = { width: number; height: number };
export type ResizeIntent = { id: string; dimensions: Dimensions; position: Point };
type Origin = ResizeIntent & { limits: ReturnType<typeof itemResizeLimits>; zoom: number; detail: number;
  /** The footprint the item takes at the given dimensions; a note's height follows its text instead. */
  fit(dimensions: Dimensions): Dimensions };

/** Transient pointer geometry only. Domain resizeItem owns placement/validation. */
export function useItemResize(save?: (id: string, dimensions: Dimensions, position: Point) => Promise<void>) {
  const [preview, setPreview] = useState<ResizeIntent>();
  const cancel = useRef<(() => void) | undefined>(undefined), pending = useRef(false), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; cancel.current?.(); }; }, []);
  const finish = async (intent: ResizeIntent) => {
    pending.current = true;
    try { await save?.(intent.id, intent.dimensions, intent.position); }
    catch { /* The workspace command boundary presents the error; discard preview. */ }
    finally { pending.current = false; if (mounted.current) setPreview(undefined); }
  };
  const intentFor = (origin: Origin, width: number, height: number): ResizeIntent => {
    const dimensions = clampItemDimensions({ width, height }, origin.limits), shown = origin.fit(dimensions);
    return { id: origin.id, dimensions, position: {
      x: origin.position.x + (shown.width - origin.dimensions.width) * origin.detail / 2,
      y: origin.position.y + (shown.height - origin.dimensions.height) * origin.detail / 2,
    } };
  };
  return { preview,
    start(event: ReactPointerEvent, origin: Origin) {
      if (!save || pending.current || event.button !== 0) return;
      event.preventDefault(); event.stopPropagation(); cancel.current?.();
      const handle = event.currentTarget as HTMLElement, pointerId = event.pointerId, x = event.clientX, y = event.clientY;
      let next = origin as ResizeIntent, moved = false;
      handle.focus(); handle.setPointerCapture(pointerId); setPreview(next);
      const cleanup = () => {
        window.removeEventListener('pointermove', move, true); window.removeEventListener('pointerup', up, true);
        window.removeEventListener('pointercancel', abort, true); window.removeEventListener('keydown', key, true);
        window.removeEventListener('blur', abort); window.removeEventListener('wheel', wheel, true);
        handle.removeEventListener('lostpointercapture', abort);
        cancel.current = undefined;
        if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
      };
      const abort = () => { cleanup(); if (mounted.current) setPreview(undefined); };
      const wheel = (event: WheelEvent) => { event.preventDefault(); event.stopImmediatePropagation(); };
      const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); abort(); } };
      const move = (event: PointerEvent) => {
        if (event.pointerId !== pointerId) return;
        event.preventDefault(); event.stopPropagation();
        if (!moved && Math.hypot(event.clientX - x, event.clientY - y) < 3) return;
        moved = true;
        next = intentFor(origin, origin.dimensions.width + (event.clientX - x) / origin.zoom / origin.detail,
          origin.dimensions.height + (event.clientY - y) / origin.zoom / origin.detail);
        setPreview(next);
      };
      const up = (event: PointerEvent) => {
        if (event.pointerId !== pointerId) return;
        move(event); cleanup();
        if (moved && (next.dimensions.width !== origin.dimensions.width || next.dimensions.height !== origin.dimensions.height)) void finish(next);
        else setPreview(undefined);
      };
      cancel.current = abort;
      window.addEventListener('pointermove', move, true); window.addEventListener('pointerup', up, true);
      window.addEventListener('pointercancel', abort, true); window.addEventListener('keydown', key, true);
      window.addEventListener('blur', abort); window.addEventListener('wheel', wheel, { capture: true, passive: false });
      handle.addEventListener('lostpointercapture', abort);
    },
    key(event: ReactKeyboardEvent, origin: Origin) {
      if (!save || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation();
      if (pending.current || cancel.current) return;
      const step = event.shiftKey ? 24 : 8;
      const next = intentFor(origin, origin.dimensions.width + (event.key === 'ArrowRight' ? step : event.key === 'ArrowLeft' ? -step : 0),
        origin.dimensions.height + (event.key === 'ArrowDown' ? step : event.key === 'ArrowUp' ? -step : 0));
      if (next.dimensions.width === origin.dimensions.width && next.dimensions.height === origin.dimensions.height) return;
      setPreview(next); void finish(next);
    },
  };
}
