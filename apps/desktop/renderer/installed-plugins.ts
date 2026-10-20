import type { RendererModule } from '../../../packages/plugin-sdk/host.ts';
import { pluginFailure, withTimeout } from '../../../src/resource-plugins/plugin-guard.ts';
import { useInstalledRenderers } from '../../../src/resource-plugins/installed.client.ts';
import type { InstalledRenderer } from '../../../src/resource-plugins/installed.client.ts';

const IMPORT_TIMEOUT_MS = 5000;

/** Imports the window code and stylesheets of the packages the service loaded, from
 * craft://app/plugins/…, before the map first shows items. A package that fails keeps generic views. */
async function loadInstalledRenderers() {
  let loaded: Awaited<ReturnType<typeof window.craftingTable.pluginsLoaded>>;
  try { loaded = await window.craftingTable.pluginsLoaded(); } catch { ready = undefined; return; }
  const failures: Record<string, string> = {}, renderers: InstalledRenderer[] = [];
  await Promise.all(loaded.plugins.map(async plugin => {
    for (const href of plugin.css) {
      const link = document.createElement('link');
      link.rel = 'stylesheet'; link.href = href; link.dataset.plugin = plugin.id;
      document.head.append(link);
    }
    if (!plugin.renderer) return;
    try {
      const imported = await withTimeout(import(plugin.renderer) as Promise<{ default?: RendererModule } & Partial<RendererModule>>, IMPORT_TIMEOUT_MS, `Its window code did not load within ${IMPORT_TIMEOUT_MS / 1000} s.`);
      const module = (imported.default ?? imported) as RendererModule;
      if (typeof module.activate !== 'function') throw new Error('Its window entry exports no activate function.');
      renderers.push({ pluginId: plugin.id, name: plugin.name, itemTypes: plugin.itemTypes, actionTargets: plugin.actionTargets, module });
    } catch (error) { failures[plugin.id] = pluginFailure(error); }
  }));
  const order = loaded.plugins.map(plugin => plugin.id);
  useInstalledRenderers(renderers.sort((a, b) => order.indexOf(a.pluginId) - order.indexOf(b.pluginId)), loaded.unavailable, failures);
}

let ready: Promise<void> | undefined;
/** Starts loading once per window; the map waits for it with its first workspace read. Never rejects. */
export const installedRenderersReady = () => ready ??= loadInstalledRenderers().catch(() => {});
