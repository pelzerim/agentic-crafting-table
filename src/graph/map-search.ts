import type { GraphNode } from './graph.ts';
import { isOffMap } from './archive.ts';

export interface MapMatch { id: string; title: string; project: string | undefined }

export const RECENT_ITEMS = 20;

/** Items on the map (not projects, not below, archived or hidden), with their project's title. */
function itemsOnMap(nodes: readonly GraphNode[]): MapMatch[] {
  const projects = new Map(nodes.filter(node => !node.resourceId).map(node => [node.id, node.title]));
  return nodes
    .filter(node => node.resourceId && !node.hiddenAt && !isOffMap(node, nodes))
    .map(node => ({ id: node.id, title: node.title, project: node.projectId ? projects.get(node.projectId) : undefined }));
}

/** Items on the map whose title and project title hold every word of the query. Titles that start
 * with the query lead; the rest keep the map's order. */
export function searchMap(nodes: readonly GraphNode[], query: string, limit = 8): MapMatch[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const start = words.join(' ');
  return itemsOnMap(nodes)
    .filter(match => { const text = `${match.title} ${match.project ?? ''}`.toLowerCase(); return words.every(word => text.includes(word)); })
    .map((match, order) => ({ match, order, leads: match.title.toLowerCase().startsWith(start) }))
    .sort((a, b) => Number(b.leads) - Number(a.leads) || a.order - b.order)
    .slice(0, limit).map(({ match }) => match);
}

/** The recently opened items that are still on the map, most recent first. */
export function recentOnMap(nodes: readonly GraphNode[], recent: readonly string[], limit = 8): MapMatch[] {
  const onMap = new Map(itemsOnMap(nodes).map(match => [match.id, match]));
  return recent.flatMap(id => onMap.get(id) ?? []).slice(0, limit);
}

/** The recent list after opening `id`: it leads, once, and the list keeps the newest {@link RECENT_ITEMS}. */
export const rememberOpened = (recent: readonly string[] | undefined, id: string) => [id, ...(recent ?? []).filter(other => other !== id)].slice(0, RECENT_ITEMS);
