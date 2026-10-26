import type { ItemMapSizes } from '../../packages/core/item-map-sizes.ts';
import { itemResizeLimits } from '../../packages/core/item-map-sizes.ts';
import type { GraphNode } from './graph.ts';
import { isDrawn } from './archive.ts';
import { itemFootprint, freePosition } from './footprints.ts';
import { overlaps, sweepBoxes } from './spatial.ts';
import type { MapCollisions, SpatialBox } from './spatial.ts';
import { snapPosition } from './snap.ts';
import type { ResourceRecord } from '../resource-plugins/types.ts';
import type { ResourcePluginRegistry } from '../resource-plugins/registry.ts';

export interface MoveIntent { id: string; position: GraphNode['position'] }
export const ITEM_GAP = 20;

/** The map preview and UI/MCP commit share limits and collision placement. */
export function resizeItem<T extends GraphNode>(nodes: readonly T[], resources: readonly ResourceRecord[], registry: ResourcePluginRegistry,
  intent: { id: string; dimensions: { width: number; height: number }; position?: GraphNode['position'] }, sizes: ItemMapSizes = {}, pitch?: number): T[] {
  const node = nodes.find(node => node.id === intent.id), resource = resources.find(resource => resource.id === node?.resourceId);
  if (!node || !resource) throw new Error('Only resource items have map sizes');
  const limits = itemResizeLimits(registry.get(resource.pluginId)), { width, height } = intent.dimensions;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < limits.minWidth || width > limits.maxWidth || height < limits.minHeight || height > limits.maxHeight)
    throw new Error(`Item size needs width ${limits.minWidth}–${limits.maxWidth} and height ${limits.minHeight}–${limits.maxHeight}`);
  const changed = nodes.map(item => item.id === node.id ? { ...item, mapDimensions: { width, height }, position: intent.position ?? item.position } : item);
  if (!isDrawn(node, nodes)) return changed;
  const before = itemFootprint(node, resources, registry, sizes);
  if (width > before.width || height > before.height || intent.position)
    return moveItems(changed, resources, registry, [{ id: node.id, position: intent.position ?? node.position }], sizes, pitch);
  return changed;
}

/** A populated project's anchor is a view projection, not an invisible obstacle. */
export function layoutFootprints(nodes: readonly GraphNode[], resources: readonly ResourceRecord[], registry: ResourcePluginRegistry, sizes: ItemMapSizes = {}) {
  const visible = nodes.filter(node => isDrawn(node, nodes));
  const populated = new Set(visible.map(node => node.projectId));
  return visible.filter(node => node.resourceId || !populated.has(node.id)).map(node => itemFootprint(node, resources, registry, sizes));
}

/** An explicit repair preserves every already-clear item, then separates only
 * the overlapping group. Never call this on startup, camera changes or refresh. */
export function repairLayout<T extends GraphNode>(nodes: readonly T[], resources: readonly ResourceRecord[], registry: ResourcePluginRegistry, sizes: ItemMapSizes = {}, pitch?: number): T[] {
  const boxes = layoutFootprints(nodes, resources, registry, sizes);
  const clear = boxes.filter(box => !boxes.some(other => other.id !== box.id && overlaps(box, other, ITEM_GAP)));
  return moveItems(nodes, resources, registry, clear.map(box => ({ id: box.id, position: { x: box.x, y: box.y } })), sizes, pitch);
}

/** Shared UI preview / command placement. Requested items stay fixed; other
 * footprints settle at clear edges. Project moves preserve all member offsets,
 * including archived members, and commit as one operation. No camera inputs.
 * With a grid pitch, the footprints that settle aside land on grid points. */
export function moveItems<T extends GraphNode>(nodes: readonly T[], resources: readonly ResourceRecord[], registry: ResourcePluginRegistry, intents: readonly MoveIntent[], sizes: ItemMapSizes = {}, pitch?: number, collisions: MapCollisions = 'shove'): T[] {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const positions = new Map<string, GraphNode['position']>();
  const explicit = new Set<string>();
  const translatedBy = new Map<string, string>();
  for (const intent of intents) {
    if (explicit.has(intent.id)) throw new Error('A node can be moved only once in a placement batch');
    if (!byId.has(intent.id)) throw new Error(`Node not found: ${intent.id}`);
    if (!Number.isFinite(intent.position.x) || !Number.isFinite(intent.position.y)) throw new Error('Position must be finite');
    explicit.add(intent.id); positions.set(intent.id, { ...intent.position });
  }
  for (const intent of intents) {
    const project = byId.get(intent.id)!;
    if (project.resourceId || project.projectId) continue;
    const dx = intent.position.x - project.position.x, dy = intent.position.y - project.position.y;
    for (const member of nodes.filter(node => node.projectId === project.id)) {
      const position = { x: member.position.x + dx, y: member.position.y + dy };
      const requested = positions.get(member.id);
      if (requested && (Math.abs(requested.x - position.x) > .001 || Math.abs(requested.y - position.y) > .001)) throw new Error('A project move must preserve its member offsets');
      positions.set(member.id, position); translatedBy.set(member.id, project.id);
    }
  }
  const moved = nodes.map(node => positions.has(node.id) ? { ...node, position: positions.get(node.id)! } : node);
  const footprints = layoutFootprints(moved, resources, registry, sizes);
  const pinned = footprints.filter(box => positions.has(box.id));
  const before = new Map(layoutFootprints(nodes, resources, registry, sizes).map(box => [box.id, box]));
  for (let i = 0; i < pinned.length; i++) for (let j = i + 1; j < pinned.length; j++) {
    const a = pinned[i], b = pinned[j];
    if (!overlaps(a, b, ITEM_GAP)) continue;
    // Translating an older layout must not tear a group apart to repair an
    // existing internal overlap. Moving either member separately repairs it.
    const oldA = before.get(a.id), oldB = before.get(b.id);
    const sameTranslation = oldA && oldB && Math.abs((a.x - oldA.x) - (b.x - oldB.x)) < .001 && Math.abs((a.y - oldA.y) - (b.y - oldB.y)) < .001;
    if (oldA && oldB && (sameTranslation || translatedBy.has(a.id) && translatedBy.get(a.id) === translatedBy.get(b.id))
      && overlaps(oldA, oldB, ITEM_GAP)) continue;
    throw new Error('Requested item positions overlap; leave space between moved items');
  }
  if (collisions === 'solid') stopAtObstacles(footprints, before, positions, pitch);
  // Reserve non-colliding neighbors first so only the obstruction (or an existing
  // overlapping footprint) needs displacement. Stable order is independent of UI order.
  const held = footprints.filter(box => positions.has(box.id)).map(box => ({ ...box, ...positions.get(box.id)! }));
  const stationary = footprints.filter(box => !positions.has(box.id)).sort((a, b) =>
    Number(held.some(box => overlaps(a, box, ITEM_GAP))) - Number(held.some(box => overlaps(b, box, ITEM_GAP))) || a.id.localeCompare(b.id));
  const placed = [...held];
  for (const box of stationary) {
    const position = freePosition(box, placed, ITEM_GAP, pitch);
    if (position.x !== box.x || position.y !== box.y) positions.set(box.id, position);
    placed.push({ ...box, ...position });
  }
  return nodes.map(node => positions.has(node.id) ? { ...node, position: positions.get(node.id)! } : node);
}

/** A requested spot that is clear is taken as it is. Otherwise the moved footprints travel from where they were until
 * they touch another, sliding along it; footprints moved by different amounts travel separately. With a grid pitch
 * the stop moves back to a clear grid point when there is one. */
function stopAtObstacles(footprints: readonly SpatialBox[], before: ReadonlyMap<string, SpatialBox>, positions: Map<string, GraphNode['position']>, pitch?: number) {
  const obstacles = footprints.filter(box => !positions.has(box.id)), moved = footprints.filter(box => positions.has(box.id) && before.has(box.id));
  if (!moved.some(box => obstacles.some(other => overlaps(box, other, ITEM_GAP)))) return;
  const groups = new Map<string, SpatialBox[]>();
  for (const box of moved) {
    const start = before.get(box.id)!, key = `${box.x - start.x},${box.y - start.y}`;
    groups.set(key, [...groups.get(key) ?? [], start]);
  }
  for (const [key, starts] of groups) {
    const [dx, dy] = key.split(',').map(Number), clear = (offset: { x: number; y: number }) =>
      starts.every(box => !obstacles.some(other => overlaps({ ...box, x: box.x + offset.x, y: box.y + offset.y }, other, ITEM_GAP)));
    let offset = sweepBoxes(starts, { x: dx, y: dy }, obstacles, ITEM_GAP);
    if (pitch) {
      const lead = starts[0], snapped = snapPosition({ x: lead.x + offset.x, y: lead.y + offset.y }, pitch);
      const back = { x: (dx > 0 ? Math.floor : Math.ceil)((lead.x + offset.x) / pitch) * pitch, y: (dy > 0 ? Math.floor : Math.ceil)((lead.y + offset.y) / pitch) * pitch };
      offset = [snapped, back].map(point => ({ x: point.x - lead.x, y: point.y - lead.y })).find(clear) ?? offset;
    }
    const correction = { x: offset.x - dx, y: offset.y - dy };
    const ids = groups.size === 1 ? [...positions.keys()] : starts.map(box => box.id);
    for (const id of ids) { const position = positions.get(id)!; positions.set(id, { x: position.x + correction.x, y: position.y + correction.y }); }
  }
}
