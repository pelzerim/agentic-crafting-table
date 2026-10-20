import type { SpatialBox } from './spatial.ts';

export interface Point { x: number; y: number }

/** Minimal convex hull, independent of member order. Collinear interior points
 * disappear so dense projects only pay the rounding cost at their outer corners. */
function convexHull(input: readonly Point[]): Point[] {
  const sorted = [...input].sort((a, b) => a.x - b.x || a.y - b.y)
    .filter((p, i, all) => !i || p.x !== all[i - 1].x || p.y !== all[i - 1].y);
  const turn = (a: Point, b: Point, c: Point) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const half = (points: readonly Point[]) => {
    const result: Point[] = [];
    for (const p of points) {
      while (result.length >= 2 && turn(result.at(-2)!, result.at(-1)!, p) <= 0) result.pop();
      result.push(p);
    }
    return result.slice(0, -1);
  };
  return [...half(sorted), ...half([...sorted].reverse())];
}

const DIRECTIONS = 256;
/** Half-width, in radians, of the direction blend that bows long runs. */
const SMOOTHING = .6;

/** The padded hull with its long straight runs bowed into curves, as the
 * intersection of DIRECTIONS supporting half-planes. Each direction compares the
 * hull's support with a raised-cosine average over nearby directions (a blend of
 * slightly rotated copies of the hull). A long edge's support peaks sharply at
 * its normal, so the average exceeds it there and that run bows outward into an
 * arc; the bulge only counts beyond a tolerance that grows with the padding, so
 * single cards and compact groups keep their shape. Every half-plane lies at or
 * outside the hull plus padding, so the full clearance is kept, and each offset
 * depends continuously on the members, so dragging never makes the shape jump. */
function smoothedEnvelope(hull: readonly Point[], padding: number, stepSize: number): Point[] {
  const step = 2 * Math.PI / DIRECTIONS, reach = Math.round(SMOOTHING / step);
  const tolerance = Math.max(padding, stepSize) / 8;
  const directions = Array.from({ length: DIRECTIONS }, (_, k) => ({ x: Math.cos(k * step), y: Math.sin(k * step) }));
  const support = directions.map(u => Math.max(...hull.map(p => p.x * u.x + p.y * u.y)));
  const weights = Array.from({ length: 2 * reach + 1 }, (_, i) => 1 + Math.cos(Math.PI * (i - reach) / (reach + 1)));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const extent = 2 * Math.max(...hull.map(p => Math.hypot(p.x, p.y))) + padding + 1;
  let polygon: Point[] = [{ x: -extent, y: -extent }, { x: extent, y: -extent }, { x: extent, y: extent }, { x: -extent, y: extent }];
  directions.forEach((u, k) => {
    const blend = weights.reduce((sum, weight, i) => sum + weight * support[(k + i - reach + DIRECTIONS) % DIRECTIONS], 0) / total;
    const offset = support[k] + padding + Math.max(0, blend - support[k] - tolerance);
    const clipped: Point[] = [];
    polygon.forEach((a, i) => {
      const b = polygon[(i + 1) % polygon.length], da = a.x * u.x + a.y * u.y - offset, db = b.x * u.x + b.y * u.y - offset;
      if (da <= 0) clipped.push(a);
      if ((da < 0 && db > 0) || (da > 0 && db < 0)) clipped.push({ x: a.x + (b.x - a.x) * da / (da - db), y: a.y + (b.y - a.y) * da / (da - db) });
    });
    polygon = clipped;
  });
  return polygon;
}

/** One rounded enclosure following the hull of full member footprints. Padding
 * expands it in every direction; outward pixel steps retain all that clearance.
 * Steps lie on the world grid, so moving a group by whole cells translates the exact contour. */
export function neighborhoodContours(input: readonly SpatialBox[], padding = 20, stepSize = 48): Point[][] {
  if (!Number.isFinite(padding) || padding < 0 || !Number.isFinite(stepSize) || stepSize <= 0) throw new Error('Neighborhood padding must be non-negative and step size positive');
  if (!input.length) return [];
  if (input.some(b => ![b.x, b.y, b.width, b.height].every(Number.isFinite) || b.width <= 0 || b.height <= 0)) throw new Error('Neighborhood cards must have finite positive dimensions');
  const corners = input.flatMap(b => [-1, 1].flatMap(dx => [-1, 1].map(dy => ({ x: b.x + dx * b.width / 2, y: b.y + dy * b.height / 2 }))));
  const left = Math.min(...corners.map(p => p.x)), right = Math.max(...corners.map(p => p.x));
  const top = Math.min(...corners.map(p => p.y)), bottom = Math.max(...corners.map(p => p.y));
  const center = { x: left / 2 + right / 2, y: top / 2 + bottom / 2 };
  const hull = convexHull(corners.map(p => ({ x: p.x - center.x, y: p.y - center.y })));
  const rounded = smoothedEnvelope(hull, padding, stepSize);
  const width = right - left + 2 * padding, height = bottom - top + 2 * padding;
  // At most 128 rows / 512 vertices, even for very distant members. Small groups
  // still get enough square steps to reveal their rounded ends. The cell is a
  // multiple or a power-of-two fraction of the step, on the world grid, so a
  // fill at the step size paints exactly the cells this contour encloses.
  const wanted = Math.max(width / 127, height / 127, Math.min(stepSize, Math.min(width, height) / 12, padding ? padding / 4 : Infinity));
  const cell = wanted > stepSize ? stepSize * Math.ceil(wanted / stepSize - 1e-10) : stepSize / 2 ** Math.floor(Math.log2(stepSize / wanted) + 1e-10);
  const origin = { x: Math.floor((left - padding) / cell + 1e-10) * cell, y: Math.floor((top - padding) / cell + 1e-10) * cell };
  const gridLeft = origin.x - center.x, gridTop = origin.y - center.y, rows = Math.ceil((bottom + padding - origin.y) / cell - 1e-10);
  const bands: { left: number; right: number; row: number }[] = [];
  for (let row = 0; row < rows; row++) {
    const y0 = gridTop + row * cell, y1 = y0 + cell;
    let min = Infinity, max = -Infinity;
    // Clip each convex edge to this entire strip, not just its center. Taking
    // both extrema prevents a stair step from cutting across a card or its pad.
    for (let i = 0; i < rounded.length; i++) {
      const a = rounded[i], b = rounded[(i + 1) % rounded.length], dy = b.y - a.y;
      if (Math.max(a.y, b.y) < y0 || Math.min(a.y, b.y) > y1) continue;
      const t0 = dy ? Math.max(0, Math.min((y0 - a.y) / dy, (y1 - a.y) / dy)) : 0;
      const t1 = dy ? Math.min(1, Math.max((y0 - a.y) / dy, (y1 - a.y) / dy)) : 1;
      const x0 = a.x + (b.x - a.x) * t0, x1 = a.x + (b.x - a.x) * t1;
      min = Math.min(min, x0, x1); max = Math.max(max, x0, x1);
    }
    if (min <= max) bands.push({ row, left: Math.floor((min - gridLeft) / cell + 1e-10), right: Math.ceil((max - gridLeft) / cell - 1e-10) });
  }
  const outline = [
    ...bands.flatMap(b => [{ x: b.right, y: b.row }, { x: b.right, y: b.row + 1 }]),
    ...bands.reverse().flatMap(b => [{ x: b.left, y: b.row + 1 }, { x: b.left, y: b.row }]),
  ].filter((p, i, all) => !i || p.x !== all[i - 1].x || p.y !== all[i - 1].y);
  return [outline.filter((p, i) => {
    const a = outline[(i + outline.length - 1) % outline.length], b = outline[(i + 1) % outline.length];
    return (a.x !== p.x || p.x !== b.x) && (a.y !== p.y || p.y !== b.y);
  }).map(p => ({ x: origin.x + p.x * cell, y: origin.y + p.y * cell }))];
}

/** Outer contour for bounds/title placement; use all contours for rendering and hit tests. */
export function neighborhoodOutline(input: readonly SpatialBox[], padding = 20): Point[] {
  return neighborhoodContours(input, padding)[0] ?? [];
}

function polygonDistance(point: Point, polygon: readonly Point[]) {
  let inside = false, distance = Infinity;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[j], b = polygon[i], dx = b.x - a.x, dy = b.y - a.y;
    if ((a.y > point.y) !== (b.y > point.y) && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
    const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
    distance = Math.min(distance, Math.hypot(point.x - a.x - t * dx, point.y - a.y - t * dy));
  }
  return { inside, distance };
}

/** Zero inside or on the outline; otherwise distance to the actual outline, including inward corners. */
export function outlineDistance(point: Point, polygon: readonly Point[]): number {
  const result = polygonDistance(point, polygon);
  return result.inside || result.distance < 1e-9 ? 0 : result.distance;
}

/** Same containment rule as the SVG, shared by creation and attachment hit tests. */
export function neighborhoodDistance(point: Point, contours: readonly (readonly Point[])[]): number {
  let inside = false, distance = Infinity;
  for (const polygon of contours) {
    const result = polygonDistance(point, polygon);
    if (result.inside) inside = !inside;
    distance = Math.min(distance, result.distance);
  }
  return inside || distance < 1e-9 ? 0 : distance;
}
