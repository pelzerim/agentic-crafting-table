import { BIOME_PROJECT_COLORS } from './project-colors.ts';
import { NEIGHBORHOOD_SHADES } from './neighborhood-fill.ts';
import type { NeighborhoodCells, NeighborhoodTexture } from './neighborhood-fill.ts';

/** The part of a 2D canvas context a ground is painted with. */
export interface BiomeSurface { fillStyle: string; fillRect(x: number, y: number, width: number, height: number): void }
export interface BiomeSprite { readonly rows: readonly string[]; readonly pal: Readonly<Record<string, string>> }
export interface Biome {
  /** The colour preset this biome belongs to. */
  readonly id: typeof BIOME_PROJECT_COLORS[number]['id']; readonly name: string; readonly base: string;
  /** The one colour the ground is pulled toward, and the fill when detail is too small to draw. */
  readonly flat: string;
  /** Paints world cell (`i`, `j`) as `BIOME_UNITS` square units from (`x`, `y`). */
  ground(surface: BiomeSurface, x: number, y: number, i: number, j: number): void;
  readonly props: readonly BiomeSprite[];
}
export interface BiomeRect { x: number; y: number; width: number; height: number }
export interface BiomeGrowth { column: number; row: number; sprite: number; alpha: number }

/** Detail units along one field cell: texture and sprites are drawn in sixths of the pixel size. */
export const BIOME_UNITS = 6;
/** How far each texture strength pulls the ground back to the flat colour. */
export const TEXTURE_FLATTEN: Readonly<Record<NeighborhoodTexture, number>> = { quiet: .62, medium: .34, full: 0 };
/** Chance per field cell that something grows there: in the fading ring, and in open ground. */
export const GROWTH_CHANCE: Readonly<Record<NeighborhoodTexture, { ring: number; open: number }>> = { quiet: { ring: .14, open: 0 }, medium: { ring: .22, open: .03 }, full: { ring: .3, open: .07 } };
/** Growth keeps this many units clear of an item: beside and above it, and below it. */
export const GROWTH_CLEARANCE = { side: 5, below: 6 } as const;
const GROWTH_MIN_SHADE = .4, GROWTH_MIN_ALPHA = .75;

/** Stable noise on world cell coordinates: the same cell is the same ground on every draw. */
export function biomeHash(x: number, y: number, seed = 0) {
  let n = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(seed | 0, 1274126177);
  n = Math.imul(n ^ (n >>> 13), 1103515245); n ^= n >>> 16;
  return (n >>> 0) / 4294967296;
}
const hash = biomeHash;
function noise(x: number, y: number, seed: number) {
  const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi;
  const a = hash(xi, yi, seed), b = hash(xi + 1, yi, seed), c = hash(xi, yi + 1, seed), d = hash(xi + 1, yi + 1, seed);
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}
const parsed = new Map<string, number>();
/** The palette is a few dozen literals; each is parsed once. */
const rgb = (hex: string) => { let value = parsed.get(hex); if (value === undefined) { value = parseInt(hex.slice(1), 16); parsed.set(hex, value); } return value; };
const blend = (from: number, to: number, t: number, shift: number) => { const v = from >> shift & 255; return Math.round(v + ((to >> shift & 255) - v) * t) << shift; };
const mix = (a: string, b: string, t: number) => { const p = rgb(a), q = rgb(b); return '#' + (1 << 24 | blend(p, q, t, 16) | blend(p, q, t, 8) | blend(p, q, t, 0)).toString(16).slice(1); };
const shade = (hex: string, by: number) => by >= 0 ? mix(hex, '#ffffff', by) : mix(hex, '#000000', -by);
const box = (c: BiomeSurface, color: string, x: number, y: number, w: number, h: number) => { c.fillStyle = color; c.fillRect(x, y, w, h); };
const cell = (c: BiomeSurface, color: string, x: number, y: number) => box(c, color, x, y, BIOME_UNITS, BIOME_UNITS);
const specks = (c: BiomeSurface, x: number, y: number, i: number, j: number, seed: number, count: number, colors: readonly string[], w: number, h: number) => {
  for (let k = 0; k < count; k++) {
    const a = hash(i, j, seed + k * 3), b = hash(i, j, seed + k * 3 + 1);
    box(c, colors[Math.floor(hash(i, j, seed + k * 3 + 2) * colors.length)], x + Math.floor(a * (BIOME_UNITS - w)), y + Math.floor(b * (BIOME_UNITS - h)), w, h);
  }
};
const S = (rows: readonly string[], pal: Readonly<Record<string, string>>): BiomeSprite => ({ rows, pal });
const STRATA = ['#c8623f', '#d98a4f', '#e2c29c', '#b9523f', '#a5503e', '#d0564c'];
const TREE = ['.ddd.', 'dDDdd', 'dDdDd', 'ddDdd', '.ddd.'], PAD = ['.ggg.', 'ggggg', 'gg.gg'], TWIGS = ['b.b.b', '.bbb.', '..b..'];

export const BIOMES: readonly Biome[] = [
  { id: 'grass', name: 'Grassland', base: '#91b78b', flat: '#91b78b',
    ground(c, x, y, i, j) { cell(c, shade('#91b78b', (hash(i, j, 1) - .5) * .1), x, y); specks(c, x, y, i, j, 5, 3, ['#7da877', '#a9cba1'], 1, 2); },
    props: [S(['g.g.g', '.ggg.'], { g: '#5f9458' }), S(['.w.', 'wyw', '.w.', '.g.'], { w: '#f6f6ee', y: '#f2c94c', g: '#5f9458' }), S(['.ddd.', 'dDdDd', 'ddddd'], { d: '#5f9458', D: '#7fb376' })] },
  { id: 'oak', name: 'Woodland', base: '#b8945f', flat: '#a58f5c',
    ground(c, x, y, i, j) { const moss = noise(i / 2.2, j / 2.2, 3) > .6; cell(c, shade(moss ? '#8fa868' : '#a98a58', (hash(i, j, 1) - .5) * .12), x, y); specks(c, x, y, i, j, 5, 3, moss ? ['#7b9656'] : ['#cfa35e', '#8a6c3e', '#c27a3a'], 1, 1); },
    props: [S(TREE, { d: '#3f6f3a', D: '#5d9150' }), S(TREE, { d: '#4d7a3a', D: '#79a84f' }), S(['.rrr.', 'rwrwr', '..s..'], { r: '#c8473c', w: '#f4ece0', s: '#e9dcc4' }), S(['bbbbb', 'bBBBo'], { b: '#6a4a2a', B: '#8a6436', o: '#d6b77e' })] },
  { id: 'stone', name: 'Mountain', base: '#9a9a9a', flat: '#9a9a9a',
    ground(c, x, y, i, j) { cell(c, shade('#9a9a9a', (hash(i, j, 1) - .5) * .18), x, y); if (hash(i, j, 2) < .32) { box(c, '#7c7c7c', x + 1, y + 2, 3, 1); box(c, '#7c7c7c', x + 3, y + 2, 1, 3); } specks(c, x, y, i, j, 5, 1, ['#b6b6b6'], 1, 1); },
    props: [S(['.ggg.', 'gGGgg', 'ggGgd', '.ddd.'], { g: '#b9b9b9', G: '#d2d2d2', d: '#767676' }), S(['k.k', '.k.', 'k..'], { k: '#2e2e2e' }), S(['o.o', '.o.'], { o: '#d9a987' })] },
  { id: 'diamond', name: 'Tundra', base: '#6fd6cf', flat: '#a9e0db',
    ground(c, x, y, i, j) {
      const snow = noise(i / 2.4, j / 2.4, 3) > .5; cell(c, snow ? shade('#e6f3f2', (hash(i, j, 1) - .5) * .06) : shade('#8adbd5', (hash(i, j, 1) - .5) * .12), x, y);
      if (!snow && hash(i, j, 2) < .5) { box(c, '#c9f2ee', x + 1, y + 3, 1, 1); box(c, '#c9f2ee', x + 2, y + 2, 1, 1); box(c, '#c9f2ee', x + 3, y + 1, 1, 1); }
      if (snow) specks(c, x, y, i, j, 5, 1, ['#c7e2e4'], 1, 1);
    },
    props: [S(['..w..', '..c..', '.wc..', '.cCc.', 'cCCCc'], { w: '#ffffff', c: '#a8ece6', C: '#5cc4bd' }), S(['.www.', 'wwwww'], { w: '#ffffff' }), S(['.ww.', '.wo.', 'wwww', 'wkww'], { w: '#ffffff', o: '#f0a03c', k: '#33423a' })] },
  { id: 'lapis', name: 'Ocean', base: '#5b7fd6', flat: '#5b7fd6',
    ground(c, x, y, i, j) { cell(c, shade('#5b7fd6', (noise(i / 3, j / 3, 3) - .55) * .34), x, y); if (hash(i, j, 2) < .6) box(c, '#86a4ec', x + (j % 2 ? 0 : 2), y + 2 + (hash(i, j, 4) < .5 ? 0 : 2), 3, 1); },
    props: [S(PAD, { g: '#5fae6a' }), S(['.ggg.', 'gGGgd'], { g: '#9aa3ad', G: '#c2c9d0', d: '#6a727c' }), S(['p.p', 'ppp', '.p.'], { p: '#f08aa8' })] },
  { id: 'amethyst', name: 'Geode', base: '#a884d8', flat: '#7558a4',
    ground(c, x, y, i, j) { cell(c, mix('#a884d8', '#2b1f47', .38 + hash(i, j, 1) * .2), x, y); if (hash(i, j, 2) < .45) { box(c, '#c3a4ee', x + 2, y + 1, 1, 1); box(c, '#c3a4ee', x + 1, y + 2, 3, 1); box(c, '#8b68c2', x + 2, y + 3, 1, 1); } },
    props: [S(['..p..', '.pPp.', '.pPp.', 'pPwPp'], { p: '#b78fe8', P: '#dcc4fa', w: '#ffffff' }), S(['.p.', 'pPp', 'pPp'], { p: '#9a72d4', P: '#dcc4fa' })] },
  { id: 'redstone', name: 'Badlands', base: '#d0564c', flat: '#c96a48',
    ground(c, x, y, i, j) { const band = ((j + Math.floor(noise(i / 3, j / 6, 3) * 3)) % 6 + 6) % 6; cell(c, shade(STRATA[band], (hash(i, j, 1) - .5) * .06), x, y); },
    props: [S(TWIGS, { b: '#6a4636' }), S(['r', 'b', 'b'], { r: '#ff5a4a', b: '#6a4636' }), S(['b.b', '.b.'], { b: '#7a3a30' })] },
  { id: 'gold', name: 'Desert', base: '#e3c55a', flat: '#e3c55a',
    ground(c, x, y, i, j) { cell(c, shade('#e3c55a', (noise(i / 4, j / 2, 3) - .5) * .16), x, y); if ((i + j) % 2 === 0) { box(c, '#cfae48', x + 1, y + 4, 2, 1); box(c, '#cfae48', x + 3, y + 3, 2, 1); } },
    props: [S(['..g..', 'g.g.g', 'ggggg', '..g..', '..g..'], { g: '#5f9a54' }), S(TWIGS, { b: '#8a6a3a' }), S(['w.w', '.w.', 'w.w'], { w: '#f4ecd8' })] },
  { id: 'prismarine', name: 'Swamp', base: '#63a99c', flat: '#63a391',
    ground(c, x, y, i, j) { const n = noise(i / 2.6, j / 2.6, 3); cell(c, shade(n > .56 ? '#84ad6c' : n > .4 ? '#63a99c' : '#3f7f78', (hash(i, j, 1) - .5) * .1), x, y); specks(c, x, y, i, j, 5, 2, n > .56 ? ['#6b9458'] : ['#57998c'], 1, 1); },
    props: [S(['b.b', 'b.b', 'g.g', 'g.g'], { b: '#6a4a2a', g: '#4f8a52' }), S(PAD, { g: '#9fd37a' }), S(['.bb.', 'b..b', 'b..b'], { b: '#5a4030' })] },
  { id: 'netherrack', name: 'Nether', base: '#9a4e4e', flat: '#8f4a48',
    ground(c, x, y, i, j) { const lava = noise(i / 2.2, j / 2.2, 3) > .68; cell(c, lava ? '#e8862e' : shade('#8a4444', (hash(i, j, 1) - .5) * .16), x, y); specks(c, x, y, i, j, 5, 2, lava ? ['#ffd45a'] : ['#6a3034', '#a85a56'], 1, 1); },
    props: [S(['.oyo.', 'oyYyo', '.oyo.'], { o: '#e8862e', y: '#ffd45a', Y: '#fff2a8' }), S(['.y.', 'yoy', 'oro'], { y: '#ffd45a', o: '#e8862e', r: '#c8473c' }), S(['c', 'b', 'b'], { c: '#6fe3e6', b: '#3a2a26' })] },
];
const BY_COLOR = new Map(BIOMES.map(biome => [biome.base, biome]));
/** The biome of a preset colour. A custom colour has none and keeps a plain fill. */
export function biomeFor(color: string | undefined): Biome | undefined { return color === undefined ? undefined : BY_COLOR.get(color.toLowerCase()); }

/** Where growth stands. Each world cell rolls once, so a cell keeps its sprite however the
 * enclosure moves around it; `items` are centre-anchored world rectangles it keeps clear of. */
export function biomeGrowth(biome: Biome, cells: NeighborhoodCells, texture: NeighborhoodTexture, items: readonly BiomeRect[] = []): BiomeGrowth[] {
  const { cellSize, x0, y0, columns, rows, shades } = cells, chance = GROWTH_CHANCE[texture], unit = cellSize / BIOME_UNITS, growth: BiomeGrowth[] = [];
  const side = GROWTH_CLEARANCE.side * unit, below = GROWTH_CLEARANCE.below * unit;
  const keep = items.map(r => ({ left: r.x - r.width / 2 - side, right: r.x + r.width / 2 + side, top: r.y - r.height / 2 - side, bottom: r.y + r.height / 2 + below }));
  for (let j = 0; j < rows; j++) for (let i = 0; i < columns; i++) {
    const level = shades[j * columns + i];
    if (level < 0 || NEIGHBORHOOD_SHADES[level] < GROWTH_MIN_SHADE) continue;
    const column = x0 + i, row = y0 + j;
    if (hash(column, row, 40) > (level === 0 ? chance.open : chance.ring)) continue;
    const x = column * cellSize, y = row * cellSize;
    if (keep.some(r => x + cellSize > r.left && x < r.right && y + cellSize > r.top && y < r.bottom)) continue;
    growth.push({ column, row, sprite: Math.floor(hash(column, row, 41) * biome.props.length), alpha: Math.max(NEIGHBORHOOD_SHADES[level], GROWTH_MIN_ALPHA) });
  }
  return growth;
}

/** RGBA pixels, one per detail unit. A later rectangle replaces what it covers, so a cell's
 * alpha is exactly its shade however many details lie on it. */
export class BiomeBitmap implements BiomeSurface {
  readonly data: Uint8ClampedArray<ArrayBuffer>; readonly width: number; readonly height: number;
  fillStyle = '#000000'; alpha = 1;
  /** Every colour is mixed this far toward `flat` before it is written. */
  flatten = 0;
  private readonly flat: number; private readonly view: DataView;
  constructor(width: number, height: number, flat = '#000000') { this.width = width; this.height = height; this.data = new Uint8ClampedArray(width * height * 4); this.view = new DataView(this.data.buffer); this.flat = rgb(flat); }
  fillRect(x: number, y: number, width: number, height: number) {
    const value = parseInt(this.fillStyle.slice(1), 16), t = this.flatten, flat = this.flat;
    const pixel = ((blend(value, flat, t, 16) | blend(value, flat, t, 8) | blend(value, flat, t, 0)) << 8 | Math.round(this.alpha * 255)) >>> 0;
    for (let row = Math.max(0, y), end = Math.min(this.height, y + height); row < end; row++) for (let at = (row * this.width + Math.max(0, x)) * 4, stop = (row * this.width + Math.min(this.width, x + width)) * 4; at < stop; at += 4) this.view.setUint32(at, pixel);
  }
}

/** Bake a neighborhood's ground: static, camera-independent, `BIOME_UNITS` pixels per field cell. */
export function paintGround(biome: Biome, cells: NeighborhoodCells, texture: NeighborhoodTexture): BiomeBitmap {
  const { x0, y0, columns, rows, shades } = cells, bitmap = new BiomeBitmap(columns * BIOME_UNITS, rows * BIOME_UNITS, biome.flat);
  bitmap.flatten = TEXTURE_FLATTEN[texture];
  for (let j = 0; j < rows; j++) for (let i = 0; i < columns; i++) {
    const level = shades[j * columns + i];
    if (level < 0) continue;
    bitmap.alpha = NEIGHBORHOOD_SHADES[level]; biome.ground(bitmap, i * BIOME_UNITS, j * BIOME_UNITS, x0 + i, y0 + j);
  }
  return bitmap;
}
/** A copy of a baked ground with growth standing on it, each sprite centred on the floor of its cell. */
export function withGrowth(ground: BiomeBitmap, biome: Biome, cells: NeighborhoodCells, growth: readonly BiomeGrowth[]): BiomeBitmap {
  const bitmap = new BiomeBitmap(ground.width, ground.height); bitmap.data.set(ground.data);
  for (const { column, row, sprite, alpha } of growth) {
    const { rows: lines, pal } = biome.props[sprite], width = lines[0].length;
    const x = (column - cells.x0) * BIOME_UNITS + Math.floor((BIOME_UNITS - width) / 2), y = (row - cells.y0 + 1) * BIOME_UNITS - lines.length;
    bitmap.alpha = alpha;
    lines.forEach((line, dy) => { for (let dx = 0; dx < width; dx++) if (line[dx] !== '.') box(bitmap, pal[line[dx]], x + dx, y + dy, 1, 1); });
  }
  return bitmap;
}
export function paintBiome(biome: Biome, cells: NeighborhoodCells, texture: NeighborhoodTexture, items: readonly BiomeRect[] = []): BiomeBitmap {
  return withGrowth(paintGround(biome, cells, texture), biome, cells, biomeGrowth(biome, cells, texture, items));
}
/** Whether one detail unit covers at least a device pixel; below that the ground is drawn flat. */
export function biomeDetailVisible(pixelSize: number, zoom: number, pixelRatio = 1) { return pixelSize / BIOME_UNITS * zoom * pixelRatio >= 1; }
