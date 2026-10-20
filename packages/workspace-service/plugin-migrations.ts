import { basename } from 'node:path';
import type { SqliteStore } from './sqlite-store.ts';
import type { ResourcePluginRegistry } from '../../src/resource-plugins/registry.ts';
import { stateSchema, RevisionConflict } from '../core/control.ts';

export interface PluginMigrationReport { pluginId: string; schemaVersion: number; status: 'upgraded' | 'failed'; count: number; at: string; backup?: string; error?: string }
/** Runs under the workspace's sole-writer lease before serving commands. Each
 * plugin upgrade is atomic; a failing plugin remains an unavailable preserved
 * record and cannot prevent unrelated workspace data from opening. */
export async function migratePluginResources(store: SqliteStore, registry: ResourcePluginRegistry): Promise<PluginMigrationReport[]> {
  const reports: PluginMigrationReport[] = [];
  for (const plugin of registry.list()) {
    const state = await store.read();
    const candidates = state.resources.filter(resource => resource.pluginId === plugin.id && registry.migrationPath(resource).length);
    if (!candidates.length) continue;
    const report: PluginMigrationReport = { pluginId: plugin.id, schemaVersion: plugin.schemaVersion, status: 'failed', count: candidates.length, at: new Date().toISOString() };
    try {
      const upgraded = new Map(candidates.map(resource => [resource.id, registry.migrate(resource)]));
      const next = stateSchema.parse({ ...state, revision: state.revision + 1, resources: state.resources.map(resource => upgraded.get(resource.id) ?? resource) });
      const identities = new Map<string, string[]>();
      for (const resource of next.resources) {
        const key = registry.identity(resource); if (!key) continue;
        identities.set(key, [...identities.get(key) ?? [], resource.id]);
      }
      for (const ids of identities.values()) if (ids.length > 1 && ids.some(id => upgraded.has(id))) throw new Error('Migration would merge distinct provider resources');
      report.backup = basename(store.backupResources());
      await store.update(current => { if (current.revision !== state.revision) throw new RevisionConflict(state.revision, current.revision); return next; });
      report.status = 'upgraded';
    } catch {
      // Plugin exceptions can contain private data. Surface normalized diagnostics.
      report.error = 'Plugin data upgrade failed. Original records are preserved; install a corrected plugin to retry.';
      registry.setMigrationError(plugin.id, report.error);
    }
    const scope = `plugin-migrations:${plugin.id}`, previous = store.observation(scope);
    store.commitObservation(scope, previous.revision, report); reports.push(report);
  }
  return reports;
}
