import type { ItemMapSizes } from '../../packages/core/item-map-sizes.ts';
import type { MapCollisions } from './spatial.ts';

/** Distance between the points an item centre snaps to when the map grid is on (MAP-30). */
export const SNAP_PITCH = 48;

/** What the shared placement rules read from settings: item sizes, when snapping is on the grid pitch,
 * and whether moved items push others aside (the default) or stop at them. */
export interface MapLayout { sizes: ItemMapSizes; snap?: number; collisions?: MapCollisions }

/** The nearest grid point to a centre; no pitch keeps the centre as it is. */
export function snapPosition(position: { x: number; y: number }, pitch: number | undefined) {
  if (!pitch) return position;
  return { x: Math.round(position.x / pitch) * pitch, y: Math.round(position.y / pitch) * pitch };
}

/** An arrow key moves by whole grid cells when snapping, so the item never leaves the grid. */
export function snapStep(step: number, pitch: number | undefined) {
  return pitch ? Math.max(pitch, Math.round(step / pitch) * pitch) : step;
}
