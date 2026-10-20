/** Agentic Crafting Table plugin SDK, API 1. Platform-neutral: no Node or DOM imports. */
export { PLUGIN_API, PLUGIN_DEFINITION_API_VERSION, apiSatisfies, ownsIdentifier, parsePluginManifest, pluginManifestSchema } from './manifest.ts';
export type { PluginManifest, PluginManifestInput } from './manifest.ts';
export type * from './host.ts';
export type * from '../../src/resource-plugins/types.ts';
export type { ResourceIndicator } from '../../src/resource-plugins/indicators.ts';
export { defineResourcePlugin, fieldDefaults, fieldsSchema, validateFields, webLinkUrl } from '../../src/resource-plugins/define.ts';
export { indicatorsSchema } from '../../src/resource-plugins/indicators.ts';
