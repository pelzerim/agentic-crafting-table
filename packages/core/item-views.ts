import * as z from 'zod/v4';
import type { ResourcePluginDefinition, ResourceRecord } from '../../src/resource-plugins/types.ts';

export const itemViewSizeSchema = z.object({
  width: z.number().int().min(320).max(2560),
  height: z.number().int().min(240).max(1600),
});
export const itemViewsSchema = z.record(z.string().min(1).max(240), itemViewSizeSchema).default({});
export type ItemViewSizes = z.infer<typeof itemViewsSchema>;
export interface ItemViewProfile { key: string; name: string; mode: 'inline' | 'card' | 'focus' | 'browser'; width: number; height: number; minWidth?: number }

/** Plugin metadata drives both Settings discovery and every opening path. */
export function itemViewProfiles(plugin: Pick<ResourcePluginDefinition, 'id' | 'name' | 'appearance' | 'activation' | 'view'>): ItemViewProfile[] {
  const large = plugin.appearance?.size === 'large';
  const base = { key: plugin.id, name: plugin.name,
    mode: plugin.activation?.kind === 'browser' ? 'browser' as const : plugin.view?.mode ?? 'focus',
    width: plugin.view?.width ?? (large ? 1280 : 880), height: plugin.view?.height ?? (large ? 800 : 600), ...(plugin.view?.minWidth ? { minWidth: plugin.view.minWidth } : {}) };
  const variants = plugin.view?.variants;
  return variants ? Object.entries(variants.options).map(([value, name]) => ({ ...base, key: `${plugin.id}:${value}`, name })) : [base];
}
export function itemViewProfile(plugin: Parameters<typeof itemViewProfiles>[0] | undefined, resource: ResourceRecord): ItemViewProfile {
  if (!plugin) return { key: resource.pluginId, name: resource.pluginId, mode: 'focus', width: 880, height: 600 };
  const profiles = itemViewProfiles(plugin), value = String(resource.data[plugin.view?.variants?.field ?? ''] ?? '').toLowerCase();
  return profiles.find(profile => profile.key === `${plugin.id}:${value}`) ?? profiles[0];
}

/** Screen-space projection only; never changes graph positions or footprints. */
export function expandedItemBounds(profile: ItemViewProfile, sizes: ItemViewSizes, canvas: { width: number; height: number }, anchor: { x: number; y: number }, left = 64) {
  const desired = sizes[profile.key] ?? profile;
  const availableWidth = Math.max(1, canvas.width - left - 40), availableHeight = Math.max(1, canvas.height - 128);
  const width = Math.min(Math.max(desired.width, profile.minWidth ?? 0), availableWidth, profile.mode === 'card' ? canvas.width * .75 : Infinity);
  const height = Math.min(desired.height, availableHeight, profile.mode === 'card' ? canvas.height * .75 : Infinity);
  const center = profile.mode === 'card' ? anchor : { x: left + availableWidth / 2, y: 72 + availableHeight / 2 };
  return { width, height,
    x: Math.max(left + width / 2, Math.min(canvas.width - 40 - width / 2, center.x)),
    y: Math.max(72 + height / 2, Math.min(canvas.height - 56 - height / 2, center.y)) };
}

/** Local view position only: keep the whole surface reachable after dragging or
 * a window/settings resize. This never participates in graph placement. */
export function clampItemViewPosition(position: { x: number; y: number }, view: { width: number; height: number }, canvas: { width: number; height: number }) {
  return { x: Math.max(12, Math.min(position.x, canvas.width - view.width - 12)),
    y: Math.max(12, Math.min(position.y, canvas.height - view.height - 12)) };
}

/** Resize a screen-space view from its fixed top-left. The preferred size is
 * retained by the caller, so shrinking a window doesn't erase a larger choice. */
export function clampItemViewSize(desired: { width: number; height: number }, profile: Pick<ItemViewProfile, 'mode' | 'minWidth'>,
  canvas: { width: number; height: number }, position = { x: 12, y: 12 }) {
  const card = profile.mode === 'card';
  const maxWidth = Math.max(1, Math.floor(Math.min(2560, canvas.width - position.x - 12, card ? canvas.width * .75 : Infinity)));
  const maxHeight = Math.max(1, Math.floor(Math.min(1600, canvas.height - position.y - 12, card ? canvas.height * .75 : Infinity)));
  return { width: Math.min(maxWidth, Math.max(profile.minWidth ?? (card ? 320 : 480), Math.round(desired.width))),
    height: Math.min(maxHeight, Math.max(card ? 240 : 280, Math.round(desired.height))) };
}
