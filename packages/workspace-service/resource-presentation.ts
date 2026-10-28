import type { ResourcePluginHost } from '../../src/resource-plugins/host.ts';
import type { ResourceRecord, ResourceSnapshot } from '../../src/resource-plugins/types.ts';
import type { SqliteStore } from './sqlite-store.ts';
import type { CardPips } from '../../src/resource-plugins/indicators.ts';

/** Local presentation overlays never overwrite provider snapshots or attention. Each type
 * registers its own hooks (ServiceHost.presentation); graph and MCP code stay type-free. */
export const hasResourceMapPresentation = (host: ResourcePluginHost, resource: ResourceRecord) => Boolean(host.presentation(resource.pluginId));
export function resourceMapIndicators(host: ResourcePluginHost, resource: ResourceRecord, snapshot: ResourceSnapshot, store: SqliteStore) {
  return host.presentation(resource.pluginId)?.indicators?.(resource, snapshot, store) ?? snapshot.indicators;
}
/** The card pips a type's presentation draws: `null` clears them, `undefined` leaves a type without the hook alone. */
export function resourceMapPips(host: ResourcePluginHost, resource: ResourceRecord, snapshot: ResourceSnapshot, store: SqliteStore): CardPips | null | undefined {
  const hook = host.presentation(resource.pluginId)?.pips;
  return hook ? hook(resource, snapshot, store) ?? null : undefined;
}
export function presentationAttention(host: ResourcePluginHost, resource: ResourceRecord, snapshot: ResourceSnapshot, store: SqliteStore) {
  return host.presentation(resource.pluginId)?.attention?.(resource, snapshot, store);
}
