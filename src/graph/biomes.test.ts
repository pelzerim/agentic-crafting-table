import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BIOMES, BIOME_UNITS, GROWTH_CHANCE, TEXTURE_FLATTEN, biomeDetailVisible, biomeFor, biomeGrowth, biomeHash, paintBiome, paintGround, withGrowth } from './biomes.ts';
import type { BiomeSurface } from './biomes.ts';
import { PROJECT_COLORS, projectColor } from './project-colors.ts';
import { NEIGHBORHOOD_SHADES, NEIGHBORHOOD_TEXTURES, neighborhoodCells } from './neighborhood-fill.ts';
import type { NeighborhoodCells } from './neighborhood-fill.ts';

type Rect = { color: string; x: number; y: number; w: number; h: number };
const recorder = () => { const rects: Rect[] = []; const surface: BiomeSurface = { fillStyle: '', fillRect(x, y, w, h) { rects.push({ color: surface.fillStyle, x, y, w, h }); } }; return { rects, surface }; };
const square = (x0: number, y0: number, size: number) => [{ x: x0, y: y0 }, { x: x0 + size, y: y0 }, { x: x0 + size, y: y0 + size }, { x: x0, y: y0 + size }];
const pixel = (bitmap: { data: Uint8ClampedArray; width: number }, x: number, y: number) => [...bitmap.data.slice((y * bitmap.width + x) * 4, (y * bitmap.width + x) * 4 + 4)];
const key = (growth: ReturnType<typeof biomeGrowth>) => growth.map(g => `${g.column},${g.row},${g.sprite}`);

test('each colour preset is a biome and a custom colour is none', () => {
  assert.deepEqual(PROJECT_COLORS.map(preset => [preset.id, biomeFor(preset.color)?.name]), [
    ['grass', 'Grassland'], ['oak', 'Woodland'], ['stone', 'Mountain'], ['diamond', 'Tundra'], ['lapis', 'Ocean'],
    ['amethyst', 'Geode'], ['redstone', 'Badlands'], ['gold', 'Desert'], ['prismarine', 'Swamp'], ['netherrack', 'Nether']]);
  assert.deepEqual(BIOMES.map(biome => biome.base), PROJECT_COLORS.map(preset => preset.color));
  assert.equal(biomeFor('#6FD6CF')?.id, 'diamond');
  assert.equal(biomeFor(projectColor(undefined))?.id, 'grass');
  for (const custom of ['#123456', '#91b78c', 'var(--act-mute-hull)', '', undefined]) assert.equal(biomeFor(custom), undefined);
});

test('grounds, flat colours and growth sprites are the design reference, at one sixth of a cell per unit', () => {
  const script = readFileSync(new URL('../../tests/fixtures/biomes-reference.js', import.meta.url), 'utf8');
  const reference = new Function(`${script}; return { BIOMES, hash };`)() as { BIOMES: { id: string; base: string; flat?: string; ground(c: unknown, x: number, y: number, i: number, j: number): void; props: { rows: string[]; pal: Record<string, string> }[] }[]; hash(x: number, y: number, s?: number): number };
  assert.equal(BIOME_UNITS, 6);
  assert.deepEqual(BIOMES.map(biome => biome.id), reference.BIOMES.map(biome => biome.id));
  for (const [index, biome] of BIOMES.entries()) {
    const designed = reference.BIOMES[index];
    assert.equal(biome.flat, designed.flat ?? designed.base);
    assert.deepEqual(biome.props.map(sprite => ({ rows: [...sprite.rows], pal: { ...sprite.pal } })), designed.props.map(sprite => ({ rows: sprite.rows, pal: sprite.pal })));
    for (let j = 0; j < 24; j++) for (let i = 0; i < 24; i++) {
      const mine = recorder(), theirs = recorder();
      biome.ground(mine.surface, i * 6, j * 6, i, j); designed.ground(theirs.surface, i * 12, j * 12, i, j);
      assert.deepEqual(mine.rects, theirs.rects.map(rect => ({ color: rect.color, x: rect.x / 2, y: rect.y / 2, w: rect.w / 2, h: rect.h / 2 })), `${biome.id} ${i},${j}`);
    }
  }
  for (const [x, y, seed] of [[0, 0, 0], [3, -7, 40], [-120, 55, 41], [9999, 12345, 5]]) assert.equal(biomeHash(x, y, seed), reference.hash(x, y, seed));
});

test('every ground paints whole units inside its cell at negative world cells too', () => {
  for (const biome of BIOMES) for (let j = -14; j < 2; j++) for (let i = -14; i < 2; i++) {
    const { rects, surface } = recorder(); biome.ground(surface, 0, 0, i, j);
    assert.deepEqual(rects[0] && { x: rects[0].x, y: rects[0].y, w: rects[0].w, h: rects[0].h }, { x: 0, y: 0, w: 6, h: 6 });
    for (const rect of rects) {
      assert.match(rect.color, /^#[0-9a-f]{6}$/, `${biome.id} ${i},${j}`);
      assert.ok([rect.x, rect.y, rect.w, rect.h].every(Number.isInteger) && rect.x >= 0 && rect.y >= 0 && rect.x + rect.w <= 6 && rect.y + rect.h <= 6);
    }
  }
});

test('texture strength blends the ground toward the flat colour and leaves the shade alpha', () => {
  assert.deepEqual(TEXTURE_FLATTEN, { quiet: .62, medium: .34, full: 0 });
  const tundra = biomeFor('#6fd6cf')!, cells = neighborhoodCells(square(0, 0, 480));
  const full = paintBiome(tundra, cells, 'full'), quiet = paintBiome(tundra, cells, 'quiet'), medium = paintBiome(tundra, cells, 'medium');
  assert.deepEqual([full.width, full.height], [cells.columns * 6, cells.rows * 6]);
  const flat = [0xa9, 0xe0, 0xdb], centre = (cells.rows / 2 * cells.columns + cells.columns / 2);
  assert.equal(cells.shades[centre], 0);
  const grown = new Set(biomeGrowth(tundra, cells, 'full').map(g => (g.row - cells.y0) * cells.columns + g.column - cells.x0));
  let differs = 0;
  for (let y = 0; y < full.height; y++) for (let x = 0; x < full.width; x++) {
    if (grown.has(Math.floor(y / 6) * cells.columns + Math.floor(x / 6))) continue;
    const shade = cells.shades[Math.floor(y / 6) * cells.columns + Math.floor(x / 6)], [r, g, b, a] = pixel(full, x, y);
    assert.equal(a, Math.round(NEIGHBORHOOD_SHADES[shade] * 255));
    for (const [bitmap, amount] of [[quiet, .62], [medium, .34]] as const) {
      const [qr, qg, qb, qa] = pixel(bitmap, x, y);
      assert.equal(qa, a);
      assert.deepEqual([qr, qg, qb], [r, g, b].map((value, channel) => Math.round(value + (flat[channel] - value) * amount)));
    }
    if (r !== flat[0]) differs++;
  }
  assert.ok(differs > full.width * full.height / 2);
});

test('scattered and outside cells stay transparent', () => {
  const cells = neighborhoodCells(square(-240, -240, 960), { pixelSize: 24, fade: 240, scatter: 100 }), bitmap = paintBiome(BIOMES[0], cells, 'full');
  assert.ok(cells.shades.includes(-1));
  cells.shades.forEach((shade, index) => {
    const x = index % cells.columns * 6, y = Math.floor(index / cells.columns) * 6;
    for (const [dx, dy] of [[0, 0], [5, 5], [2, 3]]) assert.equal(pixel(bitmap, x + dx, y + dy)[3] === 0, shade < 0);
  });
});

test('growth is the same on every draw and keyed on world cells, not on the enclosure', () => {
  const biome = biomeFor('#b8945f')!, wide = neighborhoodCells(square(-960, -960, 1920)), again = neighborhoodCells(square(-960, -960, 1920));
  for (const texture of NEIGHBORHOOD_TEXTURES) {
    assert.deepEqual(biomeGrowth(biome, wide, texture), biomeGrowth(biome, again, texture));
    assert.deepEqual(paintBiome(biome, wide, texture).data, paintBiome(biome, again, texture).data);
  }
  // A second enclosure overlapping the first: cells that are solid in both roll the same growth.
  const shifted = neighborhoodCells(square(-480, -720, 1920)), solid = (cells: NeighborhoodCells, column: number, row: number) => {
    const x = column - cells.x0, y = row - cells.y0; return x >= 0 && y >= 0 && x < cells.columns && y < cells.rows && cells.shades[y * cells.columns + x] === 0;
  };
  const shared = (from: NeighborhoodCells, other: NeighborhoodCells) => key(biomeGrowth(biome, from, 'full').filter(g => solid(from, g.column, g.row) && solid(other, g.column, g.row)));
  assert.ok(shared(wide, shifted).length > 20);
  assert.deepEqual(shared(wide, shifted), shared(shifted, wide));
  for (const growth of biomeGrowth(biome, wide, 'full')) {
    assert.ok(biomeHash(growth.column, growth.row, 40) <= GROWTH_CHANCE.full.ring);
    assert.equal(growth.sprite, Math.floor(biomeHash(growth.column, growth.row, 41) * biome.props.length));
  }
});

test('growth stands in the fading ring, sparsely in open ground from Medium up, never in the faintest band', () => {
  assert.deepEqual(GROWTH_CHANCE, { quiet: { ring: .14, open: 0 }, medium: { ring: .22, open: .03 }, full: { ring: .3, open: .07 } });
  const biome = BIOMES[0], cells = neighborhoodCells(square(0, 0, 2400)), shadeOf = (g: { column: number; row: number }) => cells.shades[(g.row - cells.y0) * cells.columns + g.column - cells.x0];
  const [quiet, medium, full] = NEIGHBORHOOD_TEXTURES.map(texture => biomeGrowth(biome, cells, texture));
  assert.ok(quiet.length > 10 && quiet.every(g => shadeOf(g) === 1 || shadeOf(g) === 2));
  assert.ok(medium.some(g => shadeOf(g) === 0) && full.every(g => shadeOf(g) >= 0 && shadeOf(g) <= 2));
  assert.ok(key(quiet).every(k => key(medium).includes(k)) && key(medium).every(k => key(full).includes(k)));
  assert.ok(quiet.length < medium.length && medium.length < full.length);
  const ring = [...cells.shades].filter(shade => shade === 1 || shade === 2).length;
  assert.ok(Math.abs(quiet.length / ring - .14) < .04);
  const bitmap = paintBiome(biome, cells, 'quiet'), first = quiet[0], sprite = biome.props[first.sprite];
  const column = sprite.rows[0].length, row = sprite.rows.findIndex(line => /[^.]/.test(line)), at = sprite.rows[row].search(/[^.]/);
  const x = (first.column - cells.x0) * 6 + Math.floor((6 - column) / 2) + at, y = (first.row - cells.y0) * 6 + 6 - sprite.rows.length + row;
  const color = sprite.pal[sprite.rows[row][at]];
  assert.deepEqual(pixel(bitmap, x, y), [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16)).concat(Math.round(Math.max(NEIGHBORHOOD_SHADES[shadeOf(first)], .75) * 255)));
});

test('growth never stands under or right beside an item, and moving an item only changes the cells it covers or uncovers', () => {
  const biome = BIOMES[7], cells = neighborhoodCells(square(0, 0, 1920)), unit = cells.cellSize / 6;
  const card = { x: 960, y: 960, width: 300, height: 96 }, edge = { x: 150, y: 150, width: 240, height: 120 };
  const beside = (g: { column: number; row: number }, r: typeof card) => {
    const x = g.column * cells.cellSize, y = g.row * cells.cellSize;
    return x + cells.cellSize > r.x - r.width / 2 - 5 * unit && x < r.x + r.width / 2 + 5 * unit && y + cells.cellSize > r.y - r.height / 2 - 5 * unit && y < r.y + r.height / 2 + 6 * unit;
  };
  const free = biomeGrowth(biome, cells, 'full'), kept = biomeGrowth(biome, cells, 'full', [card, edge]);
  assert.ok(free.some(g => beside(g, card)) && free.some(g => beside(g, edge)));
  assert.ok(kept.every(g => !beside(g, card) && !beside(g, edge)));
  assert.deepEqual(key(kept), key(free.filter(g => !beside(g, card) && !beside(g, edge))));
  const moved = { ...card, x: card.x + 72 }, after = biomeGrowth(biome, cells, 'full', [moved, edge]);
  assert.deepEqual(key(after), key(free.filter(g => !beside(g, moved) && !beside(g, edge))));
  assert.notDeepEqual(key(after), key(kept));
});

test('a coarsened enclosure keeps six units per cell', () => {
  const cells = neighborhoodCells(square(0, 0, 24_000)), bitmap = paintBiome(BIOMES[3], cells, 'quiet');
  assert.ok(cells.cellSize > 24);
  assert.deepEqual([bitmap.width, bitmap.height], [cells.columns * 6, cells.rows * 6]);
});

test('growth is stamped on a copy, so one baked ground serves every item position', () => {
  const biome = BIOMES[0], cells = neighborhoodCells(square(0, 0, 960)), ground = paintGround(biome, cells, 'full'), before = ground.data.slice();
  const grown = withGrowth(ground, biome, cells, biomeGrowth(biome, cells, 'full'));
  assert.deepEqual(ground.data, before); assert.notDeepEqual(grown.data, before);
  assert.deepEqual(grown.data, paintBiome(biome, cells, 'full').data);
  assert.deepEqual(withGrowth(ground, biome, cells, []).data, before);
});

test('ground detail smaller than a device pixel is not drawn', () => {
  assert.equal(biomeDetailVisible(24, .25), true); assert.equal(biomeDetailVisible(24, .24), false);
  assert.equal(biomeDetailVisible(24, .2, 2), true); assert.equal(biomeDetailVisible(8, .7), false); assert.equal(biomeDetailVisible(96, .2), true);
});
