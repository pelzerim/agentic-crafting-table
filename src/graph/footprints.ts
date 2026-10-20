import { resolveMapSize } from '../../packages/core/item-map-sizes.ts';
import type { ItemMapSizes } from '../../packages/core/item-map-sizes.ts';
import type { GraphNode } from './graph.ts';
import type { SpatialBox } from './spatial.ts';
import { overlaps } from './spatial.ts';
import type { ResourceRecord } from '../resource-plugins/types.ts';
import type { ResourcePluginRegistry } from '../resource-plugins/registry.ts';

export const LARGE_ITEM_WIDTH = 240;
/** Shared detailed geometry: zoom and provider status never change saved layout. */
export function itemFootprint(node: GraphNode, resources: readonly ResourceRecord[], registry: ResourcePluginRegistry, sizes: ItemMapSizes = {}): SpatialBox {
  const record = resources.find(resource => resource.id === node.resourceId);
  const { width, height } = record ? resolveMapSize(node, record, registry.get(record.pluginId), sizes) : { width: node.resourceId ? 150 : LARGE_ITEM_WIDTH, height: node.resourceId ? 48 : 112 };
  return { id: node.id, x: node.position.x, y: node.position.y, width, height };
}

/** Prefer the requested spot; otherwise choose the nearest clear edge deterministically. */
export function freePosition(box: SpatialBox, obstacles: readonly SpatialBox[], gap = 20) {
  if (!obstacles.some(other => overlaps(box, other, gap))) return { x: box.x, y: box.y };
  const candidates = obstacles.flatMap(other => [
    { ...box, x: other.x - (other.width + box.width) / 2 - gap },
    { ...box, x: other.x + (other.width + box.width) / 2 + gap },
    { ...box, y: other.y - (other.height + box.height) / 2 - gap },
    { ...box, y: other.y + (other.height + box.height) / 2 + gap },
  ]).filter(candidate => !obstacles.some(other => overlaps(candidate, other, gap)));
  candidates.sort((a, b) => Math.hypot(a.x - box.x, a.y - box.y) - Math.hypot(b.x - box.x, b.y - box.y) || a.y - b.y || a.x - b.x);
  return { x: candidates[0].x, y: candidates[0].y };
}
