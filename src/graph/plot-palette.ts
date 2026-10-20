import { PLOT_COLORS } from './plots.ts';
import type { PlotColor } from './plots.ts';
import { PROJECT_COLORS, projectColor } from './project-colors.ts';

/** What a plot slot shows in one neighborhood: `color` tints its patch and dashboard band,
 * `tone` (the color lifted when dark) draws its sign bar and sprout on the dark sign plate. */
export interface PlotSwatch { slot: PlotColor; name: string; color: string; tone: string }

/** Six colors that belong to each preset's place, in slot order (MAP-24). */
export const PLOT_PALETTES: Readonly<Record<typeof PROJECT_COLORS[number]['id'], readonly (readonly [name: string, color: string])[]>> = {
  grass: [['Buttercup', '#f2c94c'], ['Daisy', '#f6f6ee'], ['Fern', '#4f8a52'], ['Bluebell', '#8fa8e8'], ['Bark', '#a07a4a'], ['Sage', '#c4dcb4']],
  oak: [['Moss', '#8fa868'], ['Acorn', '#c27a3a'], ['Pine', '#3f6f3a'], ['Birch', '#f4ece0'], ['Toadstool', '#c8473c'], ['Honey', '#e6c27e']],
  stone: [['Quartz', '#f0f0f0'], ['Slate', '#6f8296'], ['Lichen', '#a8b878'], ['Iron', '#d9a987'], ['Flint', '#4a4a52'], ['Granite', '#c8a8a0']],
  diamond: [['Snow', '#ffffff'], ['Glacier', '#3fa9a2'], ['Aurora', '#b8a0f0'], ['Fox', '#f0a03c'], ['Fjord', '#3f6f9a'], ['Frost', '#c9f2ee']],
  lapis: [['Foam', '#dce6fb'], ['Lagoon', '#6fd6cf'], ['Coral', '#f08aa8'], ['Kelp', '#5fae6a'], ['Sandbar', '#e8d8a8'], ['Abyss', '#24387a']],
  amethyst: [['Crystal', '#ecdcfd'], ['Violet', '#7a52b4'], ['Rose quartz', '#f0a8c8'], ['Citrine', '#f0d878'], ['Obsidian', '#2e2442'], ['Opal', '#a8e0e0']],
  redstone: [['Sandstone', '#ecd2ac'], ['Ochre', '#e09a4f'], ['Rust', '#8a3a2e'], ['Sagebrush', '#9aa878'], ['Bone', '#f6efe4'], ['Mesa', '#d97a6a']],
  gold: [['Dune', '#f8f0d8'], ['Cactus', '#5f9a54'], ['Terracotta', '#c8623f'], ['Turquoise', '#4fb6b0'], ['Dusk', '#b88ab8'], ['Driftwood', '#9a7a4a']],
  prismarine: [['Lily', '#a8dc7a'], ['Murk', '#2f6a64'], ['Reed', '#d4c47a'], ['Mud', '#6a4a32'], ['Bloom', '#ec9cc4'], ['Mist', '#d6ece4']],
  netherrack: [['Lava', '#ff9a3a'], ['Ember', '#ffd45a'], ['Ash', '#8a7a78'], ['Soul', '#6fe3e6'], ['Crimson', '#d8303a'], ['Bone', '#eee2cc']],
};
const BY_COLOR = new Map<string, readonly (readonly [string, string])[]>(PROJECT_COLORS.map(preset => [preset.color, PLOT_PALETTES[preset.id]]));
/** A custom color's slots fan out from its hue; each is named after the 30° band it lands in, so the six never share a name. */
const CUSTOM_OFFSETS = [-25, 25, -55, 55, -90, 90], HUE_NAMES = ['Red', 'Orange', 'Yellow', 'Lime', 'Green', 'Jade', 'Teal', 'Sky', 'Blue', 'Violet', 'Magenta', 'Rose'];

function toHsl(hex: string): [number, number, number] {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255), max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min, s = l > .5 ? d / (2 - max - min) : d / (max + min);
  return [60 * (max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4), s, l];
}
function fromHsl(hue: number, saturation: number, lightness: number) {
  const h = (hue % 360 + 360) % 360, s = Math.max(0, Math.min(1, saturation)), l = Math.max(0, Math.min(1, lightness)), a = s * Math.min(l, 1 - l);
  const channel = (n: number) => { const k = (n + h / 30) % 12; return Math.max(0, Math.min(255, Math.round((l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))) * 255))); };
  return '#' + [0, 8, 4].map(n => channel(n).toString(16).padStart(2, '0')).join('');
}

/** The sign and sprout tone: a color darker than half lightness is lifted to .62. */
export function signTone(color: string) {
  const [h, s, l] = toHsl(color);
  return l < .5 ? fromHsl(h, s, .62) : color;
}

function customPalette(color: string): (readonly [string, string])[] {
  const [h, s, l] = toHsl(color), saturation = Math.max(.45, s), lightness = Math.max(.62, Math.min(.74, l + .08));
  return CUSTOM_OFFSETS.map(offset => [HUE_NAMES[Math.floor(((h + offset + 15) % 360 + 360) % 360 / 30)], fromHsl(h + offset, saturation, lightness)]);
}

const palettes = new Map<string, readonly PlotSwatch[]>();
/** A neighborhood's six plot colors in slot order: a preset's own palette, otherwise colors computed from the custom color. */
export function plotPalette(neighborhoodColor: string | undefined): readonly PlotSwatch[] {
  const color = projectColor({ color: neighborhoodColor }), known = palettes.get(color);
  if (known) return known;
  const palette = (BY_COLOR.get(color) ?? customPalette(color)).map(([name, hex], i) => ({ slot: PLOT_COLORS[i], name, color: hex, tone: signTone(hex) }));
  palettes.set(color, palette);
  return palette;
}
export const plotSwatch = (neighborhoodColor: string | undefined, slot: PlotColor) => plotPalette(neighborhoodColor)[PLOT_COLORS.indexOf(slot)];
