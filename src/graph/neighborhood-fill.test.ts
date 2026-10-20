import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_NEIGHBORHOOD_APPEARANCE as defaults, MAX_NEIGHBORHOOD_CELLS, neighborhoodCells, neighborhoodFill, neighborhoodPaths } from './neighborhood-fill.ts';
import { neighborhoodContours } from './neighborhood.ts';
import { neighborhoodAppearanceSchema, settingsSchema } from '../../packages/core/settings.ts';

const outline = neighborhoodContours([{ id: 'item', x: 260, y: 260, width: 200, height: 100 }], 240, 24)[0];
function cells(fill: ReturnType<typeof neighborhoodFill>) {
  const result = new Map<string, number>();
  fill.paths.forEach((path, shade) => {
    for (const match of path.matchAll(/M(-?[\d.]+),(-?[\d.]+)h([\d.]+)v([\d.]+)h-[\d.]+Z/g)) {
      const [, x, y, width, height] = match.map(Number);
      for (let dy = 0; dy < height; dy += fill.cellSize) for (let dx = 0; dx < width; dx += fill.cellSize) result.set(`${x + dx},${y + dy}`, shade);
    }
  });
  return result;
}

test('broad-step defaults have four disjoint shades on a stable world grid, including negative coordinates', () => {
  assert.deepEqual(settingsSchema.parse({}).neighborhoodAppearance, { pixelSize: 24, fade: 96, scatter: 0, style: 'biome', texture: 'quiet', brightness: 24 });
  const fill = neighborhoodFill(outline), painted = cells(fill);
  assert.equal(fill.cellSize, 24); assert.equal(fill.paths.filter(Boolean).length, 4);
  assert.equal(painted.get('240,240'), 0);
  for (const key of painted.keys()) assert.ok(key.split(',').every(n => Number(n) % 24 === 0));
  const reverse = neighborhoodFill([...outline].reverse());
  assert.deepEqual(reverse, fill);
  const moved = cells(neighborhoodFill(outline.map(p => ({ x: p.x - 480, y: p.y - 480 }))));
  for (const [key, shade] of painted) { const [x, y] = key.split(',').map(Number); assert.equal(moved.get(`${x - 480},${y - 480}`), shade); }
});

test('fade and scatter change only material, keep solid centers and deterministic pixel choices', () => {
  const noFade = neighborhoodFill(outline, { ...defaults, fade: 0 });
  assert.ok(noFade.paths[0]); assert.deepEqual(noFade.paths.slice(1), ['', '', '']);
  const ordinary = cells(neighborhoodFill(outline));
  const scattered = neighborhoodFill(outline, { ...defaults, scatter: 100 });
  const sparse = cells(scattered);
  assert.deepEqual(neighborhoodFill(outline, { ...defaults, scatter: 100 }), scattered);
  assert.ok(sparse.size < ordinary.size);
  for (const [key, shade] of ordinary) if (shade === 0) assert.equal(sparse.get(key), 0);
  assert.ok([...sparse].every(([key, shade]) => ordinary.get(key) === shade));
  const larger = neighborhoodFill(outline, { ...defaults, pixelSize: 48 });
  assert.equal(larger.cellSize, 48); assert.ok(larger.cells < scattered.cells);
});

test('appearance validation is additive and strict; huge neighborhoods have bounded raster cost', () => {
  assert.deepEqual(neighborhoodAppearanceSchema.parse({ pixelSize: 48 }), { pixelSize: 48, fade: 96, scatter: 0, style: 'biome', texture: 'quiet', brightness: 24 });
  // Settings saved before biomes hold only the three numbers.
  assert.deepEqual(settingsSchema.parse({ neighborhoodAppearance: { pixelSize: 32, fade: 0, scatter: 5 } }).neighborhoodAppearance, { pixelSize: 32, fade: 0, scatter: 5, style: 'biome', texture: 'quiet', brightness: 24 });
  assert.deepEqual(neighborhoodAppearanceSchema.parse({ style: 'plain', texture: 'full', brightness: 24 }), { pixelSize: 24, fade: 96, scatter: 0, style: 'plain', texture: 'full', brightness: 24 });
  assert.equal(neighborhoodAppearanceSchema.parse({ brightness: 60 }).brightness, 60);
  for (const value of [{ brightness: 9 }, { brightness: 101 }, { brightness: 30.5 }, { brightness: '40' }]) assert.throws(() => neighborhoodAppearanceSchema.parse(value));
  for (const value of [{ style: 'biomes' }, { style: '' }, { style: null }, { texture: 'loud', brightness: 24 }, { texture: 1 }]) assert.throws(() => neighborhoodAppearanceSchema.parse(value));
  assert.deepEqual(defaults, { pixelSize: 24, fade: 96, scatter: 0, style: 'biome', texture: 'quiet', brightness: 24 });
  for (const value of [{ pixelSize: 0 }, { pixelSize: 7 }, { pixelSize: 97 }, { pixelSize: 24.5 }, { fade: -1 }, { fade: 481 }, { fade: Infinity }, { scatter: -1 }, { scatter: 101 }, { scatter: NaN }]) assert.equal(neighborhoodAppearanceSchema.safeParse(value).success, false);
  for (const [width, height] of [[1e8, 1e8], [1e8, 120], [120, 1e8]]) {
    const points = [{ x: -width / 2, y: -height / 2 }, { x: width / 2, y: -height / 2 }, { x: width / 2, y: height / 2 }, { x: -width / 2, y: height / 2 }];
    const fill = neighborhoodFill(points, { pixelSize: 8, fade: 480, scatter: 100 });
    assert.ok(fill.cells <= MAX_NEIGHBORHOOD_CELLS); assert.equal(fill.cellSize % 8, 0);
    assert.ok(fill.paths.some(Boolean));
    assert.ok(fill.paths.join('').length < 1_000_000);
  }
  assert.deepEqual(neighborhoodFill([]).paths, ['', '', '', '']);
  const square = neighborhoodFill([{ x: 0, y: 0 }, { x: 480, y: 0 }, { x: 480, y: 480 }, { x: 0, y: 480 }], { ...defaults, fade: 0 });
  assert.equal(square.paths[0], 'M0,0h480v480h-480Z');
  assert.equal(cells(square).size, 400);
});

test('the sampled cells are the grid the four paths are merged from', () => {
  const sampled = neighborhoodCells(outline, { pixelSize: 24, fade: 96, scatter: 40 }), fill = neighborhoodFill(outline, { pixelSize: 24, fade: 96, scatter: 40 }), painted = cells(fill);
  assert.deepEqual(neighborhoodPaths(sampled), fill);
  assert.equal(sampled.shades.length, sampled.columns * sampled.rows); assert.equal(fill.cells, sampled.shades.length);
  assert.ok(sampled.shades.includes(-1) && [0, 1, 2, 3].every(shade => sampled.shades.includes(shade)));
  sampled.shades.forEach((shade, index) => {
    const x = (sampled.x0 + index % sampled.columns) * sampled.cellSize, y = (sampled.y0 + Math.floor(index / sampled.columns)) * sampled.cellSize;
    assert.equal(painted.get(`${x},${y}`) ?? -1, shade);
  });
  assert.deepEqual(neighborhoodCells([]), { cellSize: 24, x0: 0, y0: 0, columns: 0, rows: 0, shades: new Int8Array(0) });
});
