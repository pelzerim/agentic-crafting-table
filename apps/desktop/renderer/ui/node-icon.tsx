import type { WorkspaceState } from '../../../../packages/core/control.ts';
import type { ResourcePluginRegistry } from '../../../../src/resource-plugins/registry.ts';
import { presentResource, presentationIcon } from '../../../../src/resource-plugins/views.ts';
import { ItemIcon } from '../icons.tsx';

/** The item's own type icon in its brand tint; projects get the folder. */
export function NodeIcon({ state, registry, nodeId }: { state: WorkspaceState; registry: ResourcePluginRegistry; nodeId: string }) {
  const node = state.nodes.find(candidate => candidate.id === nodeId), resource = node?.resourceId ? state.resources.find(candidate => candidate.id === node.resourceId) : undefined;
  const view = resource && presentResource(registry, resource);
  return <ItemIcon icon={presentationIcon(view, Boolean(node?.completedAt))} brand={view?.brand} tint={view?.appearance.brandTint} className={`tone-${view?.appearance.tone ?? 'mint'}`} />;
}
