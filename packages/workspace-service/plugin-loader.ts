import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parsePluginManifest } from '../plugin-sdk/manifest.ts';
import type { PluginManifest } from '../plugin-sdk/manifest.ts';
import type { PluginDefinitionsModule, ServiceModule } from '../plugin-sdk/host.ts';
import { MANIFEST_FILE, verifyRelease } from '../plugin-sdk/integrity.ts';
import { PluginPackageRegistry } from '../../src/resource-plugins/packages.ts';
import { bundledPackages } from '../../src/resource-plugins/bundled/packages.generated.ts';
import { pluginFailure, withTimeout } from '../../src/resource-plugins/plugin-guard.ts';
import type { InstalledPlugin } from './plugin-lock.ts';
import type { PluginStore } from './plugin-store.ts';

/** How long one package may take to import an entry or finish activating. */
export const ACTIVATION_TIMEOUT_MS = 5000;

/** An approved build to load. Development folders have no integrity record. */
export interface PluginBuildSource { id: string; commit: string; dev: boolean; root: string; integrity?: Record<string, string> }
/** A build that loaded, as the desktop process and MCP bridge receive it. */
export interface PluginBuild extends PluginBuildSource { name: string; version: string; entries: PluginManifest['entries']; css: string[]; contributes: PluginManifest['contributes'] }
export interface LoadedPackage { build: PluginBuild; manifest: PluginManifest; module: PluginDefinitionsModule; service?: ServiceModule }

export function buildSource(store: PluginStore, plugin: InstalledPlugin): PluginBuildSource {
  return { id: plugin.id, commit: plugin.current.commit, dev: plugin.source.kind === 'folder', root: store.releaseRoot(plugin, plugin.current), ...(plugin.current.integrity ? { integrity: plugin.current.integrity } : {}) };
}

async function importEntry<T>(root: string, entry: string, timeoutMs: number, what: string): Promise<T> {
  const file = join(root, entry);
  if (!realpathSync(file).startsWith(realpathSync(root) + sep)) throw new Error(`${entry} is outside the plugin folder.`);
  const module = await withTimeout(import(pathToFileURL(file).href) as Promise<{ default?: T }>, timeoutMs, `Its ${what} did not load within ${timeoutMs / 1000} s.`);
  return (module.default ?? module) as T;
}

/** Verifies a build against its approved integrity record, checks the manifest and API range,
 * and imports its definitions (and service entry when asked). Nothing is registered yet. */
export async function loadBuild(source: PluginBuildSource, options: { service: boolean; timeoutMs?: number }): Promise<LoadedPackage> {
  if (source.integrity) await verifyRelease(source.root, source.integrity);
  let input: unknown;
  try { input = JSON.parse(await readFile(join(source.root, MANIFEST_FILE), 'utf8')); } catch { throw new Error(`Its ${MANIFEST_FILE} is missing or unreadable.`); }
  const manifest = parsePluginManifest(input);
  if (manifest.id !== source.id) throw new Error(`The build declares ${manifest.id}, not ${source.id}.`);
  const timeoutMs = options.timeoutMs ?? ACTIVATION_TIMEOUT_MS;
  const module = await importEntry<PluginDefinitionsModule>(source.root, manifest.entries.definitions, timeoutMs, 'definitions');
  if (!module || typeof module !== 'object') throw new Error('Its definitions entry exports no package module.');
  const service = options.service && manifest.entries.service ? await importEntry<ServiceModule>(source.root, manifest.entries.service, timeoutMs, 'service code') : undefined;
  if (service && typeof service.activate !== 'function') throw new Error('Its service entry exports no activate function.');
  return { build: { ...source, name: manifest.name, version: manifest.version, entries: manifest.entries, css: manifest.contributes.css, contributes: manifest.contributes }, manifest, module, ...(service ? { service } : {}) };
}

/** Loads builds in order. Each must register cleanly after the bundled packages and the builds
 * before it; one that fails is reported and skipped without affecting the others. */
export async function loadBuilds(sources: readonly PluginBuildSource[], options: { service: boolean; timeoutMs?: number }) {
  const trial = new PluginPackageRegistry(), loaded: LoadedPackage[] = [], failures: { id: string; reason: string }[] = [];
  for (const entry of bundledPackages) trial.register(entry);
  for (const source of sources) {
    try {
      const pkg = await loadBuild(source, options);
      trial.register({ manifest: pkg.manifest, module: pkg.module });
      loaded.push(pkg);
    } catch (error) { failures.push({ id: source.id, reason: pluginFailure(error) }); }
  }
  return { loaded, failures };
}
