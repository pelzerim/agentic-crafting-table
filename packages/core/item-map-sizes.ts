import * as z from 'zod/v4';
import type { ResourcePluginDefinition, ResourceRecord, MapSizeProfile, MapSizePreset } from '../../src/resource-plugins/types.ts';
import type { GraphNode } from '../../src/graph/graph.ts';
import type { ItemSize } from '../../src/graph/graph.ts';
import { ITEM_SIZES } from '../../src/graph/graph.ts';
import { itemViewProfile, itemViewProfiles } from './item-views.ts';

export const mapDimensionsSchema = z.object({ width: z.number().int().min(32).max(640), height: z.number().int().min(24).max(480) });
export const itemMapSizesSchema = z.record(z.string().min(1).max(240), z.object({
  defaultSize: z.enum(ITEM_SIZES).optional(),
  sizes: z.object({ small: mapDimensionsSchema.optional(), medium: mapDimensionsSchema.optional(), large: mapDimensionsSchema.optional() }).default({}),
})).default({});
export type ItemMapSizes = z.infer<typeof itemMapSizesSchema>;
type Plugin = Pick<ResourcePluginDefinition, 'id' | 'name' | 'appearance' | 'view' | 'activation' | 'mapSizes'>;

/** Plugins without map metadata keep one intrinsic tier; installing a plugin
 * never forces its cards into the host's old universal dimensions. */
export function mapSizeProfile(plugin?: Plugin): MapSizeProfile {
  if (plugin?.mapSizes) return plugin.mapSizes;
  const appearance = plugin?.appearance, tier = appearance?.size ?? 'small';
  const size = tier === 'large' || tier === 'medium' ? tier : 'small';
  return { defaultSize: size, sizes: { [size]: {
    width: appearance?.width ?? ({ icon: 48, tiny: 144, small: 150, medium: 200, large: 240 }[tier]),
    height: { icon: 48, tiny: 32, small: 48, medium: 84, large: 112 }[tier],
    summaryLines: tier === 'large' ? 2 : tier === 'medium' ? 1 : 0,
    iconOnly: tier === 'icon', description: 'The item’s native map presentation.',
  } } };
}
export function mapSizeLimits(preset: MapSizePreset) {
  const minHeight = preset.minHeight ?? preset.height;
  const compact = minHeight <= 48;
  return { minWidth: preset.iconOnly ? 32 : compact ? Math.min(140, preset.width) : Math.min(180, preset.width),
    minHeight: preset.iconOnly ? 32 : minHeight,
    maxWidth: preset.iconOnly ? 96 : 640, maxHeight: preset.iconOnly ? 96 : compact ? 72 : 480 };
}
export function configuredMapProfile(plugin: Plugin | undefined, key: string, settings: ItemMapSizes = {}) {
  const base = mapSizeProfile(plugin), saved = settings[key];
  const defaultSize = saved?.defaultSize && base.sizes[saved.defaultSize] ? saved.defaultSize : base.defaultSize;
  const sizes = Object.fromEntries(ITEM_SIZES.filter(size => base.sizes[size]).map(size => {
    const preset = base.sizes[size]!, dimensions = saved?.sizes[size], limits = mapSizeLimits(preset);
    // A changed plugin contract can safely read older preferences without
    // silently deleting them. New settings writes are validated below.
    return [size, { ...preset, ...(dimensions ? {
      width: Math.max(limits.minWidth, Math.min(limits.maxWidth, dimensions.width)),
      height: Math.max(limits.minHeight, Math.min(limits.maxHeight, dimensions.height)),
    } : {}) }];
  })) as MapSizeProfile['sizes'];
  return { defaultSize, sizes };
}
export function itemResizeLimits(plugin?: Plugin) {
  const limits = Object.values(mapSizeProfile(plugin).sizes).map(mapSizeLimits);
  return { minWidth: Math.min(...limits.map(value => value.minWidth)), minHeight: Math.min(...limits.map(value => value.minHeight)),
    maxWidth: Math.max(...limits.map(value => value.maxWidth)), maxHeight: Math.max(...limits.map(value => value.maxHeight)) };
}
export function clampItemDimensions(value: { width: number; height: number }, limits: ReturnType<typeof itemResizeLimits>) {
  return { width: Math.round(Math.max(limits.minWidth, Math.min(limits.maxWidth, value.width))),
    height: Math.round(Math.max(limits.minHeight, Math.min(limits.maxHeight, value.height))) };
}
/** Line metrics shared by map layout and the tiles that draw growing text. */
export const GROW_LINE = { height: 20, chrome: 28, inset: 28, charWidth: 7 } as const;
/** A deterministic wrap estimate, so layout never depends on rendered fonts. */
export function wrappedLines(text: string, width: number) {
  const perLine = Math.max(8, Math.floor((width - GROW_LINE.inset) / GROW_LINE.charWidth));
  return text.split(/\r?\n/).reduce((count, line) => count + Math.max(1, Math.ceil(Array.from(line).length / perLine)), 0);
}
export function grownHeight(grow: NonNullable<MapSizePreset['growLines']>, data: ResourceRecord['data'], width: number) {
  const text = data[grow.field], lines = wrappedLines(typeof text === 'string' ? text : '', width);
  const footer = grow.footerField && data[grow.footerField] !== undefined ? 1 : 0;
  return GROW_LINE.chrome + (Math.min(grow.max, Math.max(grow.min, lines)) + footer) * GROW_LINE.height;
}
export function resolveMapSize(node: Pick<GraphNode, 'mapSize' | 'mapDimensions'>, resource: ResourceRecord, plugin?: Plugin, settings: ItemMapSizes = {}) {
  const key = itemViewProfile(plugin, resource).key;
  const profile = configuredMapProfile(plugin, key, settings);
  const dimensions = node.mapDimensions && clampItemDimensions(node.mapDimensions, itemResizeLimits(plugin));
  const supported = ITEM_SIZES.filter(size => profile.sizes[size]);
  const fits = (preset: MapSizePreset) => dimensions && preset.width <= dimensions.width && (preset.growLines || preset.height <= dimensions.height);
  const size = dimensions ? supported.findLast(size => fits(profile.sizes[size]!)) ?? supported[0]
    : node.mapSize && profile.sizes[node.mapSize] ? node.mapSize : profile.defaultSize;
  const resolved = { key, size, profile, ...profile.sizes[size]!, ...dimensions };
  return resolved.growLines ? { ...resolved, height: grownHeight(resolved.growLines, resource.data, resolved.width) } : resolved;
}
export interface MapSizePin { id: string; size?: ItemSize; dimensions?: { width: number; height: number } }
/** Use size as default for one item (MAP-18): `itemMapSizes` are the settings in which the item's tier is the default
 * of its type and, when the item has dimensions of its own, those are the tier's, within the tier's limits. `pins`
 * hold every other item of the type at the size it has now: on the tier it followed, or at its dimensions where the
 * tier itself changes. `disabled` says why there is nothing to change; the settings are then the given ones. */
export function sizeAsDefault(node: Pick<GraphNode, 'id' | 'resourceId' | 'mapSize' | 'mapDimensions'>, nodes: readonly Pick<GraphNode, 'id' | 'resourceId' | 'mapSize' | 'mapDimensions'>[],
  resources: readonly ResourceRecord[], plugins: { get(id: string): Plugin | undefined }, settings: ItemMapSizes = {}): { disabled?: string; itemMapSizes: ItemMapSizes; pins: MapSizePin[] } | undefined {
  const resource = resources.find(resource => resource.id === node.resourceId);
  if (!resource) return undefined;
  const plugin = plugins.get(resource.pluginId), type = itemViewProfile(plugin, resource), current = resolveMapSize(node, resource, plugin, settings);
  if (!node.mapDimensions && current.size === current.profile.defaultSize) return { disabled: `Already the default size for ${type.name}`, itemMapSizes: settings, pins: [] };
  const saved = settings[type.key]?.sizes ?? {};
  const itemMapSizes = { ...settings, [type.key]: { defaultSize: current.size, sizes: node.mapDimensions
    ? { ...saved, [current.size]: clampItemDimensions(node.mapDimensions, mapSizeLimits(mapSizeProfile(plugin).sizes[current.size]!)) } : saved } };
  const pins = nodes.flatMap((other): MapSizePin[] => {
    const record = other.id === node.id ? undefined : resources.find(resource => resource.id === other.resourceId);
    if (!record) return [];
    const kind = plugins.get(record.pluginId);
    if (itemViewProfile(kind, record).key !== type.key) return [];
    const before = resolveMapSize(other, record, kind, settings), same = (size: { width: number; height: number }) => size.width === before.width && size.height === before.height;
    if (same(resolveMapSize(other, record, kind, itemMapSizes))) return [];
    if (same(resolveMapSize({ mapSize: before.size }, record, kind, itemMapSizes))) return [{ id: other.id, size: before.size }];
    return [{ id: other.id, dimensions: clampItemDimensions({ width: before.width, height: before.growLines ? before.profile.sizes[before.size]!.height : before.height }, itemResizeLimits(kind)) }];
  });
  return { itemMapSizes, pins };
}
export function validateMapSettings(settings: ItemMapSizes, plugins: Plugin[]) {
  for (const plugin of plugins) for (const profile of itemViewProfiles(plugin)) {
    const saved = settings[profile.key]; if (!saved) continue;
    const base = mapSizeProfile(plugin);
    if (saved.defaultSize && !base.sizes[saved.defaultSize]) throw new Error(`${profile.name} does not support ${saved.defaultSize}`);
    for (const size of ITEM_SIZES) {
      const value = saved.sizes[size]; if (!value) continue;
      const preset = base.sizes[size];
      if (!preset) throw new Error(`${profile.name} does not support ${size}`);
      const limits = mapSizeLimits(preset);
      if (value.width < limits.minWidth || value.width > limits.maxWidth || value.height < limits.minHeight || value.height > limits.maxHeight) throw new Error(`${profile.name} ${size} needs width ${limits.minWidth}–${limits.maxWidth} and height ${limits.minHeight}–${limits.maxHeight}`);
    }
  }
}
