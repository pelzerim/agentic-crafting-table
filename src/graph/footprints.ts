import { resolveMapSize } from '../../packages/core/item-map-sizes.ts';
import type { ItemMapSizes } from '../../packages/core/item-map-sizes.ts';
import type { GraphNode } from './graph.ts';
import type { SpatialBox } from './spatial.ts';
import { overlaps } from './spatial.ts';
import { snapPosition } from './snap.ts';
import type { ResourceRecord } from '../resource-plugins/types.ts';
import type { ResourcePluginRegistry } from '../resource-plugins/registry.ts';

export const LARGE_ITEM_WIDTH = 240;
/** Shared detailed geometry: zoom and provider status never change saved layout. */
export function itemFootprint(node: GraphNode, resources: readonly ResourceRecord[], registry: ResourcePluginRegistry, sizes: ItemMapSizes = {}): SpatialBox {
  const record = resources.find(resource => resource.id === node.resourceId);
  const { width, height } = record ? resolveMapSize(node, record, registry.get(record.pluginId), sizes) : { width: node.resourceId ? 150 : LARGE_ITEM_WIDTH, height: node.resourceId ? 48 : 112 };
  return { id: node.id, x: node.position.x, y: node.position.y, width, height };
}

/** Prefer the requested spot; otherwise choose the nearest clear edge deterministically.
 * With a grid pitch the edge moves outward to the next grid point, so it stays clear and on the grid. */
export function freePosition(box: SpatialBox, obstacles: readonly SpatialBox[], gap = 20, pitch?: number) {
  if (!obstacles.some(other => overlaps(box, other, gap))) return { x: box.x, y: box.y };
  const outward = (value: number, direction: 1 | -1) => pitch ? (direction > 0 ? Math.ceil(value / pitch) : Math.floor(value / pitch)) * pitch : value;
  const aligned = snapPosition(box, pitch);
  const candidates = obstacles.flatMap(other => [
    { ...box, x: outward(other.x - (other.width + box.width) / 2 - gap, -1), y: aligned.y },
    { ...box, x: outward(other.x + (other.width + box.width) / 2 + gap, 1), y: aligned.y },
    { ...box, x: aligned.x, y: outward(other.y - (other.height + box.height) / 2 - gap, -1) },
    { ...box, x: aligned.x, y: outward(other.y + (other.height + box.height) / 2 + gap, 1) },
  ]).filter(candidate => !obstacles.some(other => overlaps(candidate, other, gap)));
  if (!candidates.length && pitch) return freePosition(box, obstacles, gap);
  candidates.sort((a, b) => Math.hypot(a.x - box.x, a.y - box.y) - Math.hypot(b.x - box.x, b.y - box.y) || a.y - b.y || a.x - b.x);
  return { x: candidates[0].x, y: candidates[0].y };
}
