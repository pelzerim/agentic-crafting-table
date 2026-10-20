import type { GraphLink, GraphNode } from './graph.ts';

/** Project archiving hides descendants without overwriting their own archive state. */
export function isArchived(node: GraphNode, nodes: readonly GraphNode[]): boolean {
  return Boolean(node.archivedAt || nodes.find(parent => parent.id === node.projectId)?.archivedAt);
}

/** Below the map, directly or through its project, and not archived. */
export function isBelow(node: GraphNode, nodes: readonly GraphNode[]): boolean {
  return !isArchived(node, nodes) && Boolean(node.belowAt || nodes.find(parent => parent.id === node.projectId)?.belowAt);
}
/** Not on the map: archived or below it. Background work pauses for these. */
export function isOffMap(node: GraphNode, nodes: readonly GraphNode[]): boolean {
  return isArchived(node, nodes) || isBelow(node, nodes);
}
/** Hidden by the host (`hiddenAt`): live and reachable, but not drawn on the map. */
export const isHidden = (node: Pick<GraphNode, 'hiddenAt'>) => Boolean(node.hiddenAt);
/** Drawn on the map: not archived, below or hidden. Layout, obstacles and Needs me follow this. */
export function isDrawn(node: GraphNode, nodes: readonly GraphNode[]): boolean {
  return !isHidden(node) && !isOffMap(node, nodes);
}
/** The hidden item an item's menu offers to show: the most recently hidden labelled item linked to it directly, archived or not. */
export function hiddenPartner<T extends GraphNode>(nodes: readonly T[], links: readonly GraphLink[], id: string): T | undefined {
  const partners = new Set(links.flatMap(link => link.sourceId === id ? [link.targetId] : link.targetId === id ? [link.sourceId] : []));
  return nodes.filter(node => partners.has(node.id) && node.hiddenAt && node.hideLabel && !nodes.find(parent => parent.id === node.projectId)?.archivedAt)
    .sort((a, b) => b.hiddenAt!.localeCompare(a.hiddenAt!))[0];
}
/** Why a node below cannot return to the map, if it cannot. */
export function surfaceBlocker(node: GraphNode, nodes: readonly GraphNode[]): string | undefined {
  if (isArchived(node, nodes)) return 'Restore it from the archive first';
  if (node.lostProject) return `Its project “${node.lostProject}” was deleted, so it cannot return to the map`;
  const project = node.projectId ? nodes.find(parent => parent.id === node.projectId) : undefined;
  if (node.projectId && !project) return 'Its project no longer exists, so it cannot return to the map';
  if (project?.belowAt) return `Bring its project “${project.title}” back first`;
  if (!node.belowAt) return 'It is already on the map';
  return undefined;
}

export function archiveNode<T extends GraphNode>(nodes: readonly T[], id: string, at: string): T[] {
  if (!nodes.some(node => node.id === id)) throw new Error('Node does not exist');
  if (!at.trim()) throw new Error('Archive timestamp is required');
  return nodes.map(node => node.id === id && !node.archivedAt ? { ...node, archivedAt: at } : node);
}

export function restoreNode<T extends GraphNode>(nodes: readonly T[], id: string): T[] {
  const node = nodes.find(node => node.id === id);
  if (!node) throw new Error('Node does not exist');
  if (nodes.find(parent => parent.id === node.projectId)?.archivedAt) {
    throw new Error('Restore the project first');
  }
  return nodes.map(candidate => {
    if (candidate.id !== id) return candidate;
    const { archivedAt, ...restored } = candidate;
    return restored as T;
  });
}

/** Keep active parent projects as orientation in the Archive map. Never delete links. */
export function visibleGraph(nodes: readonly GraphNode[], links: readonly GraphLink[], archive = false) {
  const archived = nodes.filter(node => isArchived(node, nodes));
  const parentIds = new Set(archived.map(node => node.projectId));
  const visible = nodes.filter(node => archive
    ? isArchived(node, nodes) || parentIds.has(node.id)
    : !isArchived(node, nodes));
  const ids = new Set(visible.map(node => node.id));
  return { nodes: visible, links: links.filter(link => ids.has(link.sourceId) && ids.has(link.targetId)) };
}
