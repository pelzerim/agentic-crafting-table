import { parsePluginManifest } from '../plugin-sdk/manifest.ts';
import { bundledPackages } from '../../src/resource-plugins/bundled/packages.generated.ts';
import type { PluginBreaker } from '../../src/resource-plugins/plugin-guard.ts';
import type { InstalledPlugin, PluginRelease, PluginSource } from './plugin-lock.ts';
import type { LoadedPackage } from './plugin-loader.ts';

export interface InstalledPluginStatus {
  id: string; name: string; version: string; commit: string; dev: boolean; source: PluginSource;
  enabled: boolean; removed: boolean; failure?: { reason: string; at: string };
  contributes: PluginRelease['contributes']; code: PluginRelease['code']; approvedAt: string;
  previous: { commit: string; version: string; approvedAt: string }[];
  /** The build this service process is running, if any. */
  running?: { commit: string; version: string };
  /** Set while the package's breaker has paused it after repeated failures. */
  paused?: { until: number; reason?: string };
}
export interface PluginStatuses { bundled: { id: string; name: string; version: string }[]; installed: InstalledPluginStatus[]; restartRequired: boolean }

/** Shown on a package's preserved items while its item types are not registered. */
export function pluginUnavailableReason(plugin: InstalledPlugin, failure?: string) {
  const name = plugin.current.name;
  if (plugin.removed) return `${name} was removed. Its items are kept; reinstall it in Settings → Plugins to use them again.`;
  if (failure ?? plugin.failure) return `${name} could not load and is turned off. Its items are kept. ${failure ?? plugin.failure!.reason}`;
  if (!plugin.enabled) return `${name} is turned off. Its items are kept; turn it on in Settings → Plugins.`;
  return `${name} is not loaded yet. Reload plugins in Settings → Plugins.`;
}

export function pluginStatuses(installed: readonly InstalledPlugin[], running: readonly LoadedPackage[], breakers: ReadonlyMap<string, PluginBreaker>): PluginStatuses {
  const statuses = installed.map((plugin): InstalledPluginStatus => {
    const active = running.find(pkg => pkg.build.id === plugin.id), paused = breakers.get(plugin.id)?.status;
    return {
      id: plugin.id, name: plugin.current.name, version: plugin.current.version, commit: plugin.current.commit, dev: plugin.source.kind === 'folder', source: plugin.source,
      enabled: plugin.enabled, removed: plugin.removed, ...(plugin.failure ? { failure: plugin.failure } : {}),
      contributes: plugin.current.contributes, code: plugin.current.code, approvedAt: plugin.current.approvedAt,
      previous: plugin.previous.map(release => ({ commit: release.commit, version: release.version, approvedAt: release.approvedAt })),
      ...(active ? { running: { commit: active.build.commit, version: active.build.version } } : {}),
      ...(active && paused?.paused ? { paused: { until: paused.until!, ...(paused.reason ? { reason: paused.reason } : {}) } } : {}),
    };
  });
  const wanted = (status: InstalledPluginStatus) => status.enabled && !status.removed;
  return {
    bundled: bundledPackages.map(entry => parsePluginManifest(entry.manifest)).map(manifest => ({ id: manifest.id, name: manifest.name, version: manifest.version })),
    installed: statuses,
    restartRequired: statuses.some(status => wanted(status) !== Boolean(status.running) || (status.running && status.running.commit !== status.commit))
      || running.some(pkg => !installed.some(plugin => plugin.id === pkg.build.id)),
  };
}
