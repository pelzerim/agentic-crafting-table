import { fieldsSchema, validateFields } from './define.ts';
import * as z from 'zod/v4';
import type { ResourcePluginRegistry } from './registry.ts';
import type { JsonObject, ResourceAction, ResourcePluginConnector, ResourceRecord, ResourceSnapshot } from './types.ts';
import type { ActionContribution, PresentationHooks } from '../../packages/plugin-sdk/host.ts';

/** Bound the caller even if a connector ignores cancellation. Late completion is
 * consumed, never delivered; abort cannot promise to undo an external write. */
function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
    pending.then(value => { signal.removeEventListener('abort', abort); signal.aborted ? reject(signal.reason) : resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(signal.aborted ? signal.reason : error); });
    if (signal.aborted) abort();
  });
}

/** Backend dispatch. Provider clients are injected here, never into shared definitions. */
/** Agent tools refuse actions marked humanOnly; the user confirms them in the app. */
export const humanOnlyMessage = 'This action needs a person to confirm it in the app. Ask the user to do it there.';
export class ResourcePluginHost {
  readonly registry: ResourcePluginRegistry;
  private connectors = new Map<string, ResourcePluginConnector>();
  private contributions = new Map<string, { owner: string; actionIds: readonly string[]; contribution: ActionContribution }[]>();
  private closers: (() => Promise<void>)[] = [];
  private presentations = new Map<string, PresentationHooks>();
  constructor(registry: ResourcePluginRegistry) { this.registry = registry; }
  /** Provider cleanup that must finish before the service exits (e.g. draining SSH). */
  onClose(close: () => Promise<void>) { this.closers.push(close); }
  async close() { await Promise.allSettled(this.closers.map(close => close())); }

  register(pluginId: string, connector: ResourcePluginConnector) {
    if (!this.registry.get(pluginId)) throw new Error('Register the item definition first');
    if (this.connectors.has(pluginId)) throw new Error(`Connector already registered: ${pluginId}`);
    this.connectors.set(pluginId, connector);
  }

  /** Another package's actions on this type, limited to the ids its manifest declares. */
  contribute(targetTypeId: string, owner: string, actionIds: readonly string[], contribution: ActionContribution) {
    if (!this.registry.get(targetTypeId)) throw new Error('Register the item definition first');
    const entries = this.contributions.get(targetTypeId) ?? [];
    if (entries.some(entry => entry.owner === owner)) throw new Error(`Actions already contributed by ${owner}: ${targetTypeId}`);
    this.contributions.set(targetTypeId, [...entries, { owner, actionIds: [...actionIds], contribution }]);
  }

  /** Local overlays the workspace service applies to this type's saved snapshots. */
  present(pluginId: string, hooks: PresentationHooks) {
    if (!this.registry.get(pluginId)) throw new Error('Register the item definition first');
    if (this.presentations.has(pluginId)) throw new Error(`Presentation already registered: ${pluginId}`);
    this.presentations.set(pluginId, hooks);
  }
  presentation(pluginId: string) { return this.presentations.get(pluginId); }

  capabilities(pluginId: string) {
    const connector = this.connectors.get(pluginId);
    return { load: Boolean(connector), watch: Boolean(connector?.watch), actions: Boolean((connector?.actions && connector?.execute) || (connector && this.contributions.has(pluginId))), context: Boolean(connector?.getContext) };
  }

  private allActions(resource: ResourceRecord, signal: AbortSignal) {
    const own = this.connector(resource, signal).actions?.(resource) ?? [], ids = new Set(own.map(action => action.id));
    const contributed: { action: ResourceAction; contribution: ActionContribution }[] = [];
    for (const entry of this.contributions.get(resource.pluginId) ?? []) {
      for (const action of entry.contribution.actions(resource)) {
        if (!entry.actionIds.includes(action.id)) throw new Error(`${entry.owner} offers an undeclared action: ${action.id}`);
        if (ids.has(action.id)) throw new Error(`${entry.owner} cannot replace the action ${action.id}`);
        ids.add(action.id); contributed.push({ action, contribution: entry.contribution });
      }
    }
    return { own, contributed };
  }

  pollingInterval(pluginId: string) {
    const interval = this.connectors.get(pluginId)?.pollIntervalMs;
    return interval === undefined ? undefined : Math.max(60_000, interval);
  }

  private connector(resource: ResourceRecord, signal: AbortSignal) {
    signal.throwIfAborted();
    const resolved = this.registry.resolve(resource);
    if (!resolved.available) throw new Error(resolved.reason);
    const connector = this.connectors.get(resource.pluginId);
    if (!connector) throw new Error(`Connector is not connected: ${resource.pluginId}`);
    return connector;
  }

  load(resource: ResourceRecord, signal: AbortSignal, options?: { background?: boolean }) {
    return abortable(this.connector(resource, signal).load(resource, signal, options), signal).then(snapshot => {
    if (snapshot.resolution) {
      const resolution = z.object({ data: z.record(z.string(), z.json()), aliases: z.array(z.record(z.string(), z.json())).max(64) }).parse(snapshot.resolution);
      if (snapshot.connection !== 'connected' || !resource.connectionId || !this.registry.get(resource.pluginId)?.connectionProvider) throw new Error('Provider resolution requires a connected account');
      for (const data of [resolution.data, ...resolution.aliases]) {
        const candidate = { ...resource, data };
        if (!this.registry.resolve(candidate).available || !this.registry.identity(candidate)) throw new Error('Provider returned invalid canonical resource data');
      }
      // The lookup itself proves the requested identity belongs to this result.
      if (!resolution.aliases.some(data => JSON.stringify(data) === JSON.stringify(resource.data))) resolution.aliases.push(structuredClone(resource.data));
      if (resolution.aliases.length > 64 || !this.registry.identity(resource)) throw new Error('Provider resolution exceeds the identity limit');
      return { ...snapshot, resolution };
    }
    return snapshot;
    });
  }

  creationOptions(pluginId: string, field: string, values: JsonObject, signal: AbortSignal) {
    signal.throwIfAborted();
    const plugin = this.registry.get(pluginId), definition = (plugin?.creation?.fields ?? plugin?.fields)?.[field], connector = this.connectors.get(pluginId);
    if (definition?.optionsSource !== 'resource.options' || !connector?.creationOptions) throw new Error('Options are unavailable for this field');
    return abortable(connector.creationOptions(field, structuredClone(values), signal), signal);
  }

  /** Field-based provider discovery follows the same verified attachment path as URLs. */
  async resolveFields(pluginId: string, id: string, title: string, data: JsonObject, signal: AbortSignal, connectionId?: string) {
    const resource = { ...this.registry.createRecord(pluginId, id, { title, data }), ...(connectionId ? { connectionId } : {}) };
    const snapshot = await this.load(resource, signal); signal.throwIfAborted();
    if (snapshot.connection !== 'connected' || !snapshot.title?.trim()) throw new Error('The provider could not resolve this item title');
    return { resource: { ...resource, title: snapshot.title.trim(), data: snapshot.resolution?.data ?? resource.data }, snapshot };
  }

  /** URL-only attachment; return a persistable record only after the provider supplies its title. */
  async resolveUrl(pluginId: string, id: string, input: string, signal: AbortSignal, connectionId?: string) {
    signal.throwIfAborted();
    const candidate = this.registry.matchInput(input).find(item => item.pluginId === pluginId);
    if (!candidate) throw new Error('This URL does not match the selected item type');
    const resource = { ...this.registry.createRecord(pluginId, id, candidate), ...(connectionId ? { connectionId } : {}) };
    const snapshot = await this.load(resource, signal);
    signal.throwIfAborted();
    if (snapshot.connection !== 'connected' || !snapshot.title?.trim()) throw new Error('The provider could not resolve this item title');
    return { resource: { ...resource, title: snapshot.title.trim(), data: snapshot.resolution?.data ?? resource.data }, snapshot };
  }

  actions(resource: ResourceRecord, signal: AbortSignal) {
    const { own, contributed } = this.allActions(resource, signal);
    // The expected-result function stays in the service; descriptions cross IPC and MCP as data.
    return [...own, ...contributed.map(entry => entry.action)].map(({ optimistic: _optimistic, ...action }) => ({
      ...action, ...(action.inputFields ? { inputSchema: fieldsSchema(action.inputFields) } : {}),
    }));
  }

  /** The result a write is expected to have, computed from the saved snapshot without contacting the provider. */
  optimistic(resource: ResourceRecord, actionId: string, snapshot: ResourceSnapshot, input: JsonObject) {
    const { own, contributed } = this.allActions(resource, AbortSignal.timeout(1_000));
    const action = [...own, ...contributed.map(entry => entry.action)].find(candidate => candidate.id === actionId);
    if (!action?.updatesSnapshot || !action.optimistic) return undefined;
    try { return action.optimistic(structuredClone(snapshot), structuredClone(input)); } catch { return undefined; }
  }

  async execute(resource: ResourceRecord, actionId: string, input: JsonObject, signal: AbortSignal) {
    const connector = this.connector(resource, signal), { own, contributed } = this.allActions(resource, signal);
    const owned = own.find(action => action.id === actionId), extra = contributed.find(entry => entry.action.id === actionId);
    const action = owned ?? extra?.action, run = owned ? connector.execute?.bind(connector) : extra?.contribution.execute.bind(extra.contribution);
    if (!action || !run) throw new Error(`Action is not available: ${actionId}`);
    if (action.inputFields && !validateFields(action.inputFields, input)) throw new Error('Action input is invalid');
    const result = await abortable(run(resource, actionId, signal, input), signal);
    signal.throwIfAborted(); return result ?? null;
  }

  getContext(resource: ResourceRecord, signal: AbortSignal) {
    const connector = this.connector(resource, signal);
    if (!connector.getContext) throw new Error('This item does not provide agent context');
    return abortable(connector.getContext(resource, signal), signal);
  }

  watch(resource: ResourceRecord, emit: Parameters<NonNullable<ResourcePluginConnector['watch']>>[1], signal: AbortSignal) {
    const connector = this.connector(resource, signal);
    if (!connector.watch) throw new Error('This item does not support status subscriptions');
    return abortable(connector.watch(resource, snapshot => { if (!signal.aborted) emit(snapshot); }, signal), signal);
  }
}
