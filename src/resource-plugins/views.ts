import { itemViewProfile } from '../../packages/core/item-views.ts';
import type { ResourcePluginRegistry } from './registry.ts';
import type { JsonObject, MountedResourceView, ResourceAppearance, ResourcePluginDefinition, ResourcePluginViews, ResourceRecord, ResourceSnapshot, ResourceViewServices } from './types.ts';
import type { ViewContribution } from '../../packages/plugin-sdk/host.ts';

/** The canvas uses this for every type: no provider-specific sizing or status logic. */
export function presentResource(registry: ResourcePluginRegistry, resource: ResourceRecord) {
  const resolved = registry.resolve(resource);
  const plugin = resolved.available ? resolved.plugin : undefined;
  const appearance: ResourceAppearance = { size: 'small', tone: 'neutral', shape: 'rounded', ...plugin?.appearance };
  return {
    id: resource.id, title: resource.title, pluginId: resource.pluginId,
    available: resolved.available, reason: resolved.available ? undefined : resolved.reason,
    typeName: plugin?.name ?? resource.pluginId, icon: plugin?.icon ?? 'puzzle',
    activation: plugin?.activation,
    view: itemViewProfile(plugin, resource),
    brand: plugin?.brand ?? plugin?.providerBrands?.[String(resource.data.provider ?? '').toLowerCase()],
    frameTitle: plugin?.view?.frameTitle?.replace(/\{(\w+)\}/g, (_match, key: string) => String(resource.data[key] ?? '—')),
    reference: resourceReference(plugin, resource),
    appearance, acceptsContext: plugin?.acceptsContext === true, overview: plugin?.overview,
    relationships: plugin?.relationships,
    fields: Object.entries(plugin?.fields ?? {}).map(([key, field]) => ({ key, ...field, value: resource.data[key] })),
  };
}
export type ResourcePresentation = ReturnType<typeof presentResource>;
export function resourceReference(plugin: Pick<ResourcePluginDefinition, 'view'> | undefined, resource: ResourceRecord) {
  return plugin?.view?.reference?.replace(/\{(\w+)\}/g, (_match, key: string) => String(resource.data[key] ?? '—'));
}
/** Node state, rather than shared resource data, determines a completion icon. */
export function presentationIcon(item: ResourcePresentation | undefined, completed = false) {
  return completed && item?.appearance.completedIcon ? item.appearance.completedIcon : item?.icon ?? 'project';
}
/** What an open view is updated with when the workspace changes: the item's saved map state.
 * Nothing is read from the provider, so there is no title or content; the view re-reads what it shows. */
export function savedSnapshot(node: Pick<ResourceSnapshot, 'activity' | 'attention' | 'indicators'> & { summary: string }, observedAt = new Date().toISOString()): ResourceSnapshot {
  return { activity: node.activity, attention: node.attention, connection: node.indicators?.some(cue => cue.id === 'connection') ? 'disconnected' : 'unknown', label: node.summary, observedAt,
    ...(node.indicators ? { indicators: node.indicators } : {}) };
}
/** A view's edit of its item's saved data: each field replaces the saved one, null removes it. */
export function patchedData(data: JsonObject, patch: JsonObject): JsonObject {
  return Object.fromEntries(Object.entries({ ...data, ...patch }).filter(([, value]) => value !== null));
}
export type DefaultResourceView = (container: HTMLElement, item: ResourcePresentation, services: ResourceViewServices) => MountedResourceView;

/** Frontend only. The shell injects its generic card/detail renderer as the fallback. */
export class ResourceViewRegistry {
  readonly definitions: ResourcePluginRegistry;
  private views = new Map<string, ResourcePluginViews>();
  private contributions = new Map<string, ViewContribution[]>();
  constructor(definitions: ResourcePluginRegistry) { this.definitions = definitions; }

  register(pluginId: string, views: ResourcePluginViews) {
    if (!this.definitions.get(pluginId)) throw new Error('Register the item definition first');
    if (this.views.has(pluginId)) throw new Error(`Views already registered: ${pluginId}`);
    this.views.set(pluginId, views);
  }
  /** Another package's controls in this type's views, offered through `services.viewContributions`. */
  contribute(pluginId: string, contribution: ViewContribution) {
    if (!this.definitions.get(pluginId)) throw new Error('Register the item definition first');
    this.contributions.set(pluginId, [...(this.contributions.get(pluginId) ?? []), contribution]);
  }
  identity(resource: ResourceRecord) {
    return `${resource.id}:${resource.pluginId}:${resource.schemaVersion}:${this.views.get(resource.pluginId)?.identity?.(resource) ?? JSON.stringify(resource)}`;
  }

  async runContextAction(resource: ResourceRecord, actionId: string, services: Pick<ResourceViewServices, 'runAction'>, signal: AbortSignal) {
    const resolved = this.definitions.resolve(resource), view = this.views.get(resource.pluginId);
    if (!resolved.available || !resolved.plugin.contextMenu?.some(group => group.children.some(action => action.id === actionId)) || !view?.runContextAction)
      throw new Error('This item action is unavailable.');
    return view.runContextAction(actionId, resource, services, signal);
  }

  async preview(resource: ResourceRecord, services: Pick<ResourceViewServices, 'runAction'>, signal: AbortSignal) {
    const view = this.definitions.resolve(resource).available ? this.views.get(resource.pluginId) : undefined;
    return view?.preview ? view.preview(resource, services, signal) : undefined;
  }

  mount(surface: 'node' | 'detail', container: HTMLElement, resource: ResourceRecord, services: ResourceViewServices, fallback: DefaultResourceView): MountedResourceView {
    const item = presentResource(this.definitions, resource);
    const view = item.available ? this.views.get(resource.pluginId) : undefined;
    const contributed = this.contributions.get(resource.pluginId), viewServices = contributed ? { ...services, viewContributions: contributed } : services;
    const mounted = surface === 'node' && view?.mountNode ? view.mountNode(container, resource, viewServices)
      : surface === 'detail' && view ? view.mountDetail(container, resource, viewServices)
      : fallback(container, item, services);
    let disposed = false;
    return {
      update(snapshot: ResourceSnapshot) { if (!disposed) mounted.update(snapshot); },
      setActive(active: boolean) { if (!disposed) mounted.setActive?.(active); },
      dispose() { if (!disposed) { disposed = true; mounted.dispose(); } },
    };
  }
}
