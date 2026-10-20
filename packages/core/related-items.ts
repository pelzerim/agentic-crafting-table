import type { WorkspaceState } from './control.ts';
import { isArchived } from '../../src/graph/archive.ts';
import type { ResourcePluginRegistry } from '../../src/resource-plugins/registry.ts';
import type { RelatedResourceItem } from '../../src/resource-plugins/types.ts';

/** Credential-free, direct map relationships. Shared resource aliases share links;
 * project membership alone does not imply that an item is connected. */
export function relatedResourceItems(graph: WorkspaceState, nodeId: string, registry: ResourcePluginRegistry): RelatedResourceItem[] {
  const nodes = new Map(graph.nodes.map(node => [node.id, node])), resources = new Map(graph.resources.map(resource => [resource.id, resource]));
  const current = nodes.get(nodeId); if (!current) return [];
  const sources = new Set(graph.nodes.filter(node => !isArchived(node, graph.nodes) && (node.id === nodeId || current.resourceId && node.resourceId === current.resourceId)).map(node => node.id));
  const connected = new Set(graph.links.flatMap(link => sources.has(link.sourceId) ? [link.targetId] : sources.has(link.targetId) ? [link.sourceId] : []));
  const seen = new Set<string>(), result: RelatedResourceItem[] = [];
  for (const id of connected) {
    const node = nodes.get(id); if (!node || sources.has(id) || isArchived(node, graph.nodes)) continue;
    const resource = node.resourceId ? resources.get(node.resourceId) : undefined;
    const key = node.resourceId ?? node.id; if (seen.has(key)) continue; seen.add(key);
    const definition = resource && registry.get(resource.pluginId), parentField = definition?.context?.parentField;
    const parent = parentField && nodes.get(String(resource?.data[parentField]));
    result.push({ nodeId: node.id, title: node.title, summary: node.summary, activity: node.activity, attention: node.attention,
      typeName: definition?.name ?? (resource ? resource.pluginId : 'Project'), resource, parentResourceId: parent ? parent.resourceId : undefined });
  }
  return result;
}
