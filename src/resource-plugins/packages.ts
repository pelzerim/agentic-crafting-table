import { parsePluginManifest } from '../../packages/plugin-sdk/manifest.ts';
import type { PluginManifest } from '../../packages/plugin-sdk/manifest.ts';
import type { AgentGuideSnippet, McpToolContribution, PluginDefinitionsModule, PluginPackage, RuntimeOperationDeclaration, SettingsPreset } from '../../packages/plugin-sdk/host.ts';
import { ResourcePluginRegistry } from './registry.ts';
import { fieldDefaults } from './define.ts';

const difference = (left: readonly string[], right: readonly string[]) => left.filter(id => !right.includes(id));
function sameIds(pluginId: string, kind: string, declared: readonly string[], registered: readonly string[]) {
  const missing = difference(declared, registered), undeclared = difference(registered, declared);
  if (missing.length) throw new Error(`Plugin ${pluginId} declares ${kind} it does not provide: ${missing.join(', ')}`);
  if (undeclared.length) throw new Error(`Plugin ${pluginId} provides ${kind} its manifest does not declare: ${undeclared.join(', ')}`);
}

/** Every package — bundled first-party or loaded later — enters through this one path. The
 * manifest is the declared surface; what the module registers must match it exactly. */
export class PluginPackageRegistry {
  readonly types: ResourcePluginRegistry;
  private packages = new Map<string, PluginPackage>();
  private owners = new Map<string, string>();
  constructor(types = new ResourcePluginRegistry()) { this.types = types; }

  register(input: { manifest: unknown; module: PluginDefinitionsModule }): PluginPackage {
    const manifest = parsePluginManifest(input.manifest), module = input.module, contributes = manifest.contributes;
    if (this.packages.has(manifest.id)) throw new Error(`Plugin already registered: ${manifest.id}`);
    const definitions = module.definitions ?? [];
    sameIds(manifest.id, 'item types', contributes.itemTypes, definitions.map(definition => definition.id));
    sameIds(manifest.id, 'runtime operations', contributes.runtimeOperations, (module.runtimeOperations ?? []).map(operation => operation.id));
    sameIds(manifest.id, 'MCP tools', contributes.mcpTools, (module.mcpTools ?? []).map(tool => tool.name));
    sameIds(manifest.id, 'agent guide snippets', contributes.agentGuide, (module.agentGuide ?? []).map(snippet => snippet.id));
    sameIds(manifest.id, 'settings pages', contributes.settingsPages, module.settings ? [module.settings.typeId] : []);
    for (const menu of module.actionMenus ?? []) {
      const actions = contributes.actionContributions[menu.targetTypeId];
      if (!actions) throw new Error(`Plugin ${manifest.id} adds a menu to ${menu.targetTypeId} without declaring actions for it`);
      for (const group of menu.groups) {
        const used = [...group.children.map(child => child.id), ...(group.choices && !group.choices.runtime ? [group.choices.load, group.choices.apply] : [])];
        const unknown = difference(used, actions);
        if (unknown.length) throw new Error(`Plugin ${manifest.id} menu ${group.id} uses undeclared actions: ${unknown.join(', ')}`);
        if (group.when && group.when.plugin !== manifest.id) throw new Error(`Plugin ${manifest.id} menu ${group.id} depends on another package's settings`);
      }
    }
    sameIds(manifest.id, 'settings presets', contributes.settingsPresets, (module.settingsPresets ?? []).map(preset => preset.id));
    for (const preset of module.settingsPresets ?? []) this.checkSettingsPreset({ ...preset, owner: manifest.id });
    const taken = this.list().flatMap(other => [...other.manifest.contributes.runtimeOperations, ...other.manifest.contributes.mcpTools, ...other.manifest.contributes.agentGuide, ...other.manifest.contributes.accountTypes]);
    const clashes = [...contributes.runtimeOperations, ...contributes.mcpTools, ...contributes.agentGuide, ...contributes.accountTypes].filter(id => taken.includes(id));
    if (clashes.length) throw new Error(`Plugin ${manifest.id} redeclares identifiers of another plugin: ${clashes.join(', ')}`);
    for (const definition of definitions) if (this.types.get(definition.id)) throw new Error(`Plugin already registered: ${definition.id}`);
    for (const definition of definitions) { this.types.register(definition); this.owners.set(definition.id, manifest.id); }
    if (module.settings) this.types.registerSettings(manifest.id, module.settings);
    for (const menu of module.actionMenus ?? []) this.types.contributeMenus(manifest.id, menu.targetTypeId, menu.groups);
    const entry = Object.freeze({ manifest, module });
    this.packages.set(manifest.id, entry);
    return entry;
  }

  list(): PluginPackage[] { return [...this.packages.values()]; }
  get(id: string): PluginPackage | undefined { return this.packages.get(id); }
  /** The package that registered an item type. */
  ownerOf(typeId: string): string | undefined { return this.owners.get(typeId); }
  manifests(): PluginManifest[] { return this.list().map(entry => entry.manifest); }
  runtimeOperations(): (RuntimeOperationDeclaration & { owner: string })[] {
    return this.list().flatMap(entry => (entry.module.runtimeOperations ?? []).map(operation => ({ ...operation, owner: entry.manifest.id })));
  }
  mcpTools(): McpToolContribution[] { return this.list().flatMap(entry => [...(entry.module.mcpTools ?? [])]); }
  settingsPresets(): (SettingsPreset & { owner: string })[] {
    return this.list().flatMap(entry => (entry.module.settingsPresets ?? []).map(preset => ({ ...preset, owner: entry.manifest.id })));
  }
  /** Whether a preset can apply now: false while its target package is not registered (it waits for it);
   * throws when the target has no settings, or does not declare or refuses the preset's values. */
  checkSettingsPreset(preset: SettingsPreset & { owner: string }): boolean {
    const target = this.packages.get(preset.packageId);
    if (!target) return false;
    const fields = target.module.settings?.fields;
    if (!fields) throw new Error(`Plugin ${preset.owner} preset ${preset.id}: ${preset.packageId} has no settings`);
    const unknown = difference(Object.keys(preset.values), Object.keys(fields));
    if (unknown.length) throw new Error(`Plugin ${preset.owner} preset ${preset.id} sets unknown settings of ${preset.packageId}: ${unknown.join(', ')}`);
    this.types.validatePluginSettings({ [preset.packageId]: { ...fieldDefaults(fields), ...preset.values } });
    return true;
  }
  agentGuide(): AgentGuideSnippet[] { return this.list().flatMap(entry => [...(entry.module.agentGuide ?? [])]); }
}
