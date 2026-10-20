import type * as z from 'zod/v4';
import type { AttentionReason } from '../../src/graph/attention.ts';
import type {
  JsonObject, JsonValue, ResourceAction, ResourceFields, ResourceMenuGroup, ResourcePluginConnector, ResourcePluginDefinition,
  ResourcePluginViews, ResourceRecord, ResourceSnapshot, ResourceViewServices,
} from '../../src/resource-plugins/types.ts';
import type { PluginManifest } from './manifest.ts';
import type { WorkspaceControl, WorkspaceState } from '../core/control.ts';
import type { ConnectionAdapter, ProviderConnections } from '../provider-runtime/connections.ts';
import type { SqliteStore } from '../workspace-service/sqlite-store.ts';
import type { ResourceCoordinator } from '../workspace-service/resources.ts';
import type { SessionCoordinator } from '../workspace-service/sessions.ts';
import type { HostedAgents } from '../workspace-service/agents.ts';

/** How an agent may use an operation through workspace_run. A redirect names the
 * dedicated tool that performs it instead. The person in the app is never limited. */
export type AgentPolicyRule = 'allow' | 'humanOnly' | { redirect: string };
/** One rule, or a rule per `arguments.operation` value with a fallback. */
export type AgentPolicy = AgentPolicyRule | { operations: Readonly<Record<string, AgentPolicyRule>>; otherwise: AgentPolicyRule };
export interface RuntimeOperationDeclaration { id: string; description?: string; agentPolicy?: AgentPolicy }

export interface RuntimeOperationContext {
  nodeId: string;
  /** Present unless the operation was registered with `requiresNode: false`. */
  node?: WorkspaceState['nodes'][number];
  resource?: ResourceRecord;
  arguments: JsonObject;
  signal: AbortSignal;
  /** Runs a write under the lifecycle gate that holds back work during shutdown and recovery. */
  execute<T>(work: () => Promise<T>): Promise<T>;
}
export type RuntimeOperationHandler = (context: RuntimeOperationContext) => Promise<unknown> | unknown;
export interface RuntimeOperationOptions { requiresNode?: boolean }

/** An MCP tool that forwards one validated request to a runtime operation. */
export interface McpToolContribution {
  name: string;
  description: string;
  inputSchema: z.ZodObject<z.ZodRawShape>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
  /** Refusal shown when the calling client is not an agent launched from the table. */
  requiresAgent?: string;
  request(input: JsonObject, binding: { agentNodeId?: string; projectId?: string; workspaceId?: string }): { action: string; nodeId: string; arguments: JsonObject };
}

/** Text appended to the shared agent guide, in package order. */
export interface AgentGuideSnippet { id: string; text: string }

/** Settings stored under `settings.plugins[<package id>]`, shown on the named item type's settings page.
 * `connectionHint` is shown there while the type's account provider has no connected account. */
export interface PluginSettingsSection { typeId: string; label: string; description?: string; connectionHint?: string; fields: ResourceFields;
  /** Runs where settings are saved, after the field checks; throw with a reason to refuse values that do not make sense together. */
  validate?(values: JsonObject): void }

/** Values for another package's settings that workspaces relied on before those settings existed.
 * Applied once per workspace, only to settings saved before package settings; a value the person
 * changed from its declared default is kept. */
export interface SettingsPreset { id: string; packageId: string; values: JsonObject }

/** Map-menu groups added to another package's item type. */
export interface ActionMenuContribution { targetTypeId: string; groups: readonly ResourceMenuGroup[] }

/** Shared, platform-neutral entry: loaded by the service, the MCP bridge and the renderer. */
export interface PluginDefinitionsModule {
  definitions?: readonly ResourcePluginDefinition[];
  runtimeOperations?: readonly RuntimeOperationDeclaration[];
  mcpTools?: readonly McpToolContribution[];
  agentGuide?: readonly AgentGuideSnippet[];
  settings?: PluginSettingsSection;
  actionMenus?: readonly ActionMenuContribution[];
  settingsPresets?: readonly SettingsPreset[];
}
export interface PluginPackage { manifest: PluginManifest; module: PluginDefinitionsModule }

/** Actions a package adds to another package's type. Ids must not shadow the target's own. */
export interface ActionContribution {
  actions(resource: ResourceRecord): ResourceAction[];
  execute(resource: ResourceRecord, actionId: string, signal: AbortSignal, input?: JsonObject): Promise<JsonValue | void>;
}

/** Local overlays computed from a saved snapshot; never a provider read. */
export interface PresentationHooks {
  indicators?(resource: ResourceRecord, snapshot: ResourceSnapshot, store: SqliteStore): ResourceSnapshot['indicators'];
  /** Raises or clears Needs me under `source`, independent of the provider's own attention. */
  attention?(resource: ResourceRecord, snapshot: ResourceSnapshot, store: SqliteStore): { source: string; reason: AttentionReason | null; note?: string; eventId?: string } | undefined;
  /** The person opened the item's provider page from the app (its web link). Record local
   * read state here; the host then repaints indicators and attention from the saved snapshot. */
  opened?(resource: ResourceRecord, snapshot: ResourceSnapshot | undefined, store: SqliteStore, now: number): void;
}

export interface PluginRecord { key: string; value: JsonValue; ordinal?: number; updatedAt: number }
/** Package-owned rows in the workspace database, backed up and migrated with it. */
export interface PluginStorage {
  get(collection: string, key: string): PluginRecord | undefined;
  put(collection: string, key: string, value: JsonValue, options?: { ordinal?: number }): PluginRecord;
  delete(collection: string, key: string): boolean;
  /** Ordered by ordinal, then key. `after` continues from the last row of a previous page. */
  list(collection: string, options?: { after?: { ordinal?: number; key: string }; limit?: number }): PluginRecord[];
  transaction<T>(work: () => T): T;
}

/** The trusted services first-party code uses. Available once the workspace has started. */
export interface WorkspaceServices {
  directory: string;
  store: SqliteStore;
  control: WorkspaceControl;
  resources: ResourceCoordinator;
  terminals?: SessionCoordinator;
  /** Absent when the service runs without native sessions. */
  agents?: HostedAgents;
  storage: PluginStorage;
  broadcast(): Promise<void>;
  /** False while background work is held back (shutdown, recovery, sleep). */
  allowed(): boolean;
  execute<T>(work: () => Promise<T>): Promise<T>;
}
/** Hooks run at the host's matching lifecycle points, in package order. */
export interface PluginLifecycle {
  /** After every committed workspace change. */
  observe?(): void;
  /** Background work may begin (after startup and after recovery). */
  start?(): void;
  /** Background work must stop until the next start. */
  pause?(): Promise<void> | void;
  /** The service is closing. */
  close?(): Promise<void> | void;
}

export interface ServiceHost {
  readonly api: string;
  readonly pluginId: string;
  readonly paths: { dataDirectory?: string; socketDirectory?: string };
  /** Saved account bindings; absent when the service runs without providers or its caller supplies the connectors. */
  readonly connections?: ProviderConnections;
  connector(typeId: string, connector: ResourcePluginConnector): void;
  contributeActions(targetTypeId: string, contribution: ActionContribution): void;
  connectionProvider(adapter: ConnectionAdapter): void;
  presentation(typeId: string, hooks: PresentationHooks): void;
  runtimeOperation(id: string, handler: RuntimeOperationHandler, options?: RuntimeOperationOptions): void;
  /** This package's saved settings with declared defaults filled in. */
  settings(): JsonObject;
  onClose(close: () => Promise<void>): void;
  onWorkspace(ready: (workspace: WorkspaceServices) => PluginLifecycle | void): void;
}
/** Installed packages may finish activating asynchronously, within the host's activation timeout. */
export interface ServiceModule { activate(host: ServiceHost): void | Promise<void> }

/** Controls a package adds to another package's views. */
export interface HeaderActionContext {
  document: Document;
  resource: ResourceRecord;
  services: ResourceViewServices;
  /** Reloads the hosting view from the provider. */
  refresh(): Promise<void>;
  notify(message: string): void;
  isActive(): boolean;
}
export interface HeaderAction {
  element: HTMLElement;
  /** `current` is false for a saved copy or stale snapshot that must not drive writes. */
  update(state: { snapshot?: ResourceSnapshot; current: boolean }): void;
  close?(): void;
  dispose?(): void;
}
export interface ViewContribution { headerAction?(context: HeaderActionContext): HeaderAction }

export interface RendererHost {
  readonly api: string;
  readonly pluginId: string;
  views(typeId: string, views: ResourcePluginViews): void;
  contributeViews(targetTypeId: string, contribution: ViewContribution): void;
}
export interface RendererModule { activate(host: RendererHost): void }
