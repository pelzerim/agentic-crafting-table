import type { AttentionReason } from '../graph/attention.ts';
import type { ResourceIndicator } from './indicators.ts';
import type { ViewContribution } from '../../packages/plugin-sdk/host.ts';
export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;
export type JsonObject = { [key: string]: JsonValue };
export type ViewMode = 'inspector' | 'focus';
export type MapSize = 'small' | 'medium' | 'large';
export interface MapSizePreset {
  width: number; height: number;
  /** Optional compact floor, independent of the preferred default height. */
  minHeight?: number;
  summaryLines: number;
  fields?: readonly string[];
  fieldLines?: number;
  showType?: boolean;
  iconOnly?: boolean;
  /** Dotted data path to at most 24 `{ tone, style }` pips drawn above the summary. */
  pips?: string;
  /** Height follows the wrapped text of `field` between `min` and `max` lines; a stored
   * height never overrides it. `footerField` reserves one more line while present. */
  growLines?: { field: string; min: number; max: number; footerField?: string };
  description: string;
}
export interface MapSizeProfile { defaultSize: MapSize; sizes: Partial<Record<MapSize, MapSizePreset>> }

/** The host supplies theme-aware colors and geometry; plugins select stable type cues. */
export interface ResourceAppearance {
  /** Relative map prominence, independent of the expanded view dimensions. */
  size?: 'icon' | 'tiny' | 'small' | 'medium' | 'large';
  /** Expose the type icon as an explicit, keyboard-accessible open control. */
  openFromIcon?: boolean;
  /** Optional neighborhood card width; overview dots and focus views ignore it. */
  width?: number;
  /** Keep an identifier and full title on a compact resource card, e.g. a Linear ticket. */
  showFullTitle?: boolean;
  /** Clicking visible title text edits the local title without entering focus view. */
  editableTitle?: boolean;
  /** Optional icon driven by the host node's completion state. */
  completedIcon?: string;
  /** The map card's type icon is a checkbox that marks the item done or reopens it. */
  completionToggle?: boolean;
  /** The brand colours the type icon instead of replacing it with the brand mark. */
  brandTint?: boolean;
  /** The card face is the item's text on a paper tile; `paperField` names the
   * optional paper colour. Colour is decoration and never encodes status. */
  paper?: { textField: string; paperField?: string };
  tone: 'neutral' | 'mint' | 'teal' | 'violet' | 'blue' | 'rose' | 'stone' | 'copper';
  shape: 'rounded' | 'folder' | 'terminal' | 'branch' | 'document' | 'server' | 'ticket' | 'artifact';
}

/** Persist resources independently of projects so one resource can be shared. */
export interface ResourceRecord {
  id: string;
  pluginId: string;
  schemaVersion: number;
  title: string;
  connectionId?: string;
  data: JsonObject;
}

export interface ProjectAttachment {
  id: string;
  /** Omitted for a floating canvas item; assigned when dropped near a project. */
  projectId?: string;
  resourceId: string;
  position: { x: number; y: number };
}

export interface ResourceDraft {
  title: string;
  data: JsonObject;
}

/** One description drives inline forms, validation and agent discovery. */
export interface ResourceField {
  label: string;
  /** `multiselect` (any of `options`, stored as a list) is for settings sections only. */
  kind: 'text' | 'url' | 'number' | 'boolean' | 'select' | 'multiselect' | 'directory';
  required?: boolean;
  description?: string;
  multiline?: boolean;
  /** Initial height of a multiline editor; no effect on stored text or validation. */
  rows?: number;
  /** Example shown in an empty text field; never stored. */
  placeholder?: string;
  options?: readonly string[];
  optionLabels?: Readonly<Record<string, string>>;
  optionsSource?: string;
  dependsOn?: string;
  default?: string | number | boolean | readonly string[];
  /** Settings: unavailable while this boolean field of the same section is off. */
  enabledBy?: string;
  /** Settings: shown under a multiselect while nothing is selected. */
  emptyHint?: string;
  fromProject?: 'workingDirectory';
  integer?: boolean;
  min?: number;
  max?: number;
  pattern?: string;
}
export type ResourceFields = Readonly<Record<string, ResourceField>>;

/** Shared, credential-free registration metadata and input parsing. */
/** Trusted synchronous data upgrades. Identity, title, links and layout are host-owned. */
export interface ResourceDataMigration {
  fromVersion: number;
  toVersion: number;
  migrate(data: JsonObject): JsonObject;
}

export interface ResourcePluginDefinition {
  id: string;
  apiVersion: 1;
  schemaVersion: number;
  name: string;
  icon: string;
  /** Host-resolved brand asset; icon remains the fallback. Provider keys are lowercase. */
  brand?: string;
  providerBrands?: Readonly<Record<string, string>>;
  /** Optional type identity. Activity/attention badges remain host-owned and separate. */
  appearance?: ResourceAppearance;
  /** Declarative map tiers, independent of expanded content dimensions. */
  mapSizes?: MapSizeProfile;
  /** The pipeline this type is counted in by project headers (e.g. PRs), or the
   * tally that far-zoom dashboards count by state (e.g. tickets). */
  overview?: { pipeline?: { singular: string; plural: string }; tally?: { singular: string; plural: string } };
  /** Short purpose and usage guidance for the item settings page. */
  settingsHelp?: string;
  preferredView: ViewMode;
  /** Expansion policy and settings subgroups. Keys remain stable across renames. */
  /** `minWidth` is the narrowest the expanded view may be resized to (a window narrower still wins). */
  view?: { mode?: 'inline' | 'card' | 'focus'; width?: number; height?: number; minWidth?: number; frameTitle?: string;
    /** Short reference placed before the title where space is tight, e.g. `#{number}`. */
    reference?: string;
    variants?: { field: string; options: Readonly<Record<string, string>> } };
  /** Direct browser navigation instead of opening an inspector or focus view. */
  activation?: { kind: 'browser'; urlField: string };
  /** Exposes a context-input handle. Session delivery is owned by the host. */
  acceptsContext?: boolean;
  /** Safe saved facts and an optional parent-node field for hierarchical agent
   * context. No provider-specific traversal branches belong in the graph/transport. */
  context?: { parentField?: string; fields?: readonly string[] };
  /** Optional, short map-menu groups. Handlers live in the frontend plugin and
   * dispatch existing service actions; showing a menu never executes them. */
  contextMenu?: readonly ResourceMenuGroup[];
  /** Retained for saved plugin descriptions and ignored. Whether opening an item marks
   * its Needs me entry seen is the user's choice per item type (`notifications.seenOnOpen`). */
  manualAcknowledge?: boolean;
  /** Existing provider items may also participate in the local task list. */
  todoSupport?: boolean;
  /** Number of distinct items this resource may connect to, across both link kinds and directions. */
  relationships?: { cardinality: 'one' | 'many' };
  fields?: ResourceFields;
  /** The host records the agent that last changed the item's text in `field` as
   * `{ kind: 'agent', name, at }`, removes it when a person rewrites the text, and
   * never takes it from command data. */
  authorship?: { field: string };
  /** Text-first items derive an immediate title, then request a short AI title. */
  generatedTitle?: { field: string };
  /** Session items named from their activity while their title is one of these defaults or generated. */
  activityTitle?: { defaults: readonly string[] };
  /** Provider items named once from this evidence when first attached; never on refresh.
   * Runs only in the trusted backend registry. */
  attachTitle?: { evidence: (snapshot: ResourceSnapshot) => { kind: string; text: string } | undefined };
  /** Omit for provider-created outputs that should not appear in Add item. */
  /** `hotkey` picks the type with one letter while the creation ring is open. */
  creation?: { label: string; shortLabel?: string; hotkey?: string; labelByField?: { field: string; labels: Readonly<Record<string, string>> }; titleLabel?: string; mode?: 'fields' | 'url'; urlFallback?: boolean; group?: 'url'; urlPlaceholder?: string; requires?: 'runtime'; action?: string; fields?: ResourceFields; resume?: boolean };
  matchInput?: (input: string) => ResourceDraft | undefined;
  /** Stable provider identity within one connection. Runs only in the trusted
   * backend registry; omitted from the serialized renderer/MCP description. */
  providerIdentity?: (data: JsonObject, resource: ResourceRecord) => string | undefined;
  /** The item's page on its provider's website, offered as "Open on …" in its menu. The
   * template's {field} parts are filled from the item's data (serializable for the renderer);
   * a list uses the first template whose fields are all present. */
  webLink?: { label: string; template: string | readonly string[] };
  /** Account adapter used for authenticated content. No credentials in records. */
  connectionProvider?: string;
  migrations?: readonly ResourceDataMigration[];
  validateData: (data: JsonObject) => boolean;
}

/** Activity and attention are separate: work can continue while review is due. */
export interface ResourceSnapshot {
  /** Backend-verified canonical payload and old payload identities for provider
   * renames. The host validates these with the same plugin/account before merging. */
  resolution?: { data: JsonObject; aliases: JsonObject[] };
  /** Authoritative provider title; never infer it from a URL slug or status label. */
  title?: string;
  activity: 'working' | 'idle' | 'complete' | 'unknown';
  attention: 'none' | 'input' | 'review' | 'error';
  connection: 'connected' | 'disconnected' | 'unknown';
  label: string;
  observedAt: string;
  /** Bounded, provider-validated display content. Never interpreted as HTML. */
  detail?: JsonObject;
  stale?: boolean;
  error?: string;
  /** The current assignment cycle, for `resource.viewed`. Item views never send it on open. */
  attentionReceipt?: JsonObject;
  /** Small host-rendered provider cues, independent of unread attention. */
  indicators?: ResourceIndicator[];
  /** Independent provider review attention; omitted by connectors that do not own it. */
  attentionReason?: AttentionReason | null;
  /** Short plain-text reason for a raised `attentionReason`, shown in Needs me (e.g. "Job needs approval"). */
  attentionNote?: string;
  /** Stable provider event, so a new run can alert even if its state matches the last. */
  attentionEventId?: string;
  /** Provider items this observation found (e.g. a merged PR's rollouts). The host
   * attaches each key once next to the source item; a deleted one is not re-added. */
  discovered?: { key: string; pluginId: string; title: string; data: JsonObject }[];
  /** Longest wait before the host's next background read while the provider state
   * is expected to change soon; otherwise unchanged observations poll less often. */
  pollWithinMs?: number;
  /** The provider considers the item finished. A change mirrors onto the map's Mark done. */
  done?: boolean;
  /** Supplemental description only; never a source of lifecycle or attention state. */
  activitySummary?: { text: string; revision: string; generatedAt: string; model?: string };
  /** Set by the host while it shows a person's change before the provider confirms it ("Merged · confirming"). */
  pending?: string;
  /** Set by the host when the person's last change did not go through and was taken back. */
  reverted?: { requestId: string; message: string };
}

/** What a person sees at once while an action's write runs in the background. */
export interface ResourceOptimism {
  /** The snapshot as the write is expected to leave it. */
  snapshot: ResourceSnapshot;
  /** The expected state, marked as not yet confirmed ("Merged · confirming"). */
  pending: string;
  /** Names the change in a notice when it did not go through ("Merge of #42"). */
  subject: string;
  /** Whether a provider read shows the change; undefined when that read cannot tell. */
  landed(read: ResourceSnapshot): boolean | undefined;
}

export interface ResourceAction {
  id: string;
  label: string;
  description?: string;
  inputFields?: ResourceFields;
  readOnly?: boolean;
  /** Requires a person's confirmation in the app; agent tools refuse it. */
  humanOnly?: boolean;
  /** Explicit durable mutation returning a confirmed snapshot for map/cache sync. */
  updatesSnapshot?: boolean;
  /** While the item has unresolved blockers, choices from this read-only action
   * name them and read “… anyway”; this write then needs that acknowledgement. */
  heedsBlockers?: boolean;
  /** Invoked by the host when a person marks the item done or reopens it (input `done`
   * "true"/"false" and `restore`, the state it returns `restore` for); never directly. */
  completion?: boolean;
  /** For an `updatesSnapshot` write: the result to show at once from the saved snapshot. The host
   * then runs the write in the background and reconciles with the next read; omitted, it waits. */
  optimistic?(snapshot: ResourceSnapshot, input: JsonObject): ResourceOptimism | undefined;
}

export interface SkillContext {
  resourceId: string;
  title: string;
  content: string;
  sourceUrl?: string;
}

/** Implement in the backend; provider clients and credentials stay there. */
export interface ResourceOptions { options: string[]; default: string; labels?: Record<string, string> }
export interface ResourcePluginConnector {
  /** Backend discovery for a declared creation field; values contain no credentials. */
  creationOptions?(field: string, values: JsonObject, signal: AbortSignal): Promise<ResourceOptions>;
  /** Opt into the host’s account-aware, durable-cache background reads. */
  pollIntervalMs?: number;
  /** `background` is set for the host's own polling, not for reads a person asked for. */
  load(resource: ResourceRecord, signal: AbortSignal, options?: { background?: boolean }): Promise<ResourceSnapshot>;
  watch?(
    resource: ResourceRecord,
    emit: (snapshot: ResourceSnapshot) => void,
    signal: AbortSignal,
  ): Promise<void>;
  actions?(resource: ResourceRecord): ResourceAction[];
  execute?(resource: ResourceRecord, actionId: string, signal: AbortSignal, input?: JsonObject): Promise<JsonValue | void>;
  getContext?(resource: ResourceRecord, signal: AbortSignal): Promise<SkillContext>;
}

export interface MountedResourceView {
  update(snapshot: ResourceSnapshot): void;
  setActive?(active: boolean): void;
  dispose(): void;
}

export interface AgentPromptStatus { state: 'none' | 'queued' | 'acknowledged' | 'unavailable'; message: string }
export interface NativeTerminalOptions {
  resume?(): Promise<void>; resumeLabel?: string; resumeWhenStopped?: boolean; launchLabel?: string;
  /** Opening a view of an ended session starts a new one through `resume` instead of replaying the old output.
   * An archived session or one whose recording was deleted stays as it is; `resume` remains the explicit start. */
  startWhenStopped?: boolean;
  agentMenu?: boolean;
  /** Names the agent when stopping a working turn asks for confirmation. */
  agentName?: string;
  /** Keep the session controls above the terminal instead of in the expanded frame's title bar. */
  inlineToolbar?: boolean;
  prompt?(operation: 'queue' | 'status'): Promise<AgentPromptStatus>;
}

export interface RelatedResourceItem {
  nodeId: string; title: string; summary: string; activity: 'working' | 'idle' | 'complete' | 'unknown';
  attention: 'none' | 'input' | 'review' | 'error'; typeName: string;
  resource?: ResourceRecord; parentResourceId?: string;
}

export interface ResourceViewServices {
  observePreferences?(listener: (preferences: JsonObject) => void): () => void;
  copyUrl?(url: string): Promise<unknown>;
  /** Current direct links across aliases, excluding archived items. No provider fetch. */
  observeRelated?(listener: (items: RelatedResourceItem[]) => void): () => void;
  openResource(resourceId: string): void;
  /** Closes the view, flies the map to an item the view just put on it and selects it. */
  showOnMap?(nodeId: string): void;
  /** Open the host's existing edit form for this item, using shared commands. */
  editResource?(): void;
  /** Saves fields into this item's data with the shared item.update command; null removes a field. */
  saveData?(patch: JsonObject): Promise<void>;
  /** What the host keeps of this item's view layout, such as a folded panel. It survives reload and restart and,
   * unlike saveData, never changes the item, so it never invalidates the provider's cached read. */
  viewState?(): Readonly<Record<string, string | number | boolean>>;
  /** Saves keys of the view state; null removes one. Values are short strings, numbers or booleans. */
  saveViewState?(patch: Record<string, string | number | boolean | null>): void;
  runAction(actionId: string, input?: JsonObject): Promise<JsonValue | void>;
  /** The expanded frame's title-bar region the view may render its own controls into,
   * between the title and the close button. Hidden while the view is not expanded. */
  frameToolbar?(): HTMLElement | undefined;
  /** Opens a provider page in the browser, for links rendered outside the view body. */
  openUrl?(url: string): void;
  /** The host owns session lifetime; disposing the view only detaches its UI. */
  attachTerminal(sessionId: string, container: HTMLElement, options?: NativeTerminalOptions): { dispose(): void; setActive?(active: boolean): void };
  /** Controls other packages add to this type's views (RendererHost.contributeViews). */
  viewContributions?: readonly ViewContribution[];
}

/** Implement in the frontend. The shell decides size, navigation, and layout. */
/** Extra facts a hover preview shows beside the item's saved state and indicators. */
export interface ResourcePreview { byline?: string; updatedAt?: string; facts: { label: string; value: string; tone?: ResourceIndicator['tone'] }[] }
export interface ResourcePluginViews {
  /** Reads only saved local state (cached snapshots, receipts), never the provider. */
  preview?(resource: ResourceRecord, services: Pick<ResourceViewServices, 'runAction'>, signal: AbortSignal): Promise<ResourcePreview>;
  runContextAction?(actionId: string, resource: ResourceRecord, services: Pick<ResourceViewServices, 'runAction'>, signal: AbortSignal): Promise<{ nodeId?: string }>;
  /** Changes outside this identity update the outer card without remounting a live view. */
  identity?(resource: ResourceRecord): string;
  mountDetail(
    container: HTMLElement,
    resource: ResourceRecord,
    services: ResourceViewServices,
  ): MountedResourceView;
  mountNode?(
    container: HTMLElement,
    resource: ResourceRecord,
    services: ResourceViewServices,
  ): MountedResourceView;
}

export interface ResourceMenuGroup {
  id: string; label: string;
  children: readonly { id: string; label: string; description?: string }[];
  /** Offered to a selection of items that all have this group, as `label` with the named children only; a pick
   * runs that child once per selected item. */
  selection?: { label: string; children: readonly string[] };
  /** Provider-defined choices; loading never executes the apply action. */
  /** With `runtime`, load/apply are operations of that workspace runtime action
   * instead of provider resource actions. */
  choices?: ChoiceSource;
  /** Shown only while the boolean `settings.plugins[plugin][setting]` (or its declared default) is true. */
  when?: { plugin: string; setting: string };
}

/** `irreversible` lists Cancel first with focus and asks again before applying a picked option.
 * With `pickConfirms`, the loaded prompt is that question and picking an option answers it. */
export interface ChoiceSource { load: string; apply: string; loadingLabel?: string; runtime?: string; irreversible?: boolean; pickConfirms?: boolean }
/** Map nodes/links to highlight while an option is hovered. */
export interface ChoiceHighlight { nodes: string[]; links: string[] }
/** Picking the option asks again in place: `prompt`, then `note`, an optional free-text
 * field sent as `input[text.field]` when not blank, Back and an `action` button. */
export interface ChoiceConfirm { prompt: string; note?: string; action: string; text?: { field: string; label: string; placeholder?: string; maxLength: number } }
export interface ResourceChoices {
  /** Empty when no option is currently selected (a confirmation, not a status). */
  current: string; context: JsonObject;
  /** Optional question shown above the options. */
  prompt?: string;
  options: { id: string; label: string; description?: string; disabled?: boolean; highlight?: ChoiceHighlight; confirm?: ChoiceConfirm }[];
}

/** Native conversation metadata; never transcript contents or launch commands. */
export interface SavedSessionOption {
  id: string; title: string; cwd: string; modifiedAt: number;
  branch?: string; nodeId?: string; projectTitle?: string; unavailable?: string;
}
export interface SavedSessionPage { sessions: SavedSessionOption[]; total?: number; nextOffset?: number; nextCursor?: string }
