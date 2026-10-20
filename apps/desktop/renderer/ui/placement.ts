import type { ScreenRect } from '../../../../src/graph/label-placement.ts';

const MARGIN = 12, GAP = 24;
const overlap = (a: ScreenRect, b: ScreenRect) => Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));

/** Screen position for a floating panel that keeps its endpoints and the map chrome visible:
 * try each side of the endpoints, then a coarse grid, and take the least covered spot. */
export function placeClear(size: { width: number; height: number }, endpoints: readonly ScreenRect[], chrome: readonly ScreenRect[], canvas: { width: number; height: number }) {
  const clamp = (x: number, y: number) => ({ x: Math.round(Math.max(MARGIN, Math.min(x, canvas.width - size.width - MARGIN))), y: Math.round(Math.max(MARGIN, Math.min(y, canvas.height - size.height - MARGIN))) });
  const left = Math.min(...endpoints.map(rect => rect.x)), top = Math.min(...endpoints.map(rect => rect.y));
  const right = Math.max(...endpoints.map(rect => rect.x + rect.width)), bottom = Math.max(...endpoints.map(rect => rect.y + rect.height));
  const middle = { x: (left + right - size.width) / 2, y: (top + bottom - size.height) / 2 };
  const candidates = [
    clamp(right + GAP, middle.y), clamp(left - GAP - size.width, middle.y), clamp(middle.x, bottom + GAP), clamp(middle.x, top - GAP - size.height),
    clamp(right + GAP, top), clamp(left - GAP - size.width, top), clamp(right + GAP, bottom - size.height), clamp(left - GAP - size.width, bottom - size.height),
  ];
  for (let y = MARGIN; y + size.height <= canvas.height - MARGIN; y += 48) for (let x = MARGIN; x + size.width <= canvas.width - MARGIN; x += 48) candidates.push({ x, y });
  const blockers = [...endpoints.map(rect => ({ x: rect.x - 8, y: rect.y - 8, width: rect.width + 16, height: rect.height + 16 })), ...chrome];
  let best = candidates[0], cost = Infinity;
  for (const candidate of candidates) {
    const panel = { ...candidate, ...size }, covered = blockers.reduce((sum, rect) => sum + overlap(panel, rect), 0);
    if (covered < cost) { best = candidate; cost = covered; }
    if (!covered) break;
  }
  return best;
}
