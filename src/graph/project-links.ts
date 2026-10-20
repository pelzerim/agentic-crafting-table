import type { GraphLink, GraphNode } from './graph.ts';

export interface ProjectLink {
  sourceId: string;
  targetId: string;
  kind: 'family';
}

/**
 * Project membership remains stored on every node. Draw one project connection
 * per connected group instead of repeating it for every linked resource.
 * Pass the visible graph so archiving an intermediary cannot orphan its peers.
 * The host can rank anchors by plugin prominence; agent nodes win by default.
 */
export function projectLinks(
  nodes: readonly GraphNode[],
  links: readonly GraphLink[],
  priority: (node: GraphNode) => number = node => node.acceptsContext ? 2 : 1,
): ProjectLink[] {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const adjacent = new Map(nodes.map(node => [node.id, new Set<string>()]));
  const attached = new Set<string>();
  for (const link of links) {
    const a = byId.get(link.sourceId), b = byId.get(link.targetId);
    if (!a || !b) continue;
    if (a.projectId && a.projectId === b.projectId) {
      adjacent.get(a.id)!.add(b.id);
      adjacent.get(b.id)!.add(a.id);
    }
    if (a.projectId === b.id) attached.add(a.id);
    if (b.projectId === a.id) attached.add(b.id);
  }
  const seen = new Set<string>();
  const result: ProjectLink[] = [];
  for (const node of nodes) {
    if (!node.projectId || !byId.has(node.projectId) || seen.has(node.id)) continue;
    const group: GraphNode[] = [], pending = [node.id];
    while (pending.length) {
      const id = pending.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      group.push(byId.get(id)!);
      pending.push(...adjacent.get(id)!);
    }
    if (group.some(member => attached.has(member.id))) continue;
    group.sort((a, b) => priority(b) - priority(a) || a.id.localeCompare(b.id));
    result.push({ sourceId: node.projectId, targetId: group[0].id, kind: 'family' });
  }
  return result;
}
