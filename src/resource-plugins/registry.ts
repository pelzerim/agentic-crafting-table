import { isResourceUrl } from './url-input.ts';
import * as z from 'zod/v4';
import type { JsonObject, ResourceDraft, ResourceFields, ResourceMenuGroup, ResourcePluginDefinition, ResourceRecord } from './types.ts';
import { fieldDefaults, fieldsSchema, validateFields } from './define.ts';
import { localItemTitle } from './generated-title.ts';

export type AttachmentCandidate = ResourceDraft & {
  pluginId: string;
  schemaVersion: number;
};

/** A package's settings, stored under `settings.plugins[owner]` and shown on `typeId`'s settings page. */
export interface SettingsSection { typeId: string; label: string; description?: string; connectionHint?: string; fields: ResourceFields;
  /** Throws with a reason when values the fields accept still do not make sense together, e.g. text that must parse. */
  validate?(values: JsonObject): void }

export type ResolvedResource =
  | { available: true; plugin: ResourcePluginDefinition; resource: ResourceRecord }
  | { available: false; reason: string; resource: ResourceRecord };

/** The core never branches on provider names or resource types. */
export class ResourcePluginRegistry {
  private migrationErrors = new Map<string, string>();
  private plugins = new Map<string, ResourcePluginDefinition>();
  private menus: { owner: string; targetTypeId: string; groups: readonly ResourceMenuGroup[] }[] = [];
  private sections = new Map<string, Omit<SettingsSection, 'validate'>>();
  private validators = new Map<string, NonNullable<SettingsSection['validate']>>();
  private unavailableReasons = new Map<string, string>();

  /** Menu groups another package adds after the target type's own groups. */
  contributeMenus(owner: string, targetTypeId: string, groups: readonly ResourceMenuGroup[]) {
    const taken = new Set([...(this.plugins.get(targetTypeId)?.contextMenu ?? []), ...this.menus.filter(menu => menu.targetTypeId === targetTypeId).flatMap(menu => menu.groups)].map(group => group.id));
    for (const group of groups) if (taken.has(group.id)) throw new Error(`Menu group already exists on ${targetTypeId}: ${group.id}`);
    this.menus.push({ owner, targetTypeId, groups: Object.freeze(structuredClone([...groups])) });
  }

  registerSettings(owner: string, section: SettingsSection) {
    if (this.sections.has(owner)) throw new Error(`Settings already registered: ${owner}`);
    for (const field of Object.values(section.fields)) {
      if (field.kind === 'directory' || field.optionsSource || field.fromProject) throw new Error('Plugin settings use plain text, url, number, boolean, select and multiselect fields');
      if (field.kind === 'multiselect' && (!field.options?.length || !Array.isArray(field.default) || !validateFields({ value: field }, { value: [...field.default] }))) throw new Error('Multiselect settings need options and a default list chosen from them');
      if (field.kind !== 'multiselect' && typeof field.default === 'object') throw new Error('Only multiselect settings take a list as their default');
      if (field.enabledBy !== undefined && section.fields[field.enabledBy]?.kind !== 'boolean') throw new Error('enabledBy names a boolean field of the same settings section');
    }
    const { validate, ...data } = section;
    this.sections.set(owner, Object.freeze(structuredClone(data)));
    if (validate) this.validators.set(owner, validate);
  }

  /** Saved plugin settings with declared defaults; unknown owners and fields are kept as saved. */
  pluginSettings(saved: Readonly<Record<string, JsonObject>> = {}): Record<string, JsonObject> {
    const result: Record<string, JsonObject> = structuredClone({ ...saved });
    for (const [owner, section] of this.sections) result[owner] = { ...fieldDefaults(section.fields), ...saved[owner] };
    return result;
  }

  /** Throws when a registered package's saved settings do not match its declared fields. */
  validatePluginSettings(saved: Readonly<Record<string, JsonObject>>) {
    for (const [owner, section] of this.sections) {
      if (!saved[owner]) continue;
      if (!validateFields(section.fields, saved[owner])) throw new Error(`${section.label} settings are invalid.`);
      try { this.validators.get(owner)?.({ ...fieldDefaults(section.fields), ...saved[owner] }); }
      catch (error) { throw new Error(`${section.label} settings are invalid: ${(error as Error).message}`); }
    }
  }

  register(plugin: ResourcePluginDefinition): void {
    if (!/^[a-z][a-z0-9-]*\.[a-z][a-z0-9.-]*$/.test(plugin.id)) {
      throw new Error('Use a namespaced plugin id, e.g. github.pull-request');
    }
    if (plugin.apiVersion !== 1) throw new Error('Unsupported plugin API version');
    if (!Number.isSafeInteger(plugin.schemaVersion) || plugin.schemaVersion < 1) {
      throw new Error('Plugin schemaVersion must be a positive integer');
    }
    if (this.plugins.has(plugin.id)) throw new Error(`Plugin already registered: ${plugin.id}`);
    if (plugin.mapSizes) {
      const { sizes, defaultSize } = plugin.mapSizes;
      if (!['small', 'medium', 'large'].includes(defaultSize) || !sizes[defaultSize]) throw new Error('Map sizes need a supported default');
      for (const [size, preset] of Object.entries(sizes)) {
        if (!['small', 'medium', 'large'].includes(size) || !preset || !Number.isInteger(preset.width) || preset.width < 32 || preset.width > 640
          || !Number.isInteger(preset.height) || preset.height < 24 || preset.height > 480
          || !Number.isInteger(preset.summaryLines) || preset.summaryLines < 0 || preset.summaryLines > 6
          || typeof preset.description !== 'string' || !preset.description.trim()
          || (preset.fieldLines !== undefined && (!Number.isInteger(preset.fieldLines) || preset.fieldLines < 0 || preset.fieldLines > 6))
          || preset.fields?.some(key => !plugin.fields?.[key])) throw new Error('Invalid map size preset');
      }
    }
    if (plugin.generatedTitle) {
      const field = plugin.fields?.[plugin.generatedTitle.field];
      if (!field || field.kind !== 'text' || !field.required) throw new Error('Generated titles need a required text field');
    }
    const cardinality = plugin.relationships?.cardinality ?? 'many';
    if (!['one', 'many'].includes(cardinality)) throw new Error('Relationship cardinality must be one or many');
    const sources = new Set<number>();
    for (const migration of plugin.migrations ?? []) {
      if (!Number.isSafeInteger(migration.fromVersion) || !Number.isSafeInteger(migration.toVersion)
        || migration.fromVersion < 1 || migration.toVersion <= migration.fromVersion
        || migration.toVersion > plugin.schemaVersion || sources.has(migration.fromVersion)
        || typeof migration.migrate !== 'function') throw new Error('Plugin migrations need unique increasing version steps');
      sources.add(migration.fromVersion);
    }
    this.plugins.set(plugin.id, Object.freeze({ ...plugin, migrations: Object.freeze([...(plugin.migrations ?? [])].map(step => Object.freeze({ ...step }))), relationships: Object.freeze({ cardinality }) }));
  }

  list(): ResourcePluginDefinition[] {
    return [...this.plugins.values()];
  }

  get(id: string) { return this.plugins.get(id); }

  /** Serializable contracts for both the browser and coding agents. */
  describe() {
    return this.list().map(({ validateData, matchInput, providerIdentity, attachTitle: _attachTitle, migrations, ...metadata }) => {
      const menus = this.menus.filter(menu => menu.targetTypeId === metadata.id).flatMap(menu => menu.groups);
      const settingsSections = [...this.sections].filter(([, section]) => section.typeId === metadata.id).map(([owner, section]) => ({ owner, ...section }));
      return {
        ...metadata, ...(menus.length ? { contextMenu: [...(metadata.contextMenu ?? []), ...menus] } : {}),
        ...(settingsSections.length ? { settingsSections } : {}),
        ...(this.migrationErrors.has(metadata.id) ? { migrationError: this.migrationErrors.get(metadata.id) } : {}), ...(metadata.fields ? { dataSchema: fieldsSchema(metadata.fields) } : {}),
        canMatchInput: Boolean(matchInput),
      };
    });
  }

  creationTypes() { return this.describe().filter(plugin => plugin.creation); }

  /** Compare identities, never display titles. Account bindings are part of the
   * key, so separate accounts cannot silently replace each other's resources. */
  identity(resource: ResourceRecord): string | undefined {
    const resolved = this.resolve(resource);
    if (!resolved.available || !resolved.plugin.providerIdentity) return undefined;
    const key = resolved.plugin.providerIdentity(resource.data, resource);
    if (key === undefined) return undefined; // Legacy/unverified records have no provider identity yet.
    if (!key || key.length > 1000) throw new Error('Plugin returned an invalid provider identity');
    return JSON.stringify([resource.pluginId, resource.connectionId ?? '', key]);
  }

  createRecord(pluginId: string, id: string, draft: Omit<ResourceDraft, 'title'> & { title?: string }): ResourceRecord {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) throw new Error('Plugin is not installed');
    if (!plugin.creation) throw new Error('This item is created by its provider, not the inline form');
    const title = draft.title === undefined ? localItemTitle(plugin, draft.data) : draft.title.trim();
    if (!id.trim() || !title) throw new Error('Resource id and title are required');
    if (!plugin.validateData(draft.data)) throw new Error('Resource data is invalid');
    return { id, pluginId, schemaVersion: plugin.schemaVersion, title, data: structuredClone(draft.data) };
  }

  matchInput(input: string): AttachmentCandidate[] {
    const candidates: AttachmentCandidate[] = [];
    for (const plugin of this.plugins.values()) {
      const draft = plugin.matchInput?.(input.trim());
      if (draft && plugin.validateData(draft.data)) {
        candidates.push({ ...draft, pluginId: plugin.id, schemaVersion: plugin.schemaVersion });
      }
    }
    // Keep every match. The UI asks the user to choose if several plugins match.
    return candidates;
  }

  /** Specific URL plugins win over generic links, regardless of connection status.
   * Equally specific matches remain explicit choices rather than depending on order. */
  matchUrl(input: string): AttachmentCandidate[] {
    if (!isResourceUrl(input)) return [];
    const matches = this.matchInput(input).filter(candidate => this.get(candidate.pluginId)?.creation?.mode === 'url');
    const specific = matches.filter(candidate => !this.get(candidate.pluginId)?.creation?.urlFallback);
    return specific.length ? specific : matches;
  }

  /** The saved URL of a generic link item (`creation.urlFallback`); undefined for every other type. */
  linkUrl(resource: ResourceRecord): string | undefined {
    const plugin = this.plugins.get(resource.pluginId);
    const url = plugin?.creation?.urlFallback && plugin.creation.mode === 'url' ? resource.data[plugin.activation?.urlField ?? 'url'] : undefined;
    return typeof url === 'string' ? url : undefined;
  }

  /** The more specific URL types for an item saved as a generic link (`creation.urlFallback`),
   * e.g. a web link added before its provider's URLs were recognised. Syntax only; nothing is fetched. */
  conversions(resource: ResourceRecord): AttachmentCandidate[] {
    const url = this.linkUrl(resource);
    if (url === undefined) return [];
    return this.matchUrl(url).filter(candidate => candidate.pluginId !== resource.pluginId && !this.plugins.get(candidate.pluginId)?.creation?.urlFallback);
  }

  /** Backend-only startup diagnostics; descriptions carry text, never callbacks. */
  setMigrationError(pluginId: string, message: string) { this.migrationErrors.set(pluginId, message); }

  /** Why an item type is not registered, shown on its preserved items instead of the generic reason. */
  setUnavailableReason(typeId: string, reason: string) { if (!this.plugins.has(typeId)) this.unavailableReasons.set(typeId, reason); }
  unavailable(): Record<string, string> { return Object.fromEntries(this.unavailableReasons); }

  /** Takes back the types, menus and settings a package registered, e.g. when its service code
   * fails to start. Its saved items stay and resolve as unavailable with `reason`. */
  withdraw(owner: string, typeIds: readonly string[], reason: string) {
    for (const typeId of typeIds) { this.plugins.delete(typeId); this.unavailableReasons.set(typeId, reason); }
    this.menus = this.menus.filter(menu => menu.owner !== owner && !typeIds.includes(menu.targetTypeId));
    this.sections.delete(owner); this.validators.delete(owner);
  }

  migrationPath(resource: ResourceRecord) {
    const plugin = this.plugins.get(resource.pluginId);
    if (!plugin || resource.schemaVersion >= plugin.schemaVersion) return [];
    const path: NonNullable<ResourcePluginDefinition['migrations']>[number][] = [];
    let version = resource.schemaVersion;
    while (version < plugin.schemaVersion) {
      const step = plugin.migrations?.find(step => step.fromVersion === version);
      if (!step) return [];
      path.push(step); version = step.toVersion;
    }
    return path;
  }

  /** Pure preparation only. The service backs up and commits all records of a
   * plugin atomically. Downgrades/missing paths never rewrite saved data. */
  migrate(resource: ResourceRecord): ResourceRecord {
    const steps = this.migrationPath(resource); if (!steps.length) return structuredClone(resource);
    let data = structuredClone(resource.data);
    for (const step of steps) data = z.record(z.string(), z.json()).parse(step.migrate(structuredClone(data)));
    const result = { ...structuredClone(resource), schemaVersion: steps.at(-1)!.toVersion, data };
    if (!this.resolve(result).available) throw new Error('Plugin migration produced invalid data');
    return result;
  }

  resolve(resource: ResourceRecord): ResolvedResource {
    const plugin = this.plugins.get(resource.pluginId);
    if (!plugin) return { available: false, resource, reason: this.unavailableReasons.get(resource.pluginId) ?? 'Plugin is not installed' };
    if (resource.schemaVersion !== plugin.schemaVersion) {
      return { available: false, resource, reason: this.migrationErrors.get(resource.pluginId) ?? (resource.schemaVersion > plugin.schemaVersion ? 'Resource was saved by a newer plugin; its data is preserved' : 'Resource needs a schema migration') };
    }
    if (!plugin.validateData(resource.data)) {
      return { available: false, resource, reason: 'Resource data is invalid' };
    }
    return { available: true, resource, plugin };
  }
}
