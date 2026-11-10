export type MapWheelEvent = Pick<WheelEvent, 'deltaX' | 'deltaY' | 'deltaMode' | 'ctrlKey' | 'timeStamp'> & { wheelDeltaY?: number };

/** How long after a two-finger event the next one still belongs to the same gesture, momentum included. */
const GESTURE_GAP_MS = 200;

/**
 * Tells a two-finger trackpad scroll (pan) from a mouse wheel or a pinch (zoom). Chromium reports a pinch as a
 * wheel event with ctrlKey, and a trackpad scroll with wheelDeltaY equal to -3 × deltaY or with sideways movement;
 * a mouse notch carries a multiple of 120. Once a gesture pans it keeps panning until it pauses, so one large
 * trackpad event cannot zoom in the middle of a scroll.
 */
export class MapWheelGestures {
  private lastPan = Number.NEGATIVE_INFINITY;

  classify(event: MapWheelEvent): 'pan' | 'zoom' {
    if (event.ctrlKey) return 'zoom';
    const continuing = event.timeStamp - this.lastPan <= GESTURE_GAP_MS;
    const pan = continuing || (event.deltaMode === 0 && (event.deltaX !== 0 || (Boolean(event.wheelDeltaY) && event.wheelDeltaY === -3 * event.deltaY)));
    if (pan) this.lastPan = event.timeStamp;
    return pan ? 'pan' : 'zoom';
  }
}
