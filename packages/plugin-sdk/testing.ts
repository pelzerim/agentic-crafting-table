/** Test-only harness for plugin packages. Never import this from a production entry. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { JsonObject } from '../../src/resource-plugins/types.ts';
import type { PluginDefinitionsModule, PluginPackage } from './host.ts';
import { PluginPackageRegistry } from '../../src/resource-plugins/packages.ts';
import { resourcePluginContract } from '../../src/resource-plugins/testing.ts';

export { resourcePluginContract, resourceConnectorContract } from '../../src/resource-plugins/testing.ts';

/** Manifest ↔ registration consistency, serializable descriptions, and the per-type
 * definition contract for every type that has fixtures. */
export function pluginPackageContract(pkg: { manifest: unknown; module: PluginDefinitionsModule }, options: { fixtures?: Record<string, { valid: JsonObject; invalid: JsonObject[] }>; dependencies?: readonly PluginPackage[] } = {}) {
  test(`${(pkg.manifest as { id?: string }).id ?? 'plugin'}: manifest matches registrations and descriptions stay serializable`, () => {
    const registry = new PluginPackageRegistry();
    for (const dependency of options.dependencies ?? []) registry.register(dependency);
    const entry = registry.register(pkg);
    const described = JSON.parse(JSON.stringify(registry.types.describe()));
    for (const id of entry.manifest.contributes.itemTypes) assert.ok(described.some((type: { id: string }) => type.id === id), `${id} is described`);
    for (const tool of entry.module.mcpTools ?? []) {
      assert.ok(tool.description.trim(), `${tool.name} has a description`);
      assert.equal(tool.inputSchema.type, 'object', `${tool.name} takes an object`);
    }
    for (const [target, actions] of Object.entries(entry.manifest.contributes.actionContributions)) {
      assert.ok(registry.types.get(target), `${target} is registered before ${entry.manifest.id} contributes to it`);
      assert.ok(actions.length);
    }
  });
  for (const definition of pkg.module.definitions ?? []) {
    const fixture = options.fixtures?.[definition.id];
    if (fixture) resourcePluginContract(definition, fixture);
  }
}
