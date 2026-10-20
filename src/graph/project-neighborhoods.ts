import type { GraphNode } from './graph.ts';
import type { SpatialBox } from './spatial.ts';
import { LARGE_ITEM_WIDTH } from './footprints.ts';
import { neighborhoodContours, outlineDistance } from './neighborhood.ts';
import type { Point } from './neighborhood.ts';
import { attentionCounts, attentionItems } from './attention.ts';

export const NEIGHBORHOOD_PADDING = LARGE_ITEM_WIDTH;
export type ProjectMember = GraphNode & { activity?: string; attention?: string };
export type NeighborhoodBox = SpatialBox & { item: ProjectMember };

export type ProjectNeighborhood = { id: string; points: Point[]; top: number; left: number; right: number; bottom: number; center: Point };
/** Per project: the member geometry a neighborhood was derived from, those footprints, and the result. */
export type NeighborhoodCache = Map<string, { key: string; neighborhood: ProjectNeighborhood; footprints: readonly Footprint[] }>;
/** A member's centre-anchored world rectangle. */
export interface Footprint { x: number; y: number; width: number; height: number }

/** Derive world-space geometry from visible member footprints in every view.
 * A project's saved anchor supplies a fallback only while it has no members.
 * With a cache, a project whose members did not move keeps its exact result. */
export function projectNeighborhoods(boxes: readonly NeighborhoodBox[], padding = NEIGHBORHOOD_PADDING, cache?: NeighborhoodCache): ProjectNeighborhood[] {
  const groups = new Map<string, NeighborhoodBox[]>();
  for (const box of boxes) {
    const id = box.item.projectId;
    if (id) { const group = groups.get(id) ?? []; group.push(box); groups.set(id, group); }
  }
  const projects = boxes.filter(box => !box.item.resourceId && !box.item.projectId);
  if (cache) { const ids = new Set(projects.map(project => project.id)); for (const id of cache.keys()) if (!ids.has(id)) cache.delete(id); }
  return projects.map(project => {
    const members = groups.get(project.id) ?? [project];
    const key = cache && `${padding}|${members.map(box => `${box.x},${box.y},${box.width},${box.height}`).join(';')}`;
    const cached = cache?.get(project.id);
    if (cached && cached.key === key) return cached.neighborhood;
    const neighborhood = projectNeighborhood(project.id, members, padding);
    if (cache) cache.set(project.id, { key: key!, neighborhood, footprints: members.map(({ x, y, width, height }) => ({ x, y, width, height })) });
    return neighborhood;
  });
}

function projectNeighborhood(id: string, members: readonly SpatialBox[], padding: number): ProjectNeighborhood {
  const points = neighborhoodContours(members, padding, 24)[0];
  const top = Math.min(...points.map(point => point.y));
  const left = Math.min(...points.map(point => point.x)), right = Math.max(...points.map(point => point.x)), bottom = Math.max(...points.map(point => point.y));
  // The contour snaps to the world grid; the center follows the members themselves.
  const center = {
    x: (Math.min(...members.map(box => box.x - box.width / 2)) + Math.max(...members.map(box => box.x + box.width / 2))) / 2,
    y: (Math.min(...members.map(box => box.y - box.height / 2)) + Math.max(...members.map(box => box.y + box.height / 2))) / 2,
  };
  return { id, points, top, left, right, bottom, center };
}

/** Neighborhood and overview titles share the same centered, outside placement.
 * React Flow expects a center position; the overview button uses a top-left. */
export function neighborhoodTitlePosition(project: ReturnType<typeof projectNeighborhoods>[number],
  camera: { x: number; y: number; zoom: number }, canvas: { width: number; height: number }, width = 300, height = 48) {
  const point = overviewTitlePosition(project, camera, canvas, width, height);
  return { x: point.x + width / (2 * camera.zoom), y: point.y + height / (2 * camera.zoom) };
}

/** Overview titles sit centered above the drawn field, but remain reachable at the viewport
 * edge if the enclosure's top is offscreen. Only the label projection is clamped. */
export function overviewTitlePosition(project: ReturnType<typeof projectNeighborhoods>[number],
  camera: { x: number; y: number; zoom: number }, canvas: { width: number; height: number }, width = 300, height = 28) {
  const { zoom } = camera;
  let x = (project.left + project.right) / 2 * zoom + camera.x - width / 2, y = project.top * zoom + camera.y - height - 12;
  const visible = project.right * zoom + camera.x > 0 && project.left * zoom + camera.x < canvas.width
    && project.bottom * zoom + camera.y > 0 && project.top * zoom + camera.y < canvas.height;
  if (visible) {
    x = Math.max(20, Math.min(x, canvas.width - width - 20));
    y = Math.max(20, Math.min(y, canvas.height - height - 20));
  }
  return { x: (x - camera.x) / zoom, y: (y - camera.y) / zoom };
}

/** Aliases count once. Archived members never contribute to project attention. A muted project counts nothing. */
/** `needsMe` is the counted number (Asking me + My turn); Finished is its own count. */
export function projectActivity(projectId: string, nodes: readonly ProjectMember[]): { working: number; needsMe: number; asking: number; turn: number; finished: number; muted?: true } {
  const working = new Set<string>(), project = nodes.find(node => node.id === projectId);
  const none = { working: 0, needsMe: 0, asking: 0, turn: 0, finished: 0 };
  if (project?.archivedAt) return none;
  // A muted project's plate says so instead of counting (MAP-25).
  if (project?.mutedAt) return { ...none, muted: true };
  for (const node of nodes) {
    if (node.projectId !== projectId || node.archivedAt || node.hiddenAt) continue;
    const identity = node.resourceId ?? node.id;
    if (node.activity === 'working') working.add(identity);
  }
  const { asking, turn, finished, needsMe } = attentionCounts(attentionItems(nodes, projectId));
  return { working: working.size, needsMe, asking, turn, finished };
}

/** Large margins can intersect. Pick the nearest project center deterministically. */
export function containingProject(point: { x: number; y: number }, projects: ReturnType<typeof projectNeighborhoods>) {
  return projects.filter(project => outlineDistance(point, project.points) === 0)
    .sort((a, b) => Math.hypot(point.x - a.center.x, point.y - a.center.y) - Math.hypot(point.x - b.center.x, point.y - b.center.y) || a.id.localeCompare(b.id))[0]?.id;
}

/** Floating drops can reach a nearby outline. */
export function attachmentProject(point: { x: number; y: number }, projects: ReturnType<typeof projectNeighborhoods>, reach = 48) {
  return projects.map(project => ({ project, distance: outlineDistance(point, project.points) }))
    .filter(candidate => candidate.distance <= reach)
    .sort((a, b) => a.distance - b.distance || Math.hypot(point.x - a.project.center.x, point.y - a.project.center.y) - Math.hypot(point.x - b.project.center.x, point.y - b.project.center.y) || a.project.id.localeCompare(b.project.id))[0]?.project.id;
}

/** Use the neighborhoods captured before the drag, not the source enclosure
 * following its held member. Owned items transfer only inside another project;
 * empty-space and group moves preserve their membership. */
export function itemDropProject(item: GraphNode, point: { x: number; y: number }, projects: ReturnType<typeof projectNeighborhoods>) {
  if (!item.resourceId) return undefined;
  const target = item.projectId ? containingProject(point, projects) : attachmentProject(point, projects);
  return target === item.projectId ? undefined : target;
}
