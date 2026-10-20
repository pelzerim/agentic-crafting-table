import type { GraphNode } from './graph.ts';
import type { SpatialBox } from './spatial.ts';
import { overlaps } from './spatial.ts';
import { isDrawn } from './archive.ts';
import { ITEM_GAP } from './movement.ts';
import { NEIGHBORHOOD_PADDING } from './project-neighborhoods.ts';
import { boundsOf, field } from './undermap.ts';

type Point = GraphNode['position'];
const SEARCH_STEP = ITEM_GAP * 2;

/** Map positions for items sent to a project as one block: the lead first, then
 * the items that travel with it. Members that already sat in the lead's project
 * keep their layout around it; the rest stack in a column below. `kept` names the
 * members that keep their layout instead, wherever they came from. The block goes
 * to the first clear spot beside the project's items (right, below, left, then
 * above, stepping outward) or onto an empty project's anchor. Nothing else moves,
 * and the block never lands inside another project's neighbourhood. */
export function arrivalPlacement(nodes: readonly GraphNode[], lead: string, members: readonly string[], projectId: string, footprint: (node: GraphNode) => SpatialBox,
  options: { stacked?: ReadonlySet<string>; kept?: ReadonlySet<string>; padding?: number } = {}): Map<string, Point> {
  const padding = options.padding ?? NEIGHBORHOOD_PADDING, byId = new Map(nodes.map(node => [node.id, node]));
  const first = byId.get(lead), target = byId.get(projectId);
  if (!first || !target) throw new Error('Node does not exist');
  const moving = [first, ...members.filter(id => id !== lead).flatMap(id => byId.get(id) ?? [])], ids = new Set(moving.map(node => node.id));
  const keeps = (node: GraphNode) => node.id === lead || (options.kept ? options.kept.has(node.id) : !options.stacked?.has(lead) && !options.stacked?.has(node.id) && node.projectId === first.projectId);
  const block: SpatialBox[] = moving.filter(keeps).map(footprint);
  for (const node of moving.filter(node => !keeps(node))) {
    const box = footprint(node), bounds = boundsOf(block);
    block.push({ ...box, x: block[0].x, y: bounds.bottom + ITEM_GAP + box.height / 2 });
  }
  const visible = nodes.filter(node => !ids.has(node.id) && isDrawn(node, nodes));
  const items = visible.filter(node => node.resourceId), owned = (id: string) => items.filter(node => node.projectId === id).map(footprint);
  const cluster = owned(projectId);
  const anchors = visible.filter(node => !node.resourceId && node.id !== projectId && !owned(node.id).length).map(footprint);
  const fields = visible.filter(node => !node.resourceId && node.id !== projectId && owned(node.id).length).map(node => field(node.id, boundsOf(owned(node.id)), padding));
  const obstacles = [...items.map(footprint), ...anchors];
  const clear = (dx: number, dy: number) => block.every(part => {
    const moved = { ...part, x: part.x + dx, y: part.y + dy };
    return !obstacles.some(other => overlaps(moved, other, ITEM_GAP)) && !fields.some(other => overlaps(moved, other, 0));
  });
  const b = boundsOf(block), home = { x: target.position.x - block[0].x, y: target.position.y - block[0].y };
  const c = cluster.length ? boundsOf(cluster) : { left: b.left + home.x, right: b.right + home.x, top: b.top + home.y, bottom: b.bottom + home.y };
  // The right-hand candidate always clears once it passes the outermost obstacle.
  const beside = () => { for (let k = 0; ; k++) {
    const out = k * SEARCH_STEP, found = [
      { x: c.right + ITEM_GAP - b.left + out, y: c.top - b.top },
      { x: c.left - b.left, y: c.bottom + ITEM_GAP - b.top + out },
      { x: c.left - ITEM_GAP - b.right - out, y: c.top - b.top },
      { x: c.left - b.left, y: c.top - ITEM_GAP - b.bottom - out },
    ].find(candidate => clear(candidate.x, candidate.y));
    if (found) return found;
  } };
  const offset = !cluster.length && clear(home.x, home.y) ? home : beside();
  return new Map(block.map(part => [part.id, { x: part.x + offset.x, y: part.y + offset.y }]));
}
