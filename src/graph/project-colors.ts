/** Neighborhood base colors. Grass is the default; any #rrggbb is accepted. */
export const PROJECT_COLORS = [
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
export const DEFAULT_PROJECT_COLOR = PROJECT_COLORS[0].color;
export const PROJECT_COLOR_PATTERN = /^#[0-9a-f]{6}$/i;
export function projectColor(node: { color?: string } | undefined) { return node?.color && PROJECT_COLOR_PATTERN.test(node.color) ? node.color.toLowerCase() : DEFAULT_PROJECT_COLOR; }
/** A very dark version of a project's color, used for its neighborhood in Undermap. */
export function undermapColor(color: string, amount = .38) {
  const hex = projectColor({ color });
  return '#' + [1, 3, 5].map(i => Math.round(parseInt(hex.slice(i, i + 2), 16) * amount).toString(16).padStart(2, '0')).join('');
}
