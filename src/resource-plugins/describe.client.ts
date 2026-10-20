import { ResourcePluginRegistry } from './registry.ts';
import { unavailableReasons } from './installed.client.ts';
import { fieldDefaults, validateFields } from './define.ts';
import type { JsonObject, ResourceFields } from './types.ts';

export type PluginDescription = ReturnType<ResourcePluginRegistry['describe']>[number];

/** Metadata controls presentation only. Every mutation is validated by the service. */
export function registryFromDescriptions(descriptions: PluginDescription[]) {
  const registry = new ResourcePluginRegistry();
  for (const description of descriptions) {
    registry.register({ ...description, validateData: data => validateFields(description.fields ?? {}, data) });
    if (description.migrationError) registry.setMigrationError(description.id, description.migrationError);
  }
  for (const [typeId, reason] of Object.entries(unavailableReasons())) registry.setUnavailableReason(typeId, reason);
  return registry;
}

/** Saved package settings with the defaults their sections declare. */
export function pluginSettingsValues(descriptions: readonly { settingsSections?: readonly { owner: string; fields: ResourceFields }[] }[], saved: Readonly<Record<string, JsonObject>> = {}): Record<string, JsonObject> {
  const values: Record<string, JsonObject> = { ...saved };
  for (const section of descriptions.flatMap(description => description.settingsSections ?? [])) values[section.owner] = { ...fieldDefaults(section.fields), ...saved[section.owner] };
  return values;
}
