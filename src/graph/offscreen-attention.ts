import type { Point } from './neighborhood.ts';
import type { ScreenRect } from './label-placement.ts';
import { attentionTiers } from './attention.ts';
import type { AttentionTier } from './attention.ts';

/** MAP-31: which waiting items lie outside the view, and where on the edge of the view to point at them.
 * Pure, so the map can ask on every frame of a pan. */
export interface OffscreenBox { id: string; resourceId?: string; x: number; y: number; width: number; height: number }
export interface MapCamera { x: number; y: number; zoom: number }
/** `boxes` are nearest first; `tier` is the highest among them. */
export interface OffscreenMark<Box> { spot: Point; boxes: Box[]; tier: AttentionTier }

/** How far the centre of the mark keeps from the edge and from chrome: its 9 px radius and a gap. */
const MARK_CLEARANCE = 16, WALK_STEP = 4;
/** Marks closer than this on screen would read as one direction. */
const GROUP_DISTANCE = 56;

/** The items with no part inside the view, nearest the centre first, one card per resource. A resource with a card in view is not off-screen. */
export function offscreenBoxes<Box extends OffscreenBox>(boxes: readonly Box[], camera: MapCamera, screen: { width: number; height: number }): Box[] {
  const left = -camera.x / camera.zoom, top = -camera.y / camera.zoom, right = left + screen.width / camera.zoom, bottom = top + screen.height / camera.zoom;
  const inView = (box: Box) => box.x + box.width / 2 > left && box.x - box.width / 2 < right && box.y + box.height / 2 > top && box.y - box.height / 2 < bottom;
  const shown = new Set(boxes.filter(inView).map(box => box.resourceId ?? box.id)), distance = (box: Box) => Math.hypot(box.x - (left + right) / 2, box.y - (top + bottom) / 2);
  const nearest = new Map<string, Box>();
  for (const box of boxes.filter(box => !shown.has(box.resourceId ?? box.id)).sort((a, b) => distance(a) - distance(b))) if (!nearest.has(box.resourceId ?? box.id)) nearest.set(box.resourceId ?? box.id, box);
  return [...nearest.values()];
}

/** One mark per direction: each box, nearest first, joins the first mark within GROUP_DISTANCE of its own spot or starts its own,
 * so marks stay apart. `boxes` keep their order, so the first is the nearest and the mark takes its spot. */
export function offscreenMarks<Box extends OffscreenBox & { tier: AttentionTier }>(boxes: readonly Box[], camera: MapCamera, area: ScreenRect, chrome: readonly ScreenRect[]): OffscreenMark<Box>[] {
  const marks: OffscreenMark<Box>[] = [];
  for (const box of boxes) {
    const spot = edgeSpot({ x: box.x * camera.zoom + camera.x, y: box.y * camera.zoom + camera.y }, area, chrome);
    const near = marks.find(mark => Math.hypot(mark.spot.x - spot.x, mark.spot.y - spot.y) < GROUP_DISTANCE);
    if (near) near.boxes.push(box); else marks.push({ spot, boxes: [box], tier: box.tier });
  }
  for (const mark of marks) mark.tier = attentionTiers.find(tier => mark.boxes.some(box => box.tier === tier))!;
  return marks;
}

/** Where the line from the centre of `area` to a `target` outside it crosses the edge, or the nearest
 * place along the edge that `chrome` leaves clear. With no clear place, the plain crossing. */
export function edgeSpot(target: Point, area: ScreenRect, chrome: readonly ScreenRect[]): Point {
  const left = area.x + MARK_CLEARANCE, right = area.x + area.width - MARK_CLEARANCE, top = area.y + MARK_CLEARANCE, bottom = area.y + area.height - MARK_CLEARANCE;
  const width = right - left, height = bottom - top, perimeter = 2 * (width + height);
  const dx = target.x - (left + right) / 2, dy = target.y - (top + bottom) / 2;
  const toSide = dx ? ((dx > 0 ? right : left) - (left + right) / 2) / dx : Infinity, toEnd = dy ? ((dy > 0 ? bottom : top) - (top + bottom) / 2) / dy : Infinity;
  const crossing = toSide <= toEnd ? { x: dx > 0 ? right : left, y: (top + bottom) / 2 + dy * toSide } : { x: (left + right) / 2 + dx * toEnd, y: dy > 0 ? bottom : top };
  const onEdge = (along: number): Point => {
    let rest = (along % perimeter + perimeter) % perimeter;
    if (rest <= width) return { x: left + rest, y: top };
    rest -= width; if (rest <= height) return { x: right, y: top + rest };
    rest -= height; if (rest <= width) return { x: right - rest, y: bottom };
    return { x: left, y: bottom - (rest - width) };
  };
  const start = crossing.y === top ? crossing.x - left : crossing.x === right ? width + crossing.y - top : crossing.y === bottom ? width + height + right - crossing.x : 2 * width + height + bottom - crossing.y;
  const clear = ({ x, y }: Point) => !chrome.some(rect => x > rect.x - MARK_CLEARANCE && x < rect.x + rect.width + MARK_CLEARANCE && y > rect.y - MARK_CLEARANCE && y < rect.y + rect.height + MARK_CLEARANCE);
  const rounded = ({ x, y }: Point) => ({ x: Math.round(x), y: Math.round(y) });
  for (let walked = 0; walked <= perimeter / 2; walked += WALK_STEP) for (const along of [start - walked, start + walked]) if (clear(onEdge(along))) return rounded(onEdge(along));
  return rounded(crossing);
}
