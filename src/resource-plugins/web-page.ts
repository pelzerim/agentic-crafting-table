import { webLinkUrl } from './define.ts';
import type { ResourcePluginRegistry } from './registry.ts';
import type { ResourceRecord } from './types.ts';

/** An item's page on the web, by its type's `webLink`; `resourceOf` finds the record of another map item for a link `from` it. */
export function resourceWebPage(resource: ResourceRecord | undefined, registry: ResourcePluginRegistry, resourceOf: (nodeId: string) => ResourceRecord | undefined, followed = false): { label: string; url: string } | undefined {
  const link = resource && registry.get(resource.pluginId)?.webLink;
  if (!resource || !link) return undefined;
  if (link.from) {
    const nodeId = resource.data[link.from], url = typeof nodeId === 'string' && !followed ? resourceWebPage(resourceOf(nodeId), registry, resourceOf, true)?.url : undefined;
    return url ? { label: link.label, url } : undefined;
  }
  const url = link.template ? webLinkUrl(link.template, resource.data) : undefined;
  return url ? { label: link.label, url } : undefined;
}
