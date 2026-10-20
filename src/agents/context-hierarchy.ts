import type { WorkspaceState } from '../../packages/core/control.ts';
import type { ResourcePluginRegistry } from '../resource-plugins/registry.ts';
import { blockerResolved } from '../graph/blocking.ts';
import { attentionTier, nodeAttentionReasons } from '../graph/attention.ts';
import type { AttentionTier } from '../graph/attention.ts';

export const MAX_CONTEXT_ITEMS = 200;
type Node = WorkspaceState['nodes'][number];
export interface ContextEntry {
  nodeId: string; resourceId?: string; parentId?: string; depth: number;
  title: string; type: string; summary: string; activity: string; attention: string;
  /** The Needs me tier of the item's unread reasons, when it has any (STATE-02). */
  tier?: AttentionTier;
  done: boolean; facts: Record<string, string | number | boolean>;
}

export const MAX_PROJECT_ITEMS = 30;
/** Centered on the agent: items connected to it, directly or through other items,
 * never other projects by proximity. Unconnected project members are listed only as
 * brief background. A stable spanning tree supplies order; cross-links retain
 * meaning. Aliases, cycles and missing plugins do not duplicate or block context. */
export function contextHierarchy(state: WorkspaceState, agentId: string, registry: ResourcePluginRegistry) {
  const agent = state.nodes.find(node => node.id === agentId);
  if (!agent) throw new Error('Agent not found');
  const resources = new Map(state.resources.map(resource => [resource.id, resource]));
  // Archived and Undermap items are finished work; they are not agent context.
  const away = new Set(state.nodes.filter(node => node.archivedAt || node.belowAt).map(node => node.id));
  const visible = state.nodes.filter(node => !away.has(node.id) && !away.has(node.projectId ?? ''));
  const identity = (node: Node) => node.resourceId ? `resource:${node.resourceId}` : `node:${node.id}`;
  const sorted = [...visible].sort((a, b) => Number(b.id === agentId) - Number(a.id === agentId)
    || Number(b.projectId === agent.projectId) - Number(a.projectId === agent.projectId) || a.id.localeCompare(b.id));
  const unique = new Map<string, Node>();
  for (const node of sorted) if (!unique.has(identity(node))) unique.set(identity(node), node);
  const aliases = new Map(visible.map(node => [node.id, unique.get(identity(node))!.id]));
  const nodes = new Map([...unique.values()].map(node => [node.id, node]));
  const neighbors = new Map<string, Set<string>>();
  const connect = (a: string, b: string) => { if (!neighbors.has(a)) neighbors.set(a, new Set()); neighbors.get(a)!.add(b); };
  const links = state.links.flatMap(link => {
    const sourceId = aliases.get(link.sourceId), targetId = aliases.get(link.targetId);
    if (!sourceId || !targetId || sourceId === targetId) return [];
    connect(sourceId, targetId); connect(targetId, sourceId);
    return [{ id: link.id, sourceId, targetId, kind: link.kind, label: link.label.slice(0, 120) }];
  }).sort((a, b) => a.id.localeCompare(b.id));
  const project = nodes.get(agent.projectId ?? '');
  const seeds = [...(neighbors.get(agentId) ?? [])].filter(id => id !== agentId && id !== project?.id).sort();
  const included = new Set<string>(), queue = [...seeds];
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i];
    if (included.has(id) || id === agentId || id === project?.id) continue;
    included.add(id);
    for (const other of neighbors.get(id) ?? []) if (!included.has(other)) queue.push(other);
  }
  const parents = new Map<string, string>();
  for (const id of included) {
    const resource = resources.get(nodes.get(id)!.resourceId ?? '');
    const field = resource && registry.get(resource.pluginId)?.context?.parentField;
    const parent = field && typeof resource?.data[field] === 'string' ? aliases.get(resource.data[field] as string) : undefined;
    if (parent && parent !== id && included.has(parent) && neighbors.get(id)?.has(parent)) parents.set(id, parent);
  }
  const blocking = links.filter(link => link.kind === 'blocks');
  const entries: ContextEntry[] = [], depths = new Map<string, number>(), visiting = new Set<string>();
  const visit = (id: string, from?: string) => {
    if (depths.has(id) || visiting.has(id) || !included.has(id) || entries.length >= MAX_CONTEXT_ITEMS || visiting.size >= MAX_CONTEXT_ITEMS) return;
    visiting.add(id);
    const declared = parents.get(id);
    if (declared) visit(declared);
    if (entries.length >= MAX_CONTEXT_ITEMS) { visiting.delete(id); return; }
    const parentId = declared && depths.has(declared) ? declared : from;
    const depth = parentId ? (depths.get(parentId) ?? -1) + 1 : 0;
    const node = nodes.get(id)!, resource = resources.get(node.resourceId ?? ''), plugin = resource && registry.get(resource.pluginId);
    const facts: ContextEntry['facts'] = {};
    for (const field of plugin?.context?.fields?.slice(0, 8) ?? []) {
      const value = resource!.data[field];
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') facts[field] = typeof value === 'string' ? value.slice(0, 200) : value;
    }
    const blocks = blocking.filter(link => link.sourceId === id).map(link => nodes.get(link.targetId)!.title.slice(0, 80));
    const blockedBy = blocking.filter(link => link.targetId === id).map(link => `${nodes.get(link.sourceId)!.title.slice(0, 80)}${blockerResolved(nodes.get(link.sourceId)) ? ' (resolved)' : ''}`);
    if (blocks.length) facts.blocks = [...new Set(blocks)].join('; ');
    if (blockedBy.length) facts.blockedBy = [...new Set(blockedBy)].join('; ');
    depths.set(id, depth);
    entries.push({ nodeId: id, ...(node.resourceId ? { resourceId: node.resourceId } : {}), ...(parentId ? { parentId } : {}), depth,
      title: node.title.slice(0, 160), type: resource?.pluginId ?? 'project', summary: node.summary.slice(0, 240),
      activity: node.activity, attention: node.attention, ...(attentionTier(nodeAttentionReasons(node)) ? { tier: attentionTier(nodeAttentionReasons(node)) } : {}), done: Boolean(node.completedAt), facts });
    visiting.delete(id);
    for (const child of [...(neighbors.get(id) ?? [])].sort()) visit(child, id);
  };
  // Provider-declared parents precede their results, regardless of link direction.
  for (const id of seeds.sort((a, b) => Number(parents.has(a)) - Number(parents.has(b)) || a.localeCompare(b))) visit(id);
  const shown = new Set([agentId, project?.id, ...entries.map(entry => entry.nodeId)]);
  const projectItems = project ? [...nodes.values()].filter(node => node.projectId === project.id && node.resourceId && node.id !== agentId && !included.has(node.id))
    .slice(0, MAX_PROJECT_ITEMS).map(node => ({ nodeId: node.id, title: node.title.slice(0, 160), type: resources.get(node.resourceId!)?.pluginId ?? 'unknown', activity: node.activity, done: Boolean(node.completedAt) })) : [];
  return { project: project ? { nodeId: project.id, title: project.title.slice(0, 160), summary: project.summary.slice(0, 400) } : null, entries, projectItems,
    links: links.filter(link => shown.has(link.sourceId) && shown.has(link.targetId)),
    omittedItems: included.size - entries.length,
    scope: 'Entries are items connected to this agent, directly or through other connected items. projectItems are other members of its project, as brief background only. Parent/depth is display order; links retain their original direction and meaning. A blocks link means its source must be finished first: facts.blockedBy lists an entry’s blockers (resolved ones marked), facts.blocks what waits on it. Archived and Undermap items are excluded; done items remain marked. Other project membership is not traversed.' };
}
