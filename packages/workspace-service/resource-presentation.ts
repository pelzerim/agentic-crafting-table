import type { ResourcePluginHost } from '../../src/resource-plugins/host.ts';
import type { ResourceRecord, ResourceSnapshot } from '../../src/resource-plugins/types.ts';
import type { SqliteStore } from './sqlite-store.ts';

/** Local presentation overlays never overwrite provider snapshots or attention. Each type
 * registers its own hooks (ServiceHost.presentation); graph and MCP code stay type-free. */
export const hasResourceMapPresentation = (host: ResourcePluginHost, resource: ResourceRecord) => Boolean(host.presentation(resource.pluginId));
export function resourceMapIndicators(host: ResourcePluginHost, resource: ResourceRecord, snapshot: ResourceSnapshot, store: SqliteStore) {
  return host.presentation(resource.pluginId)?.indicators?.(resource, snapshot, store) ?? snapshot.indicators;
}
export function presentationAttention(host: ResourcePluginHost, resource: ResourceRecord, snapshot: ResourceSnapshot, store: SqliteStore) {
  return host.presentation(resource.pluginId)?.attention?.(resource, snapshot, store);
}
