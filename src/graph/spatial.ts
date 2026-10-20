import type { GraphNode } from './graph.ts';

export const ZOOM_LEVELS = { min: .2, neighborhood: .65, close: 1.15, max: 1.35 } as const;
export type ZoomLevel = 'overview' | 'neighborhood' | 'close';
export interface ZoomDashboards { enabled: boolean; belowZoom: number }

/** Lowest zoom of the neighborhood tier. Enabled dashboards take over below their threshold, so
 * items keep neighborhood cards all the way down to it instead of an icon-only band. */
export function neighborhoodZoom(dashboards?: ZoomDashboards): number {
  return dashboards?.enabled ? Math.min(dashboards.belowZoom, ZOOM_LEVELS.neighborhood) : ZOOM_LEVELS.neighborhood;
}
export function zoomLevel(scale: number, dashboards?: ZoomDashboards): ZoomLevel {
  return scale < neighborhoodZoom(dashboards) ? 'overview' : scale < ZOOM_LEVELS.close ? 'neighborhood' : 'close';
}
/** 0 (icon) → 1 (full card) map detail; the ramp moves with the neighborhood threshold. */
export function zoomDetail(scale: number, dashboards?: ZoomDashboards): number {
  const shift = neighborhoodZoom(dashboards) - ZOOM_LEVELS.neighborhood;
  return Math.max(0, Math.min(1, (scale - .45 - shift) / .3));
}

/** Below this size on screen a far-zoom icon cannot carry a corner mark (STATE-02 takeover rule). */
export const TAKEOVER_ICON_PX = 16;
/** Whether an icon `size` world px wide is under the takeover size at `zoom`: its Needs me tier
 * shape then replaces the type icon, and card frames are dropped. From 16px up the shape sits in the corner. */
export const attentionTakesOver = (size: number, zoom: number) => size * zoom < TAKEOVER_ICON_PX;

export interface SpatialBox { id: string; x: number; y: number; width: number; height: number }
export function overlaps(a: SpatialBox, b: SpatialBox, gap = 16): boolean {
  return Math.abs(a.x - b.x) < (a.width + b.width) / 2 + gap - .001 &&
    Math.abs(a.y - b.y) < (a.height + b.height) / 2 + gap - .001;
}

/** Keep the held item fixed. Place other items at the nearest free edge, without changing sizes. */
export function separateItems(items: readonly SpatialBox[], heldId?: string, gap = 16): SpatialBox[] {
  const placed: SpatialBox[] = [];
  const ordered = [...items].sort((a, b) => Number(b.id === heldId) - Number(a.id === heldId) || a.id.localeCompare(b.id));
  for (const original of ordered) {
    let box = { ...original };
    if (placed.some(other => overlaps(box, other, gap))) {
      const candidates = placed.flatMap(other => [
        { ...box, x: other.x - (other.width + box.width) / 2 - gap },
        { ...box, x: other.x + (other.width + box.width) / 2 + gap },
        { ...box, y: other.y - (other.height + box.height) / 2 - gap },
        { ...box, y: other.y + (other.height + box.height) / 2 + gap },
      ]).filter(candidate => !placed.some(other => overlaps(candidate, other, gap)));
      candidates.sort((a, b) => Math.hypot(a.x - original.x, a.y - original.y) - Math.hypot(b.x - original.x, b.y - original.y));
      // At least the candidate beyond the outermost edge is always free.
      box = candidates[0];
    }
    placed.push(box);
  }
  const byId = new Map(placed.map(box => [box.id, box]));
  return items.map(box => byId.get(box.id)!);
}

/** Geometry is in screen coordinates, keeping the attachment halo consistent at any zoom. */
export function nearbyProject(point: { x: number; y: number }, projects: readonly SpatialBox[], halo = 36): string | undefined {
  return projects.map(project => ({ id: project.id, distance: Math.hypot(
    Math.max(0, Math.abs(point.x - project.x) - project.width / 2),
    Math.max(0, Math.abs(point.y - project.y) - project.height / 2),
  ) })).filter(candidate => candidate.distance <= halo)
    .sort((a, b) => a.distance - b.distance || a.id.localeCompare(b.id))[0]?.id;
}

/** Attaching a floating item never relocates it or changes its relationships/session identity. */
export function attachFloatingItem(nodes: readonly GraphNode[], itemId: string, projectId: string): GraphNode[] {
  const item = nodes.find(node => node.id === itemId), project = nodes.find(node => node.id === projectId);
  if (!item || !project || item.id === project.id || project.projectId || project.resourceId || project.archivedAt) throw new Error('Invalid attachment');
  if (item.projectId) throw new Error('Item already belongs to a project');
  return nodes.map(node => node.id === itemId ? { ...node, projectId } : node);
}
