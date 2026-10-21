/** Screen rectangles in workspace pixels: an open item view, the tool rail, the map trail. */
export interface ScreenRect { x: number; y: number; width: number; height: number }
const touches = (a: ScreenRect, b: ScreenRect) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
/** True while the view reaches the rail or the trail; both then slide off their edge together and return as soon as it no longer does. */
export function coversChrome(view: ScreenRect, chrome: { rail: ScreenRect; trail: ScreenRect }) {
  return touches(view, chrome.rail) || touches(view, chrome.trail);
}
