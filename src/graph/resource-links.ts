import type { GraphNode, RelationshipCardinality } from './graph.ts';
import type { ResourceRecord } from '../resource-plugins/types.ts';
import type { ResourcePluginRegistry } from '../resource-plugins/registry.ts';

/** UI preflight and committed commands use the same trusted plugin capacity. */
export function resourceCardinality(resources: readonly ResourceRecord[], registry: ResourcePluginRegistry): RelationshipCardinality {
  return (endpoint: GraphNode) => {
    if (!endpoint.resourceId) return 'many';
    const record = resources.find(resource => resource.id === endpoint.resourceId);
    const plugin = record && registry.get(record.pluginId);
    if (!plugin) throw new Error('Item plugin is unavailable; cannot validate its relationship rules');
    return plugin.relationships?.cardinality ?? 'many';
  };
}
