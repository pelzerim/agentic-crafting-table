import { HEX_COLOR_PATTERN } from './colors.ts';

/** Neighborhood base colors that are biomes (BIOME-01). Grass is the default; any #rrggbb is accepted. */
export const BIOME_PROJECT_COLORS = [
  { id: 'grass', label: 'Grass', color: '#91b78b' },
  { id: 'oak', label: 'Oak planks', color: '#b8945f' },
  { id: 'stone', label: 'Stone', color: '#9a9a9a' },
  { id: 'diamond', label: 'Diamond', color: '#6fd6cf' },
  { id: 'lapis', label: 'Lapis', color: '#5b7fd6' },
  { id: 'amethyst', label: 'Amethyst', color: '#a884d8' },
  { id: 'redstone', label: 'Redstone', color: '#d0564c' },
  { id: 'gold', label: 'Gold', color: '#e3c55a' },
  { id: 'prismarine', label: 'Prismarine', color: '#63a99c' },
  { id: 'netherrack', label: 'Netherrack', color: '#9a4e4e' },
] as const;
/** Every preset the picker offers: the biomes first, then plain colours that paint like a custom color. */
export const PROJECT_COLORS = [
  ...BIOME_PROJECT_COLORS,
  { id: 'emerald', label: 'Emerald', color: '#3fae6a' },
  { id: 'moss', label: 'Moss', color: '#6f8a4a' },
  { id: 'ice', label: 'Ice', color: '#a8d8e8' },
  { id: 'quartz', label: 'Quartz', color: '#e4dcd8' },
  { id: 'birch', label: 'Birch', color: '#e8e0c8' },
  { id: 'sand', label: 'Sand', color: '#d8c49a' },
  { id: 'clay', label: 'Clay', color: '#a8644a' },
  { id: 'copper', label: 'Copper', color: '#c4703c' },
  { id: 'coral', label: 'Coral', color: '#e8806c' },
  { id: 'obsidian', label: 'Obsidian', color: '#3a3046' },
] as const;
export const DEFAULT_PROJECT_COLOR = BIOME_PROJECT_COLORS[0].color;
export const PROJECT_COLOR_PATTERN = HEX_COLOR_PATTERN;
export function projectColor(node: { color?: string } | undefined) { return node?.color && PROJECT_COLOR_PATTERN.test(node.color) ? node.color.toLowerCase() : DEFAULT_PROJECT_COLOR; }
/** A very dark version of a project's color, used for its neighborhood in Undermap. */
export function undermapColor(color: string, amount = .38) {
  const hex = projectColor({ color });
  return '#' + [1, 3, 5].map(i => Math.round(parseInt(hex.slice(i, i + 2), 16) * amount).toString(16).padStart(2, '0')).join('');
}
