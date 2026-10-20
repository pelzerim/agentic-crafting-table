import { PLUGIN_API, parsePluginManifest } from '../../packages/plugin-sdk/manifest.ts';
import { ResourceViewRegistry } from './views.ts';
import type { ResourcePluginRegistry } from './registry.ts';
import { bundledPackages } from './bundled/packages.generated.ts';
import { bundledRendererModules } from './bundled/renderer.generated.ts';
import { activateInstalledRenderers } from './installed.client.ts';

/** Browser composition root: every bundled package's renderer entry, activated through RendererHost.
 * No imports from catalog.server.ts or provider SDKs. */
export function createResourceViews(registry: ResourcePluginRegistry) {
  const views = new ResourceViewRegistry(registry);
  for (const entry of bundledPackages) {
    const manifest = parsePluginManifest(entry.manifest), module = bundledRendererModules[manifest.id];
    if (!module) continue;
    module.activate({
      api: PLUGIN_API, pluginId: manifest.id,
      views: (typeId, typeViews) => {
        if (!manifest.contributes.itemTypes.includes(typeId)) throw new Error(`Plugin ${manifest.id} did not declare item type ${typeId} in act-plugin.json`);
        if (registry.get(typeId)) views.register(typeId, typeViews);
      },
      contributeViews: (targetTypeId, contribution) => {
        if (!manifest.contributes.actionContributions[targetTypeId]) throw new Error(`Plugin ${manifest.id} did not declare contributions to ${targetTypeId} in act-plugin.json`);
        if (registry.get(targetTypeId)) views.contribute(targetTypeId, contribution);
      },
    });
  }
  activateInstalledRenderers(registry, views);
  return views;
}
