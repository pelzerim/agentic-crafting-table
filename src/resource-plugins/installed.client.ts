import { PLUGIN_API } from '../../packages/plugin-sdk/manifest.ts';
import type { RendererModule } from '../../packages/plugin-sdk/host.ts';
import { pluginFailure } from './plugin-guard.ts';
import type { ResourcePluginRegistry } from './registry.ts';
import type { MountedResourceView, ResourcePluginViews } from './types.ts';
import type { ResourceViewRegistry } from './views.ts';

/** Window code of one installed package, imported before the app first renders. */
export interface InstalledRenderer { pluginId: string; name: string; itemTypes: readonly string[]; actionTargets: readonly string[]; module: RendererModule }

let renderers: readonly InstalledRenderer[] = [];
let reasons: Readonly<Record<string, string>> = {};
const failures = new Map<string, string>();
/** Set once per window load by the desktop bootstrap, with packages whose window code did not load. */
export function useInstalledRenderers(next: readonly InstalledRenderer[], unavailable: Readonly<Record<string, string>>, failed: Readonly<Record<string, string>> = {}) {
  renderers = next; reasons = unavailable; failures.clear();
  for (const [pluginId, reason] of Object.entries(failed)) failures.set(pluginId, reason);
}
/** Packages whose window code failed to load or start in this window; their items use generic views. */
export const rendererFailures = (): Record<string, string> => Object.fromEntries(failures);
/** Why item types of turned-off, failed or removed packages are unavailable. */
export const unavailableReasons = () => reasons;

function failed(container: HTMLElement, name: string, error: unknown): MountedResourceView {
  const message = container.ownerDocument.createElement('p');
  message.className = 'plugin-view-error'; message.setAttribute('role', 'alert');
  message.textContent = `${name} could not show this item: ${pluginFailure(error)}`;
  container.append(message);
  return { update() {}, dispose() { message.remove(); } };
}

/** A failing view shows an error in its own frame instead of breaking the map. */
function guardViews(name: string, views: ResourcePluginViews): ResourcePluginViews {
  const mountDetail: ResourcePluginViews['mountDetail'] = (container, resource, services) => {
    try { return views.mountDetail(container, resource, services); } catch (error) { return failed(container, name, error); }
  };
  const node = views.mountNode;
  const mountNode: ResourcePluginViews['mountNode'] = node && ((container, resource, services) => {
    try { return node(container, resource, services); } catch (error) { return failed(container, name, error); }
  });
  return { ...views, mountDetail, ...(mountNode ? { mountNode } : {}) };
}

/** Activates installed packages' window code through the same RendererHost as bundled packages. */
export function activateInstalledRenderers(registry: ResourcePluginRegistry, views: ResourceViewRegistry) {
  for (const installed of renderers) {
    try {
      installed.module.activate({
        api: PLUGIN_API, pluginId: installed.pluginId,
        views: (typeId, typeViews) => {
          if (!installed.itemTypes.includes(typeId)) throw new Error(`Plugin ${installed.pluginId} did not declare item type ${typeId} in act-plugin.json`);
          if (registry.get(typeId)) views.register(typeId, guardViews(installed.name, typeViews));
        },
        contributeViews: (targetTypeId, contribution) => {
          if (!installed.actionTargets.includes(targetTypeId)) throw new Error(`Plugin ${installed.pluginId} did not declare contributions to ${targetTypeId} in act-plugin.json`);
          if (registry.get(targetTypeId)) views.contribute(targetTypeId, contribution);
        },
      });
    } catch (error) { failures.set(installed.pluginId, pluginFailure(error)); }
  }
}
