import type { Point } from './neighborhood.ts';

export interface NeighborhoodGeometry { pixelSize: number; fade: number; scatter: number }
export const NEIGHBORHOOD_STYLES = ['biome', 'plain'] as const;
export const NEIGHBORHOOD_TEXTURES = ['quiet', 'medium', 'full'] as const;
export type NeighborhoodStyle = typeof NEIGHBORHOOD_STYLES[number];
export type NeighborhoodTexture = typeof NEIGHBORHOOD_TEXTURES[number];
/** `style` chooses biome ground or one plain colour; `texture` is how strongly a biome's ground shows; `brightness` is the opacity of biome ground over the map, in percent. */
export interface NeighborhoodAppearance extends NeighborhoodGeometry { style: NeighborhoodStyle; texture: NeighborhoodTexture; brightness: number }
export const DEFAULT_NEIGHBORHOOD_APPEARANCE: Readonly<NeighborhoodAppearance> = { pixelSize: 24, fade: 96, scatter: 0, style: 'biome', texture: 'quiet', brightness: 24 };
/** One shade per world-grid cell, row by row from (`x0`, `y0`): 0 (solid) to 3 (faintest), -1 outside. */
export interface NeighborhoodCells { cellSize: number; x0: number; y0: number; columns: number; rows: number; shades: Int8Array }
// Apply overall opacity once to the SVG: overlapping projects cannot compound
// the center brightness and wash out the board beneath a dense group.
export const NEIGHBORHOOD_SHADES = [1, .72, .42, .17] as const;
export const MAX_NEIGHBORHOOD_CELLS = 16_384;

/** Stable coordinate noise. Moving a boundary reveals the same world-grid cells,
 * rather than regenerating a random edge on each drag or camera frame. */
function noise(x: number, y: number) {
  let value = Math.imul(x, 374761393) ^ Math.imul(y, 668265263);
  value = Math.imul(value ^ value >>> 13, 1274126177);
  return ((value ^ value >>> 16) >>> 0) / 4294967296;
}

/** Sample the logical, stepped enclosure onto the world grid. Appearance never changes
 * membership. Cost is bounded even for far-apart items; very large enclosures use an
 * integer multiple of the requested world-grid size. No camera input. */
export function neighborhoodCells(points: readonly Point[], appearance: NeighborhoodGeometry = DEFAULT_NEIGHBORHOOD_APPEARANCE): NeighborhoodCells {
  const { pixelSize, fade, scatter } = appearance;
  if (![pixelSize, fade, scatter].every(Number.isFinite) || pixelSize <= 0 || fade < 0 || scatter < 0 || scatter > 100) throw new Error('Invalid neighborhood appearance');
  if (!points.length) return { cellSize: pixelSize, x0: 0, y0: 0, columns: 0, rows: 0, shades: new Int8Array(0) };
  const left = Math.min(...points.map(p => p.x)), right = Math.max(...points.map(p => p.x));
  const top = Math.min(...points.map(p => p.y)), bottom = Math.max(...points.map(p => p.y));
  let cellSize = pixelSize * Math.max(1, Math.ceil(Math.sqrt((right - left) * (bottom - top) / MAX_NEIGHBORHOOD_CELLS) / pixelSize), Math.ceil(Math.max(right - left, bottom - top) / (512 * pixelSize)));
  const bounds = () => ({ x0: Math.floor(left / cellSize), x1: Math.ceil(right / cellSize), y0: Math.floor(top / cellSize), y1: Math.ceil(bottom / cellSize) });
  let grid = bounds();
  while ((grid.x1 - grid.x0) * (grid.y1 - grid.y0) > MAX_NEIGHBORHOOD_CELLS || grid.x1 - grid.x0 > 512 || grid.y1 - grid.y0 > 512) { cellSize += pixelSize; grid = bounds(); }
  const segments = points.map((a, i) => {
    const b = points[(i + 1) % points.length];
    return { a, b, left: Math.min(a.x, b.x), right: Math.max(a.x, b.x), top: Math.min(a.y, b.y), bottom: Math.max(a.y, b.y) };
  });
  const columns = grid.x1 - grid.x0, shades = new Int8Array(columns * (grid.y1 - grid.y0)).fill(-1);
  for (let row = grid.y0; row < grid.y1; row++) {
    const y = (Math.max(top, row * cellSize) + Math.min(bottom, (row + 1) * cellSize)) / 2;
    const intersections = segments.filter(({ a, b }) => (a.y > y) !== (b.y > y))
      .map(({ a, b }) => a.x + (b.x - a.x) * (y - a.y) / (b.y - a.y)).sort((a, b) => a - b);
    // The logical neighborhood is an orthogonal polygon. Only nearby segments
    // can affect shading; the solid interior avoids a per-cell full edge walk.
    const near = fade ? segments.filter(s => s.top <= y + fade && s.bottom >= y - fade) : [];
    for (let column = grid.x0; column < grid.x1; column++) {
      const x = (Math.max(left, column * cellSize) + Math.min(right, (column + 1) * cellSize)) / 2;
      let inside = false;
      for (let i = 0; i + 1 < intersections.length; i += 2) if (x >= intersections[i] && x <= intersections[i + 1]) { inside = true; break; }
      if (!inside) continue;
      let squared = fade * fade;
      for (const s of near) {
        const dx = Math.max(s.left - x, 0, x - s.right), dy = Math.max(s.top - y, 0, y - s.bottom);
        squared = Math.min(squared, dx * dx + dy * dy);
      }
      const t = fade ? Math.min(1, Math.sqrt(squared) / fade) : 1;
      const shade = Math.min(3, Math.floor((1 - t * t * (3 - 2 * t)) * 4));
      if (!(shade > 0 && noise(column, row) < scatter / 100 * (1 - t))) shades[(row - grid.y0) * columns + column - grid.x0] = shade;
    }
  }
  return { cellSize, x0: grid.x0, y0: grid.y0, columns, rows: grid.y1 - grid.y0, shades };
}

/** Rasterize the sampled cells into four row-merged SVG paths, one per shade.
 * No camera input: pan/zoom can reuse the exact same paths. */
export function neighborhoodFill(points: readonly Point[], appearance: NeighborhoodGeometry = DEFAULT_NEIGHBORHOOD_APPEARANCE) {
  return neighborhoodPaths(neighborhoodCells(points, appearance));
}
export function neighborhoodPaths(cells: NeighborhoodCells) {
  const { cellSize, x0, y0, columns, rows, shades } = cells;
  // Merge equal runs vertically as well as horizontally. A wide solid interior
  // is one rectangle, instead of forcing Chromium to paint every pixel row.
  type Run = { start: number; end: number; row: number; rows: number };
  const runs: Run[][] = [[], [], [], []];
  const lastRuns = Array.from({ length: 4 }, () => new Map<string, Run>());
  for (let row = y0; row < y0 + rows; row++) {
    let run = -1, start = x0;
    const flush = (column: number) => {
      if (run < 0) return;
      const key = `${start}:${column}`, last = lastRuns[run].get(key);
      if (last && last.row + last.rows === row) last.rows++;
      else { const next = { start, end: column, row, rows: 1 }; runs[run].push(next); lastRuns[run].set(key, next); }
    };
    for (let column = x0; column < x0 + columns; column++) {
      const shade = shades[(row - y0) * columns + column - x0];
      if (shade !== run) { flush(column); run = shade; start = column; }
    }
    flush(x0 + columns);
  }
  return { paths: runs.map(rects => rects.map(r => `M${r.start * cellSize},${r.row * cellSize}h${(r.end - r.start) * cellSize}v${r.rows * cellSize}h${-(r.end - r.start) * cellSize}Z`).join('')), cellSize, cells: columns * rows };
}
