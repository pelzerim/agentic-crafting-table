import type { ScreenRect } from './label-placement.ts';
import type { Point } from './neighborhood.ts';

/** Top and bottom edge × left, centre and right, in reading order. */
export const PLOT_SIGN_SPOTS = ['top-left', 'top-centre', 'top-right', 'bottom-left', 'bottom-centre', 'bottom-right'] as const;
export const PLOT_NAME_LENGTH = 24;
const SIGN = { height: 20, chrome: 30, glyph: 6.6, inset: 8, pin: 14 } as const;

export interface PlotSignInput { id: string; bounds: { left: number; top: number; right: number; bottom: number }; width: number; height: number }
export interface PlotSignSpot { x: number; y: number; spot: number }

/** World size of a sign whose text is a constant 11 px on screen; a pinned plot's sign also holds its pin. */
export function plotSignSize(name: string, zoom: number, pinned = false) {
  return { width: (SIGN.chrome + (pinned ? SIGN.pin : 0) + SIGN.glyph * Math.min(name.length, PLOT_NAME_LENGTH)) / zoom, height: SIGN.height / zoom };
}

/** Where `spot` puts a sign on these bounds; -1 is the inner top-left fallback. */
export function plotSignPosition(sign: Omit<PlotSignInput, 'id'>, spot: number): PlotSignSpot {
  const { left, top, right, bottom } = sign.bounds;
  if (spot < 0) return { x: left + SIGN.inset, y: top + SIGN.inset, spot };
  return { x: spot % 3 === 0 ? left : spot % 3 === 1 ? (left + right - sign.width) / 2 : right - sign.width, y: spot < 3 ? top - sign.height : bottom, spot };
}

const overlap = (a: ScreenRect, b: ScreenRect) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
/** Liang–Barsky: does the segment pass through the rectangle? */
function crosses(rect: ScreenRect, from: Point, to: Point) {
  let t0 = 0, t1 = 1;
  const dx = to.x - from.x, dy = to.y - from.y;
  for (const [p, q] of [[-dx, from.x - rect.x], [dx, rect.x + rect.width - from.x], [-dy, from.y - rect.y], [dy, rect.y + rect.height - from.y]]) {
    if (p === 0) { if (q < 0) return false; continue; }
    const t = q / p;
    if (p < 0) t0 = Math.max(t0, t); else t1 = Math.min(t1, t);
    if (t0 > t1) return false;
  }
  return true;
}

/** One sign per plot, anchored to the plot's edge. A spot is out if it covers a card,
 * the project title or an earlier sign; of the rest, the one crossing the fewest links
 * wins, then reading order. A still-valid `previous` spot is kept. With all six out,
 * the sign sits inside the plot's top-left corner, behind the cards. */
export function placePlotSigns(signs: readonly PlotSignInput[], obstacles: readonly ScreenRect[], links: readonly { from: Point; to: Point }[], previous: ReadonlyMap<string, number>) {
  const placed = new Map<string, PlotSignSpot>(), taken: ScreenRect[] = [];
  for (const sign of signs) {
    const spots = PLOT_SIGN_SPOTS.map((_, spot) => plotSignPosition(sign, spot));
    const free = spots.filter(spot => {
      const rect = { x: spot.x, y: spot.y, width: sign.width, height: sign.height };
      return !obstacles.some(other => overlap(rect, other)) && !taken.some(other => overlap(rect, other));
    });
    const kept = free.find(spot => spot.spot === previous.get(sign.id));
    const crossings = (spot: PlotSignSpot) => links.filter(link => crosses({ x: spot.x, y: spot.y, width: sign.width, height: sign.height }, link.from, link.to)).length;
    const chosen = kept ?? free.map(spot => ({ spot, cost: crossings(spot) })).sort((a, b) => a.cost - b.cost || a.spot.spot - b.spot.spot)[0]?.spot
      ?? plotSignPosition(sign, -1);
    placed.set(sign.id, chosen);
    taken.push({ x: chosen.x, y: chosen.y, width: sign.width, height: sign.height });
  }
  return placed;
}
