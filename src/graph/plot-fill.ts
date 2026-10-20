import type { Point } from './neighborhood.ts';

/** Cell centres inside an orthogonal or convex polygon along one row, as sorted intervals. */
function spans(polygon: readonly Point[], y: number) {
  const xs: number[] = [];
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i], b = polygon[(i + 1) % polygon.length];
    if ((a.y > y) !== (b.y > y)) xs.push(a.x + (b.x - a.x) * (y - a.y) / (b.y - a.y));
  }
  xs.sort((a, b) => a - b);
  const result: [number, number][] = [];
  for (let i = 0; i + 1 < xs.length; i += 2) result.push([xs[i], xs[i + 1]]);
  return result;
}
const inside = (intervals: readonly [number, number][], x: number) => intervals.some(([from, to]) => x >= from && x <= to);

/** A plot's patch on the neighbourhood's world grid, clipped to its project's field:
 * two row-merged paths, the interior (0) and a one-cell edge ring (1). No camera input. */
export function plotFill(points: readonly Point[], clip: readonly Point[], cellSize = 24) {
  const paths = ['', ''];
  if (!points.length || !clip.length) return { paths };
  const x0 = Math.floor(Math.min(...points.map(p => p.x)) / cellSize), x1 = Math.ceil(Math.max(...points.map(p => p.x)) / cellSize);
  const y0 = Math.floor(Math.min(...points.map(p => p.y)) / cellSize), y1 = Math.ceil(Math.max(...points.map(p => p.y)) / cellSize);
  const rows: Set<number>[] = [];
  for (let row = y0; row < y1; row++) {
    const y = (row + .5) * cellSize, own = spans(points, y), field = spans(clip, y), filled = new Set<number>();
    for (let column = x0; column < x1; column++) {
      const x = (column + .5) * cellSize;
      if (inside(own, x) && inside(field, x)) filled.add(column);
    }
    rows.push(filled);
  }
  rows.forEach((filled, index) => {
    const row = y0 + index, above = rows[index - 1], below = rows[index + 1];
    let run = -1, start = 0;
    const flush = (end: number) => { if (run >= 0) paths[run] += `M${start * cellSize},${row * cellSize}h${(end - start) * cellSize}v${cellSize}h${-(end - start) * cellSize}Z`; };
    for (let column = x0; column <= x1; column++) {
      const shade = !filled.has(column) ? -1 : filled.has(column - 1) && filled.has(column + 1) && above?.has(column) && below?.has(column) ? 0 : 1;
      if (shade !== run) { flush(column); run = shade; start = column; }
    }
  });
  return { paths };
}
