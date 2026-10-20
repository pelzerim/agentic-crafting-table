import type { GraphNode } from './graph.ts';
import type { SpatialBox } from './spatial.ts';
import { overlaps } from './spatial.ts';
import { isDrawn, isOffMap } from './archive.ts';
import { freePosition } from './footprints.ts';
import { ITEM_GAP } from './movement.ts';
import { NEIGHBORHOOD_PADDING } from './project-neighborhoods.ts';
import { boundsOf, field } from './undermap.ts';

type Point = GraphNode['position'];
type Footprint = (node: GraphNode) => SpatialBox;
export interface Size { width: number; height: number }
/** How far from its context a requested position may be and still be kept. One neighborhood padding:
 * a spot that close to a project's members is drawn inside that project's neighborhood. */
export const CONTEXT_REACH = NEIGHBORHOOD_PADDING;

/** The nodes a new item may be placed beside, first match wins: what it links to, in order, then the agent that asked for it. */
export function creationAnchors(linked: readonly string[], agentId?: string): string[] {
  return [...new Set([...linked, ...(agentId ? [agentId] : [])])];
}

export interface CreationContext { anchor?: GraphNode; projectId?: string }
/** Where a new item belongs (MAP-14): the first anchor that is an item on the map, and the project it joins. A named
 * project wins and only its own items anchor; otherwise the item joins its anchor's project. Archived items, items
 * in Undermap and members of such a project never anchor. */
export function creationContext(nodes: readonly GraphNode[], anchors: readonly string[], projectId?: string): CreationContext {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const anchor = anchors.flatMap(id => byId.get(id) ?? []).find(node => node.resourceId && !isOffMap(node, nodes) && (!projectId || node.projectId === projectId));
  const joined = projectId ?? (anchor?.projectId && byId.has(anchor.projectId) ? anchor.projectId : undefined);
  return { ...(anchor ? { anchor } : {}), ...(joined ? { projectId: joined } : {}) };
}

/** Whether the map can place this creation without being given a position. */
export function hasContext(nodes: readonly GraphNode[], context: CreationContext): boolean {
  return context.projectId ? nodes.some(node => node.id === context.projectId && !node.resourceId && !node.projectId && !isOffMap(node, nodes)) : Boolean(context.anchor);
}

const box = (center: Point, size: Size): SpatialBox => ({ id: '', x: center.x, y: center.y, width: size.width, height: size.height });
const grown = (target: SpatialBox, by: number): SpatialBox => ({ ...target, width: target.width + by * 2, height: target.height + by * 2 });
/** Each project on the map with its members' footprints, or its own while it has none. */
function projectAreas(visible: readonly GraphNode[], footprint: Footprint) {
  return visible.filter(node => !node.resourceId && !node.projectId).map(project => {
    const members = visible.filter(node => node.resourceId && node.projectId === project.id).map(footprint);
    return { project, members, bounds: boundsOf(members.length ? members : [footprint(project)]) };
  });
}
/** The first clear slot from `start`, stepping past whatever blocks it along one axis, up to `limit`. */
function walk(start: SpatialBox, obstacles: readonly SpatialBox[], gap: number, axis: 'x' | 'y', limit: number): Point | undefined {
  const extent = axis === 'x' ? 'width' : 'height';
  for (let slot = start; ;) {
    const blockers = obstacles.filter(other => overlaps(slot, other, gap));
    if (!blockers.length) return { x: slot.x, y: slot.y };
    slot = { ...slot, [axis]: Math.max(...blockers.map(other => other[axis] + other[extent] / 2)) + gap + slot[extent] / 2 };
    if (slot[axis] - slot[extent] / 2 > limit) return undefined;
  }
}
/** Beside an anchor: the right-hand column from its row downward, then the row below it rightward, then the nearest
 * clear spot. Slots are filled in order, so items created one after another form a column instead of a pile. */
function beside(size: Size, anchor: SpatialBox, obstacles: readonly SpatialBox[], gap: number): Point {
  const { left, right, top, bottom } = boundsOf([anchor]);
  const column = box({ x: right + gap + size.width / 2, y: top + size.height / 2 }, size), row = box({ x: left + size.width / 2, y: bottom + gap + size.height / 2 }, size);
  return walk(column, obstacles, gap, 'y', bottom + CONTEXT_REACH) ?? walk(row, obstacles, gap, 'x', right + CONTEXT_REACH) ?? freePosition(column, obstacles, gap);
}

/** The map position of an item an agent creates (MAP-14), or undefined when nothing places it and no position was
 * given. A position within reach of the destination project, or of the anchor of a floating item, is kept as
 * given. Otherwise the item goes beside its anchor, or among the project's members at the nearest clear spot to
 * their centre. Nothing else moves, and the spot is never inside another project's neighborhood. */
export function itemPlacement(nodes: readonly GraphNode[], footprint: Footprint, context: CreationContext, size: Size, position?: Point, padding = NEIGHBORHOOD_PADDING): Point | undefined {
  const visible = nodes.filter(node => isDrawn(node, nodes)), areas = projectAreas(visible, footprint);
  const destination = areas.find(area => area.project.id === context.projectId), anchor = context.anchor && footprint(context.anchor);
  if (context.projectId ? !destination : !anchor) return position;
  if (position && (destination ? overlaps(box(position, size), field('', destination.bounds, CONTEXT_REACH), 0) : overlaps(box(position, size), anchor!, CONTEXT_REACH))) return position;
  const members = destination?.members ?? [];
  const centre = members.length ? { x: members.reduce((sum, member) => sum + member.x, 0) / members.length, y: members.reduce((sum, member) => sum + member.y, 0) / members.length } : destination?.project.position;
  const from = anchor ?? box(centre!, size);
  const fields = areas.filter(area => area !== destination && area.members.length).map(area => grown(field(area.project.id, area.bounds, padding), -ITEM_GAP)).filter(other => !overlaps(from, other, ITEM_GAP));
  const obstacles = [...visible.filter(node => node.resourceId).map(footprint), ...areas.filter(area => area !== destination && !area.members.length).map(area => footprint(area.project)), ...fields];
  return anchor ? beside(size, anchor, obstacles, ITEM_GAP) : freePosition(from, obstacles, ITEM_GAP);
}

/** The map position of a project an agent creates (MAP-14): beside the caller's project (or the caller, when it
 * floats), with its own neighborhood clear of every other one and of floating items. A position whose
 * neighborhood is within reach of the caller's is kept; with no caller on the map the position is used as given. */
export function projectPlacement(nodes: readonly GraphNode[], footprint: Footprint, anchors: readonly string[], size: Size, position?: Point, padding = NEIGHBORHOOD_PADDING): Point | undefined {
  const visible = nodes.filter(node => isDrawn(node, nodes)), areas = projectAreas(visible, footprint);
  const caller = anchors.flatMap(id => visible.find(node => node.id === id) ?? [])[0];
  if (!caller) return position;
  const own = areas.find(area => area.project.id === (caller.projectId ?? caller.id));
  const home = own ? field(own.project.id, own.bounds, padding) : grown(footprint(caller), ITEM_GAP), reserved = { width: size.width + padding * 2, height: size.height + padding * 2 };
  if (position && overlaps(box(position, reserved), home, CONTEXT_REACH)) return position;
  const obstacles = [...areas.map(area => field(area.project.id, area.bounds, padding)), ...visible.filter(node => node.resourceId && !node.projectId).map(node => grown(footprint(node), ITEM_GAP))];
  return beside(reserved, home, obstacles, 0);
}
