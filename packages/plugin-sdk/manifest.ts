import * as z from 'zod/v4';

/** The host plugin API. A package declares the range it was built against in `apiRange`. */
export const PLUGIN_API = '1.2.0';
/** Schema version of a single item definition (`ResourcePluginDefinition.apiVersion`). */
export const PLUGIN_DEFINITION_API_VERSION = 1;

const segment = '[a-z][a-z0-9-]*';
const packageId = new RegExp(`^${segment}(\\.${segment})*$`);
const typeId = new RegExp(`^${segment}\\.[a-z][a-z0-9.-]*$`);
const identifier = z.string().min(1).max(200).regex(/^[A-Za-z][A-Za-z0-9._:-]*$/);
const entryPath = z.string().min(1).max(200).regex(/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]+$/, 'Use a relative path inside the package');
const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;

export const pluginManifestSchema = z.object({
  /** Package namespace. Every id the package registers is `<id>` or `<id>.…`, or listed in `legacyIds`. */
  id: z.string().min(1).max(100).regex(packageId, 'Use a lowercase dotted package id, e.g. acme or github.pull-request'),
  name: z.string().trim().min(1).max(100),
  version: z.string().regex(semver, 'Use a semantic version'),
  /** Caret range of the host plugin API this package was built against, e.g. ^1.0.0. */
  apiRange: z.string().regex(/^\^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/, 'Use a caret API range, e.g. ^1.0.0'),
  description: z.string().max(500).optional(),
  entries: z.object({ definitions: entryPath, service: entryPath.optional(), renderer: entryPath.optional() }).strict(),
  contributes: z.object({
    itemTypes: z.array(z.string().regex(typeId)).max(100).default([]),
    accountTypes: z.array(identifier).max(20).default([]),
    runtimeOperations: z.array(identifier).max(100).default([]),
    mcpTools: z.array(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/)).max(50).default([]),
    /** Item types whose settings page shows this package's settings section. */
    settingsPages: z.array(z.string().regex(typeId)).max(20).default([]),
    /** Actions this package adds to another package's item type, keyed by that type. */
    actionContributions: z.record(z.string().regex(typeId), z.array(identifier).min(1).max(50)).default({}),
    agentGuide: z.array(identifier).max(20).default([]),
    /** Values this package supplies for another package's settings (API 1.1; applied to every workspace since 1.2). */
    settingsPresets: z.array(identifier).max(20).default([]),
    css: z.array(entryPath.regex(/\.css$/, 'Stylesheets end in .css')).max(20).default([]),
  }).strict().default({ itemTypes: [], accountTypes: [], runtimeOperations: [], mcpTools: [], settingsPages: [], actionContributions: {}, agentGuide: [], settingsPresets: [], css: [] }),
  /** Identifiers outside the namespace this package owns because they were persisted
   * or exposed before the package existed (item types, actions, operations, tools, providers). */
  legacyIds: z.array(identifier).max(200).default([]),
}).strict();

export type PluginManifest = z.infer<typeof pluginManifestSchema>;
export type PluginManifestInput = z.input<typeof pluginManifestSchema>;

/** Parses and checks a manifest: shape, API compatibility and namespace ownership. */
export function parsePluginManifest(input: unknown, hostApi = PLUGIN_API): PluginManifest {
  const result = pluginManifestSchema.safeParse(input);
  if (!result.success) throw new Error(`Invalid plugin manifest: ${result.error.issues.map(issue => `${issue.path.join('.') || 'manifest'} ${issue.message}`).join('; ')}`);
  const manifest = result.data;
  if (!apiSatisfies(manifest.apiRange, hostApi)) throw new Error(`Plugin ${manifest.id} needs plugin API ${manifest.apiRange}; this app provides ${hostApi}.`);
  const contributes = manifest.contributes;
  const owned = [...contributes.itemTypes, ...contributes.accountTypes, ...contributes.runtimeOperations, ...contributes.mcpTools, ...contributes.agentGuide, ...contributes.settingsPresets, ...Object.values(contributes.actionContributions).flat()];
  const foreign = owned.filter(id => !ownsIdentifier(manifest, id));
  if (foreign.length) throw new Error(`Plugin ${manifest.id} contributes identifiers outside its namespace: ${[...new Set(foreign)].join(', ')}. Prefix them with ${manifest.id}. or list them in legacyIds.`);
  for (const target of Object.keys(contributes.actionContributions)) {
    if (contributes.itemTypes.includes(target)) throw new Error(`Plugin ${manifest.id} adds actions to its own type ${target}; declare them on its connector instead.`);
  }
  const duplicates = owned.filter((id, index) => owned.indexOf(id) !== index);
  if (duplicates.length) throw new Error(`Plugin ${manifest.id} declares identifiers more than once: ${[...new Set(duplicates)].join(', ')}`);
  return manifest;
}

/** `<id>`, `<id>.…`, an MCP tool `<id_with_underscores>_…`, or a declared legacy id. */
export function ownsIdentifier(manifest: Pick<PluginManifest, 'id' | 'legacyIds'>, id: string): boolean {
  const tool = manifest.id.replace(/[.-]/g, '_');
  return id === manifest.id || id.startsWith(`${manifest.id}.`) || id.startsWith(`${tool}_`) || manifest.legacyIds.includes(id);
}

/** Caret semantics: same major; at or above the range's minor/patch (0.x pins the minor). */
export function apiSatisfies(range: string, version: string): boolean {
  const wanted = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(range), actual = semver.exec(version);
  if (!wanted || !actual) return false;
  const [major, minor, patch] = wanted.slice(1, 4).map(Number), [hostMajor, hostMinor, hostPatch] = actual.slice(1, 4).map(Number);
  if (hostMajor !== major) return false;
  if (major === 0 && hostMinor !== minor) return false;
  return hostMinor > minor || (hostMinor === minor && hostPatch >= patch);
}
