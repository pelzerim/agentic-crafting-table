export type MapWheelEvent = Pick<WheelEvent, 'deltaX' | 'deltaY' | 'deltaMode' | 'ctrlKey' | 'timeStamp'> & { metaKey?: boolean; wheelDeltaY?: number };

/** How long after a two-finger event the next one still belongs to the same gesture, momentum included. */
const GESTURE_GAP_MS = 200;

/**
 * Tells a two-finger trackpad scroll (pan) from a mouse wheel or a pinch (zoom). Chromium reports a pinch as a
 * wheel event with ctrlKey, and a trackpad scroll with wheelDeltaY equal to -3 × deltaY or with sideways movement;
 * a mouse notch carries a multiple of 120. Once a gesture pans it keeps panning until it pauses, so one large
 * trackpad event cannot zoom in the middle of a scroll. With Command held, any wheel or two-finger movement zooms,
 * as in design tools.
 */
export class MapWheelGestures {
  private lastPan = Number.NEGATIVE_INFINITY;

  classify(event: MapWheelEvent): 'pan' | 'zoom' {
    if (event.ctrlKey || event.metaKey) return 'zoom';
    const continuing = event.timeStamp - this.lastPan <= GESTURE_GAP_MS;
    const pan = continuing || (event.deltaMode === 0 && (event.deltaX !== 0 || (Boolean(event.wheelDeltaY) && event.wheelDeltaY === -3 * event.deltaY)));
    if (pan) this.lastPan = event.timeStamp;
    return pan ? 'pan' : 'zoom';
  }
}

export type MapViewport = { x: number; y: number; zoom: number };

/**
 * The viewport after one wheel step zooms it around a screen point, at the rate d3-zoom (React Flow) uses for a wheel,
 * so a Command scroll and a plain mouse wheel zoom at the same speed. The point under the pointer stays in place.
 */
export function zoomAroundPointer(viewport: MapViewport, pointer: { x: number; y: number }, event: Pick<WheelEvent, 'deltaY' | 'deltaMode'>, limits: { min: number; max: number }): MapViewport {
  const rate = event.deltaMode === 1 ? .05 : event.deltaMode ? 1 : .002;
  const zoom = Math.min(limits.max, Math.max(limits.min, viewport.zoom * 2 ** (-event.deltaY * rate)));
  const scale = zoom / viewport.zoom;
  return { x: pointer.x - (pointer.x - viewport.x) * scale, y: pointer.y - (pointer.y - viewport.y) * scale, zoom };
}
