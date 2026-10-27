import * as z from 'zod/v4';
import { resourceMapIndicators, hasResourceMapPresentation, presentationAttention } from './resource-presentation.ts';
import { isArchived, isOffMap } from '../../src/graph/archive.ts';
import { isMuted, mutedProjectIds } from '../../src/graph/mute.ts';
import { blockedBy, blockerList, blockerName } from '../../src/graph/blocking.ts';
import { resourceReference } from '../../src/resource-plugins/views.ts';
import { createHash, randomUUID } from 'node:crypto';
import { canonical, CommandIdConflict } from '../core/control.ts';
import { attentionNote } from '../../src/graph/attention.ts';
import type { WorkspaceControl, WorkspaceCommand, CommandEnvelope, WorkspaceState } from '../core/control.ts';
import { creationConnections, creationNear, requestConnections } from '../core/resource-creation.ts';
import { existingRelationship } from '../../src/graph/graph.ts';
import type { ResourceCreate } from '../core/resource-creation.ts';
import type { ResourcePluginHost } from '../../src/resource-plugins/host.ts';
import type { JsonObject, JsonValue, ResourceChoices, ResourceOptimism, ResourceRecord, ResourceSnapshot } from '../../src/resource-plugins/types.ts';
import type { ResourceIndicator } from '../../src/resource-plugins/indicators.ts';
import type { ProviderConnections } from '../provider-runtime/connections.ts';
import type { SqliteStore } from './sqlite-store.ts';
import { inBackground, knownBudget } from '../provider-runtime/request-budget.ts';
import { OUTCOME_UNKNOWN, PROVIDER_ACTION_MS } from './protocol.ts';

export const stableUuid = (seed: string) => {
  const hex = createHash('sha256').update(seed).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${(8 | parseInt(hex[16], 16) & 3).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};
/** The link from an item to one its provider read discovered: the same pair always gets the same id. */
export const discoveredLinkId = (sourceResourceId: string, key: string) => stableUuid(`${sourceResourceId}:${key}:link`);
/** Background poll interval as multiples of a plugin's interval, by how many
 * consecutive observations came back unchanged. Completed items (merged/closed
 * PRs, finished rollouts, done tickets) settle further. Any change, a person
 * opening the item or new attention returns it to the first step. */
export const CADENCE = { open: [1, 1, 2, 5, 10], complete: [1, 1, 2, 5, 10, 30] } as const;
const observation = (snapshot: ResourceSnapshot) => createHash('sha256').update(canonical({ ...snapshot, observedAt: undefined, stale: undefined, error: undefined })).digest('hex');
/** A deadline abort carries a numeric DOM code and a provider error its own; the caller gets one stable code either way. */
const unconfirmed = (error: unknown) => Object.assign(new Error((error as Error).message, { cause: error }), { code: OUTCOME_UNKNOWN, outcomeUnknown: true });
const fingerprint = (resource: ResourceRecord) => createHash('sha256').update(canonical({ plugin: resource.pluginId, schema: resource.schemaVersion, connection: resource.connectionId, data: resource.data })).digest('hex');
/** How long an unconfirmed change keeps showing its expected result before it is taken back. */
export const PENDING_WRITE_MS = 30 * 60_000;
/** How long an item's reads carry the reason its last change was taken back. */
const REVERTED_NOTICE_MS = 15 * 60_000;
const PENDING_SLOT = 'pending-write', PENDING_KEY = 'write', CHOICES_SLOT = 'choices:';
const PENDING_CUE: ResourceIndicator = { id: 'pending', label: 'Confirming', icon: 'clock', tone: 'amber' };
/** A person's change shown before the provider confirms it; `writing` while the write is in flight. */
interface PendingWrite { requestId: string; actionId: string; nodeId: string; input: JsonObject; base: ResourceSnapshot; since: number; writing: boolean; optimism: ResourceOptimism }
export class ResourceCoordinator {
  private store: SqliteStore; private control: WorkspaceControl; private host: ResourcePluginHost; private connections: ProviderConnections;
  private changed: () => Promise<void>; private now: () => number;
  private closing = new AbortController();
  private timer?: ReturnType<typeof setTimeout>;
  private polling?: Promise<void>;
  private pollAbort = new AbortController();
  private readAbort = new AbortController();
  private enabled = false;
  private accountBackoff = new Map<string, number>();
  private cadence = new Map<string, { unchanged: number; attention: number; complete: boolean; within?: number }>();
  /** Resources whose every on-map item was in a muted project at the last poll. */
  private mutedResources = new Set<string>();
  private allowed: () => boolean;
  private pending = new Map<string, { input: string; promise: Promise<unknown> }>();
  private binding: Promise<unknown> = Promise.resolve();
  private upgrading?: Promise<{ converted: string[]; skipped: { nodeId: string; reason: string }[] }>;
  private writes = new Map<string, PendingWrite>();
  private failures = new Map<string, { requestId: string; message: string; at: number }>();
  private restored = false;
  /** Counts the writes on each resource, so a choices read that a write overtook is not saved. */
  private choiceWrites = new Map<string, number>();
  constructor(store: SqliteStore, control: WorkspaceControl, host: ResourcePluginHost, connections: ProviderConnections, changed: () => Promise<void>, now = Date.now, allowed = () => true) {
    this.store = store; this.control = control; this.host = host; this.connections = connections; this.changed = changed; this.now = now; this.allowed = allowed;
  }
  private signal() { return AbortSignal.any([this.closing.signal, AbortSignal.timeout(PROVIDER_ACTION_MS)]); }
  private once<T>(key: string, input: unknown, work: () => Promise<T>): Promise<T> {
    this.closing.signal.throwIfAborted();
    const encoded = canonical(input), old = this.pending.get(key);
    if (old) { if (encoded !== old.input) return Promise.reject(new CommandIdConflict()); return old.promise as Promise<T>; }
    const promise = work().finally(() => this.pending.delete(key)); this.pending.set(key, { input: encoded, promise }); return promise;
  }
  start() {
    if (this.enabled || this.closing.signal.aborted) return;
    this.enabled = true; this.pollAbort = new AbortController();
    if (this.readAbort.signal.aborted) this.readAbort = new AbortController();
    const tick = async () => {
      try { await this.poll(); } catch { /* A transient store error retries next tick. */ }
      if (this.enabled) { this.timer = setTimeout(() => { void tick(); }, 15_000); this.timer.unref(); }
    };
    void this.upgradeLinks().catch(() => { /* Links stay as they are; the next start asks again. */ });
    void tick();
  }
  async pause() { this.enabled = false; clearTimeout(this.timer); this.pollAbort.abort(); this.readAbort.abort(); await this.polling?.catch(() => {}); await this.upgrading?.catch(() => {}); }
  /** Exposed to deterministic service tests; normal cadence is owned by start(). */
  poll() {
    if (this.polling) return this.polling;
    const signal = this.pollAbort.signal;
    const work = async () => {
      if (!this.allowed() || signal.aborted || this.closing.signal.aborted) return;
      const state = await this.control.read(), seen = new Set<string>();
      this.restore(state); await this.expire();
      // Reconstruct account-wide provider backoff from durable resource caches.
      for (const resource of state.resources) {
        if (!resource.connectionId) continue;
        const retry = this.store.resourceCache(resource.id, 'snapshot', fingerprint(resource))?.retryAt ?? 0;
        this.accountBackoff.set(resource.connectionId, Math.max(this.accountBackoff.get(resource.connectionId) ?? 0, retry));
      }
      const quiet = mutedProjectIds(state.nodes), wasMuted = this.mutedResources;
      this.mutedResources = new Set();
      for (const node of state.nodes) {
        if (!this.allowed() || signal.aborted || this.closing.signal.aborted) return;
        if (!node.resourceId || seen.has(node.resourceId) || isOffMap(node, state.nodes)) continue;
        seen.add(node.resourceId);
        const resource = state.resources.find(record => record.id === node.resourceId)!, aliases = state.nodes.filter(alias => alias.resourceId === resource.id);
        const muted = quiet.size > 0 && aliases.every(alias => isOffMap(alias, state.nodes) || isMuted(alias, state.nodes, quiet));
        if (muted) this.mutedResources.add(resource.id);
        // An unmuted resource starts over at the first step and reads now.
        const unmuted = !muted && wasMuted.has(resource.id);
        if (unmuted) this.cadence.delete(resource.id);
        const interval = this.interval(resource, Math.max(...aliases.map(alias => alias.attentionVersion ?? 0)), muted);
        // An unconfirmed change asks for a fresh read on every tick until one settles it.
        const unsettled = this.writes.get(resource.id);
        if (unsettled?.writing || !interval && !unsettled || (this.accountBackoff.get(resource.connectionId ?? '') ?? 0) > this.now()) continue;
        const cache = this.store.resourceCache(resource.id, 'snapshot', fingerprint(resource));
        if (!unsettled && !unmuted && cache && this.now() - cache.checkedAt < interval!) continue;
        try { await inBackground(() => this.read(node.id, Boolean(unsettled), signal, true)); } catch { /* Keep prior content; other accounts still refresh. */ }
      }
    };
    this.polling = work().finally(() => { this.polling = undefined; }); return this.polling;
  }
  /** This resource's background interval now: its plugin interval stretched by
   * unchanged observations and by its account's request budget; undefined when
   * it is not polled or its account's background work is paused. A resource only
   * a muted project shows waits the longest step of its cadence. */
  interval(resource: ResourceRecord, attention = 0, muted = false) {
    const base = this.host.pollingInterval(resource.pluginId); if (!base) return undefined;
    const cadence = this.cadence.get(resource.id) ?? { unchanged: 0, attention, complete: false };
    if (cadence.attention !== attention) Object.assign(cadence, { unchanged: 0, attention });
    this.cadence.set(resource.id, cadence);
    const steps = cadence.complete ? CADENCE.complete : CADENCE.open, factor = this.budget(resource)?.backgroundFactor() ?? 1;
    if (factor === Infinity) return undefined;
    if (muted) return base * steps[steps.length - 1] * factor;
    return Math.min(base * steps[Math.min(cadence.unchanged, steps.length - 1)], Math.max(base, cadence.within ?? Infinity)) * factor;
  }
  private budget(resource: ResourceRecord) {
    const provider = this.control.registry.get(resource.pluginId)?.connectionProvider;
    if (!provider || !resource.connectionId) return undefined;
    try { return knownBudget(provider, this.connections.resolve(provider, resource.connectionId).account); } catch { return undefined; }
  }
  private observed(resource: ResourceRecord, previous: ResourceSnapshot | undefined, snapshot: ResourceSnapshot, background: boolean) {
    const cadence = this.cadence.get(resource.id) ?? { unchanged: 0, attention: 0, complete: false };
    cadence.unchanged = background && previous && observation(previous) === observation(snapshot) ? cadence.unchanged + 1 : 0;
    cadence.complete = snapshot.activity === 'complete'; cadence.within = snapshot.pollWithinMs; this.cadence.set(resource.id, cadence);
  }
  async close() { this.closing.abort(); await this.pause(); await Promise.allSettled([...this.pending.values()].map(entry => entry.promise)); }
  async recover() {
    await this.refreshPresentation();
    for (const job of this.store.listJobs().filter(job => job.input.action === 'resource.attach' && ['queued', 'outcome-unknown'].includes(job.state))) {
      if (this.closing.signal.aborted) return;
      try { await this.attach(job.input.arguments.request as ResourceCreate); } catch { /* Explicit retry retains the same durable request. */ }
    }
  }
  private async record(nodeId: string, bind = true): Promise<ResourceRecord> {
    this.closing.signal.throwIfAborted();
    const state = await this.control.read(), node = state.nodes.find(node => node.id === nodeId), resource = state.resources.find(resource => resource.id === node?.resourceId);
    if (!resource) throw new Error('Resource item not found');
    const provider = this.control.registry.get(resource.pluginId)?.connectionProvider;
    if (provider) {
      const connection = this.connections.resolve(provider, resource.connectionId);
      if (bind && !resource.connectionId) {
        const work = this.binding.then(async () => {
          for (let attempt = 0; attempt < 5; attempt++) {
            const current = await this.control.read(), node = current.nodes.find(node => node.id === nodeId), saved = current.resources.find(record => record.id === node?.resourceId);
            if (!saved || saved.connectionId) return this.record(nodeId, false);
            this.connections.resolve(provider, connection.id);
            try {
              await this.control.dispatch({ commandId: randomUUID(), expectedRevision: current.revision, actor: { kind: 'system', id: 'providers' }, commands: [{ type: 'item.bind', id: nodeId, connectionId: connection.id }] });
              await this.changed(); return this.record(nodeId, false);
            } catch (error) { if ((error as { code?: string }).code !== 'REVISION_CONFLICT') throw error; }
          }
          throw new Error('The workspace kept changing. Open this item again.');
        });
        this.binding = work.catch(() => {}); return work;
      }
    }
    return resource;
  }
  options(pluginId: string, field: string, values: JsonObject) {
    return this.once(`options:${randomUUID()}`, null, () => this.host.creationOptions(pluginId, field, values, this.signal()));
  }
  private resolution(state: WorkspaceState, resource: ResourceRecord, snapshot: ResourceSnapshot) {
    const connectionId = resource.connectionId, registry = this.control.registry;
    const keys = new Set([resource.data, ...(snapshot.resolution?.aliases ?? [])].map(data => registry.identity({ ...resource, data })).filter(Boolean));
    const matches = state.resources.filter(candidate => (!candidate.connectionId || candidate.connectionId === connectionId) && keys.has(registry.identity({ ...candidate, connectionId })));
    const commands: WorkspaceCommand[] = [];
    for (const candidate of matches) {
      const node = state.nodes.find(node => node.resourceId === candidate.id);
      if (!node) continue;
      if (!candidate.connectionId && connectionId) commands.push({ type: 'item.bind', id: node.id, connectionId });
      if (snapshot.resolution && canonical(candidate.data) !== canonical(snapshot.resolution.data)) commands.push({ type: 'item.resolve', id: node.id, data: snapshot.resolution.data });
    }
    return { matches, commands };
  }
  attach(request: ResourceCreate) { return this.once(`attach:${request.requestId}`, request, () => this.attachOnce(request)); }
  private async attachOnce(request: ResourceCreate) {
    const signal = this.signal(), definition = this.control.registry.get(request.pluginId);
    if (definition?.creation?.action !== 'resource.attach' || !this.host.capabilities(request.pluginId).load) throw new Error('Provider attachment is unavailable for this item type');
    let job = this.store.enqueueJob(request.requestId, { action: 'resource.attach', nodeId: request.nodeId, arguments: { request } });
    if (job.state === 'succeeded') return job.result;
    if (job.state === 'outcome-unknown') job = this.store.transitionJob(job.id, job.state, 'queued', { correlation: { reconciledAbsent: true } }); // GET only; graph has its own atomic receipt.
    if (job.state === 'failed') job = this.store.transitionJob(job.id, job.state, 'queued');
    job = this.store.transitionJob(job.id, job.state, 'running');
    try {
      const connectionId = typeof job.correlation.connectionId === 'string' ? job.correlation.connectionId : definition.connectionProvider ? this.connections.resolve(definition.connectionProvider, request.connectionId).id : undefined;
      if (definition.connectionProvider) this.connections.resolve(definition.connectionProvider, connectionId);
      if (connectionId) job = this.store.transitionJob(job.id, 'running', 'running', { correlation: { connectionId } });
      let resolved = job.correlation.resolved as { resource: ResourceRecord; snapshot: ResourceSnapshot } | undefined;
      if (!resolved) {
        if (definition.creation?.mode === 'url') {
          if (typeof request.data.url !== 'string') throw new Error('Enter the item URL');
          resolved = await this.host.resolveUrl(request.pluginId, request.resourceId, request.data.url, signal, connectionId);
        } else resolved = await this.host.resolveFields(request.pluginId, request.resourceId, request.title, request.data, signal, connectionId);
        job = this.store.transitionJob(job.id, 'running', 'running', { correlation: { resolved } });
      }
      for (let attempt = 0; attempt < 5; attempt++) {
        signal.throwIfAborted();
        let prepared = job.correlation.prepared as { envelope: CommandEnvelope; nodeId: string; created?: boolean } | undefined;
        if (!prepared) {
          const state = await this.control.read(), resource = resolved.resource;
          const { matches, commands } = this.resolution(state, resource, resolved.snapshot);
          const existing = state.nodes.find(node => matches.some(candidate => candidate.id === node.resourceId) && node.projectId === request.projectId && !node.archivedAt);
          const nodeId = existing?.id ?? request.nodeId;
          if (!existing) commands.push({ type: 'item.create', id: nodeId, resource, position: request.position, projectId: request.projectId, ...creationNear(request) });
          // An item the map already has keeps the connections it holds; only missing ones are saved.
          commands.push(...creationConnections(requestConnections(request), nodeId).filter(command => !existing || !existingRelationship(state.nodes, state.links, command.link)));
          for (const id of new Set([nodeId, ...state.nodes.filter(node => matches.some(candidate => candidate.id === node.resourceId)).map(node => node.id)])) {
            const titled = state.nodes.find(node => node.id === id)?.generatedTitle !== undefined;
            commands.push({ type: 'node.update', id, ...(titled ? {} : { title: resolved.snapshot.title }), activity: resolved.snapshot.activity, summary: resolved.snapshot.label, indicators: resourceMapIndicators(this.host, matches.find(candidate => state.nodes.find(node => node.id === id)?.resourceId === candidate.id) ?? matches[0] ?? resource, resolved.snapshot, this.store) });
          }
          this.observeAttention(commands, state, nodeId, resource, resolved.snapshot);
          prepared = { nodeId, created: !existing, envelope: { commandId: request.requestId + ':attach', expectedRevision: state.revision, actor: { kind: 'user', id: 'resource-attachment' }, commands } };
          job = this.store.transitionJob(job.id, 'running', 'running', { correlation: { prepared } });
        }
        try {
          const result = await this.control.dispatch(prepared.envelope), node = result.state.nodes.find(node => node.id === prepared.nodeId)!;
          const resource = result.state.resources.find(resource => resource.id === node.resourceId)!;
          this.store.cacheResource(resource.id, 'snapshot', fingerprint(resource), resolved.snapshot, this.now());
          if (prepared.created) this.queueAttachTitle(resource, node.title, resolved.snapshot);
          const value = { nodeId: node.id, resourceId: resource.id };
          this.store.transitionJob(job.id, 'running', 'succeeded', { result: value }); await this.changed(); return value;
        } catch (error) {
          if ((error as { code?: string }).code !== 'REVISION_CONFLICT') throw error;
          job = this.store.transitionJob(job.id, 'running', 'running', { correlation: { prepared: null } });
        }
      }
      throw new Error('The workspace kept changing. Retry attaching this item.');
    } catch (error) {
      if (this.store.getJob(job.id)?.state === 'running') this.store.transitionJob(job.id, 'running', this.closing.signal.aborted ? 'outcome-unknown' : 'failed', { error: (error as Error).message }); throw error;
    }
  }
  /** Converts a generic link into the more specific type that claims its URL (spec RES-10): the
   * provider is read first, so a page that cannot be loaded stays the link it was. Node and
   * resource ids are kept. Like attaching, this reads the provider through its default account. */
  convert(nodeId: string, pluginId?: string) { return this.once(`convert:${nodeId}`, pluginId ?? null, () => this.convertOnce(nodeId, pluginId, { kind: 'user', id: 'resource-conversion' })); }
  private async convertOnce(nodeId: string, pluginId: string | undefined, actor: CommandEnvelope['actor'], background?: AbortSignal) {
    const signal = background ? AbortSignal.any([this.signal(), background]) : this.signal(), registry = this.control.registry;
    const state = await this.control.read(), node = state.nodes.find(candidate => candidate.id === nodeId), resource = state.resources.find(record => record.id === node?.resourceId);
    if (!node || !resource) throw new Error('Resource item not found');
    const candidates = registry.conversions(resource), candidate = pluginId ? candidates.find(match => match.pluginId === pluginId) : candidates.length === 1 ? candidates[0] : undefined;
    if (!candidate) throw new Error(candidates.length > 1 && !pluginId ? 'Choose the type to convert this link to.' : 'This item has no more specific type to convert to.');
    const definition = registry.get(candidate.pluginId)!;
    if (!this.host.capabilities(candidate.pluginId).load) throw new Error(`${definition.name} items cannot be loaded here.`);
    const connectionId = definition.connectionProvider ? this.connections.resolve(definition.connectionProvider).id : undefined;
    const converted: ResourceRecord = { id: resource.id, pluginId: candidate.pluginId, schemaVersion: candidate.schemaVersion, title: resource.title, data: candidate.data, ...(connectionId ? { connectionId } : {}) };
    const key = registry.identity(converted), twin = key ? state.resources.find(record => record.id !== resource.id && registry.identity(record) === key) : undefined;
    if (twin) throw new Error(`“${twin.title}” is already on the map, so this link stays as it is.`);
    if (connectionId && (this.accountBackoff.get(connectionId) ?? 0) > this.now()) throw new Error(`${definition.name} is busy. Try again in a moment.`);
    let snapshot: ResourceSnapshot;
    try { snapshot = await (background ? inBackground(() => this.host.load(converted, signal)) : this.host.load(converted, signal)); }
    catch (error) { const retryAt = (error as { retryAt?: number }).retryAt; if (connectionId && retryAt) this.accountBackoff.set(connectionId, retryAt); throw error; }
    if (snapshot.connection !== 'connected' || !snapshot.title?.trim()) throw new Error('The provider could not resolve this item title');
    for (let attempt = 0; ; attempt++) {
      signal.throwIfAborted();
      const current = await this.control.read(), saved = current.resources.find(record => record.id === resource.id), target = current.nodes.find(candidate => candidate.id === nodeId);
      if (!saved || !target || fingerprint(saved) !== fingerprint(resource)) throw new Error('The item changed while converting. Try again.');
      const keepTitle = this.namedByPerson(target.title, saved, [definition.name, candidate.title, definition.creation?.shortLabel]);
      try {
        await this.control.dispatch({ commandId: randomUUID(), expectedRevision: current.revision, actor, commands: [{ type: 'item.convert', id: nodeId, pluginId: candidate.pluginId, ...(connectionId ? { connectionId } : {}), ...(keepTitle ? { keepTitle } : {}) }] });
        break;
      } catch (error) { if ((error as { code?: string }).code !== 'REVISION_CONFLICT' || attempt >= 4) throw error; }
    }
    await this.changed();
    await this.acceptSnapshot(nodeId, converted, snapshot, signal);
    this.observed(converted, undefined, snapshot, false);
    return { nodeId, resourceId: resource.id, pluginId: candidate.pluginId };
  }
  /** Whether the person named this link themselves. Only a saved page title that differs from the
   * item's title shows that; the names a link gets on its own (its page title, host or type) never do. */
  private namedByPerson(title: string, link: ResourceRecord, generic: readonly (string | undefined)[]) {
    const saved = (this.store.resourceCache(link.id, 'snapshot', fingerprint(link))?.value as ResourceSnapshot | undefined)?.title;
    if (!saved?.trim()) return false;
    let host = ''; try { host = new URL(this.control.registry.linkUrl(link) ?? '').hostname; } catch { /* Not a URL: no host name to compare. */ }
    const names = [saved, host, host.replace(/^www\./, ''), this.control.registry.get(link.pluginId)?.name, ...generic].flatMap(name => name?.trim() ? [name.trim().toLowerCase()] : []);
    return !names.includes(title.trim().toLowerCase());
  }
  /** Upgrades every generic link on the map whose URL a connected, more specific type claims.
   * Runs at service start and when accounts change. Quiet and idempotent: nothing to convert
   * means no provider request and no workspace change. Links of a provider without an enabled
   * account, and items in the archive or Undermap, wait (Convert in the item menu still works).
   * A page already on the map, or one the provider cannot load, leaves the link as it is. */
  upgradeLinks() {
    if (this.upgrading) return this.upgrading;
    const signal = this.pollAbort.signal;
    const work = async () => {
      const result = { converted: [] as string[], skipped: [] as { nodeId: string; reason: string }[] };
      if (!this.allowed() || signal.aborted || this.closing.signal.aborted) return result;
      const state = await this.control.read(), registry = this.control.registry, seen = new Set<string>();
      for (const node of state.nodes) {
        if (!this.allowed() || signal.aborted || this.closing.signal.aborted) break;
        if (!node.resourceId || seen.has(node.resourceId) || isOffMap(node, state.nodes)) continue;
        seen.add(node.resourceId);
        const candidates = registry.conversions(state.resources.find(record => record.id === node.resourceId)!);
        if (candidates.length !== 1) continue;
        const provider = registry.get(candidates[0].pluginId)?.connectionProvider;
        try { if (provider) this.connections.resolve(provider); } catch { continue; }
        try { await this.once(`convert:${node.id}`, candidates[0].pluginId, () => this.convertOnce(node.id, candidates[0].pluginId, { kind: 'system', id: 'link-upgrade' }, signal)); result.converted.push(node.id); }
        catch (error) { if (this.closing.signal.aborted || signal.aborted) break; result.skipped.push({ nodeId: node.id, reason: (error as Error).message }); }
      }
      return result;
    };
    this.upgrading = work().finally(() => { this.upgrading = undefined; }); return this.upgrading;
  }
  /** A failure here never fails the attachment; the provider title stays. */
  private queueAttachTitle(resource: ResourceRecord, title: string, snapshot: ResourceSnapshot) {
    try {
      const evidence = this.control.registry.get(resource.pluginId)?.attachTitle?.evidence;
      const sample = evidence && this.store.readSettings().value.summaries.attachTitles ? evidence(snapshot) : undefined;
      if (sample) this.store.queueAttachTitle(resource.id, title, sample, this.now());
    } catch { /* Untitled items keep their provider title. */ }
  }
  /** Local-only preview: never waits for provider reads, writes or credentials.
   * Exact resource/account fingerprints prevent showing another PR's content. */
  async cached(nodeId: string): Promise<ResourceSnapshot | null> {
    this.closing.signal.throwIfAborted();
    const state = await this.control.read(), node = state.nodes.find(node => node.id === nodeId);
    const resource = state.resources.find(resource => resource.id === node?.resourceId);
    if (!node || isArchived(node, state.nodes) || !resource) return null;
    const cache = this.store.resourceCache(resource.id, 'snapshot', fingerprint(resource));
    if (!cache?.value) return null;
    const { attentionReceipt: _receipt, ...snapshot } = cache.value as ResourceSnapshot;
    this.restore(state);
    return this.presented(resource.id, { ...snapshot, stale: true, ...(cache.error ? { error: cache.error, connection: 'disconnected' as const } : {}) });
  }
  /** While a change with an expected result is being written, reads show that result without asking
   * the provider, so a poll that reaches it before the write lands cannot take the change back. */
  async read(nodeId: string, refresh = false, signal?: AbortSignal, background = false) {
    signal?.throwIfAborted();
    const resource = await this.record(nodeId); signal?.throwIfAborted();
    this.restore(await this.control.read());
    const writing = this.writes.get(resource.id);
    if (writing?.writing) return this.presented(resource.id, writing.base);
    await this.pending.get(`write:${resource.id}`)?.promise.catch(() => {});
    return this.presented(resource.id, await this.once(`read:${resource.id}`, fingerprint(resource), () => this.readOnce(nodeId, refresh, signal, background)));
  }
  private observeAttention(commands: WorkspaceCommand[], state: WorkspaceState, nodeId: string, resource: ResourceRecord, snapshot: ResourceSnapshot) {
    if (snapshot.attentionReason === undefined) return;
    const source = `provider:${resource.pluginId}`, target = state.nodes.find(node => node.id === nodeId);
    const note = snapshot.attentionReason ? attentionNote(snapshot.attentionNote) : undefined;
    if ((target?.attentionSources?.[source] ?? null) !== snapshot.attentionReason || snapshot.attentionEventId && target?.attentionEvents?.[source] !== snapshot.attentionEventId || target?.attentionNotes?.[source] !== note)
      commands.push({ type: 'attention.set', id: nodeId, source, reason: snapshot.attentionReason, ...(note ? { note } : {}), eventId: snapshot.attentionEventId });
  }
  private observePresentationAttention(commands: WorkspaceCommand[], state: WorkspaceState, resource: ResourceRecord, snapshot: ResourceSnapshot) {
    const attention = presentationAttention(this.host, resource, snapshot, this.store);
    const target = state.nodes.find(node => node.resourceId === resource.id && !isOffMap(node, state.nodes));
    if (!attention || !target) return;
    if (attention.reason === null ? target.attentionSources?.[attention.source] : target.attentionEvents?.[attention.source] !== attention.eventId)
      commands.push({ type: 'attention.set', id: target.id, source: attention.source, reason: attention.reason, ...(attention.note ? { note: attention.note } : {}), ...(attention.eventId ? { eventId: attention.eventId } : {}) });
  }
  context(nodeId: string, signal: AbortSignal) {
    return this.once(`context:${randomUUID()}`, null, async () => {
      const resource = await this.record(nodeId), combined = AbortSignal.any([signal, this.closing.signal]);
      const context = await this.host.getContext(resource, combined); combined.throwIfAborted();
      if (fingerprint(await this.record(nodeId, false)) !== fingerprint(resource)) throw new Error('The item changed during context lookup');
      return context;
    });
  }
  private async readOnce(nodeId: string, refresh: boolean, caller?: AbortSignal, background = false): Promise<ResourceSnapshot> {
    const resource = await this.record(nodeId), key = fingerprint(resource), cached = this.store.resourceCache(resource.id, 'snapshot', key), now = this.now();
    const readSignal = this.readAbort.signal;
    const signal = AbortSignal.any([this.signal(), readSignal, ...(caller ? [caller] : [])]);
    const old = cached?.value as ResourceSnapshot | undefined;
    if (cached && ((!refresh && now - cached.checkedAt < 60_000) || (cached.retryAt ?? 0) > now)) {
      if (old) { await this.refreshPresentation(nodeId); return { ...old, ...(cached.error ? { stale: true, error: cached.error, connection: 'disconnected' as const } : {}) }; }
      throw new Error(cached.error ?? 'Provider content unavailable');
    }
    try {
      const snapshot = await this.host.load(resource, signal, { background });
      await this.acceptSnapshot(nodeId, resource, snapshot, signal, caller);
      this.observed(resource, old, snapshot, background);
      await this.settle(resource, snapshot);
      return snapshot;
    } catch (error) {
      this.closing.signal.throwIfAborted(); caller?.throwIfAborted(); readSignal.throwIfAborted();
      const current = await this.record(nodeId, false); if (fingerprint(current) !== key) throw new Error('The item changed while loading. Open it again.');
      const failure = error as Error & { retryAt?: number };
      this.store.cacheResource(resource.id, 'snapshot', key, old, now, failure.message, failure.retryAt ?? now + 15_000);
      if (resource.connectionId && failure.retryAt) this.accountBackoff.set(resource.connectionId, failure.retryAt);
      await this.markStale(resource);
      if (!old) throw error;
      return { ...old, stale: true, error: failure.message, connection: 'disconnected' };
    }
  }
  private async acceptSnapshot(nodeId: string, resource: ResourceRecord, snapshot: ResourceSnapshot, signal: AbortSignal, caller?: AbortSignal) {
    const key = fingerprint(resource), now = this.now();
    for (let attempt = 0; ; attempt++) {
      signal.throwIfAborted();
      const current = await this.record(nodeId, false); if (fingerprint(current) !== key) throw new Error('The item changed while loading. Open it again.');
      const state = await this.control.read();
      if (caller && isArchived(state.nodes.find(node => node.id === nodeId)!, state.nodes)) return snapshot;
      const { matches, commands } = snapshot.resolution ? this.resolution(state, { ...resource, data: snapshot.resolution.data }, snapshot) : { matches: [resource], commands: [] as WorkspaceCommand[] };
      for (const node of state.nodes.filter(node => matches.some(record => record.id === node.resourceId))) {
        const indicators = resourceMapIndicators(this.host, matches.find(record => record.id === node.resourceId)!, snapshot, this.store);
        const title = node.generatedTitle === undefined ? snapshot.title : undefined;
        if (title && node.title !== title || node.summary !== snapshot.label || node.activity !== (node.rework ? 'working' : snapshot.activity) || indicators && canonical(node.indicators) !== canonical(indicators))
          commands.push({ type: 'node.update', id: node.id, ...(title ? { title } : {}), summary: snapshot.label, activity: snapshot.activity, indicators });
      }
      // Provider completion mirrors onto Mark done only when it changes, so a local
      // check awaiting its provider write is not undone by an older observation.
      // A to-do that brought this ticket to the map follows it the same way (TODO-12).
      if (snapshot.done !== undefined && snapshot.done !== (this.store.resourceCache(resource.id, 'snapshot', key)?.value as ResourceSnapshot | undefined)?.done) {
        const tickets = new Set(state.nodes.filter(node => matches.some(record => record.id === node.resourceId)).map(node => node.id));
        for (const node of state.nodes.filter(node => (tickets.has(node.id) || node.todoTicketId && tickets.has(node.todoTicketId)) && !isArchived(node, state.nodes) && Boolean(node.completedAt) !== snapshot.done))
          commands.push({ type: snapshot.done ? 'node.complete' : 'node.reopen', id: node.id });
      }
      this.observeAttention(commands, state, nodeId, resource, snapshot);
      this.observePresentationAttention(commands, state, resource, snapshot);
      try {
        let saved = state;
        if (commands.length) saved = (await this.control.dispatch({ commandId: randomUUID(), expectedRevision: state.revision, actor: { kind: 'system', id: 'providers' }, commands })).state;
        const savedResource = saved.resources.find(record => record.id === saved.nodes.find(node => node.id === nodeId)?.resourceId)!;
        this.store.cacheResource(savedResource.id, 'snapshot', fingerprint(savedResource), snapshot, now);
        if (commands.length) await this.changed();
        break;
      } catch (error) { if ((error as { code?: string }).code !== 'REVISION_CONFLICT' || attempt >= 4) throw error; }
    }
    await this.attachDiscovered(nodeId, resource, snapshot);
  }
  /** Stable request/node/resource IDs make each discovery attach at most once:
   * a later poll replays the succeeded job instead of re-adding a deleted item. */
  private async attachDiscovered(nodeId: string, source: ResourceRecord, snapshot: ResourceSnapshot) {
    const found = (snapshot.discovered ?? []).slice(0, 10);
    if (!found.length) return;
    const state = await this.control.read(), node = state.nodes.find(candidate => candidate.id === nodeId);
    if (!node || isArchived(node, state.nodes)) return;
    for (const [index, item] of found.entries()) {
      const id = (part: string) => stableUuid(`${source.id}:${item.key}:${part}`);
      try {
        await this.attach({ requestId: id('request'), nodeId: id('node'), resourceId: id('resource'), expectedRevision: state.revision, pluginId: item.pluginId, title: item.title,
          projectId: node.projectId, position: { x: node.position.x + 280, y: node.position.y + index * 110 }, connectionId: source.connectionId,
          connection: { id: discoveredLinkId(source.id, item.key), otherId: nodeId, kind: 'reference', sourceIsNew: false }, data: item.data });
      } catch { this.closing.signal.throwIfAborted(); } // A failed job is retried on the next observation.
    }
  }
  /** The person opened this item's provider page from the app. Its type records local read
   * state from the saved snapshot; nothing is fetched or written to the provider. */
  async opened(nodeId: string) {
    const state = await this.control.read(), node = state.nodes.find(candidate => candidate.id === nodeId), resource = state.resources.find(record => record.id === node?.resourceId);
    if (!node || !resource) throw new Error('Resource item not found');
    const hook = this.host.presentation(resource.pluginId)?.opened;
    if (!hook) return { recorded: false };
    hook(resource, this.store.resourceCache(resource.id, 'snapshot', fingerprint(resource))?.value as ResourceSnapshot | undefined, this.store, this.now());
    await this.refreshPresentation(nodeId);
    return { recorded: true };
  }
  /** Repaint durable local state from cached content without fetching or acknowledging providers. */
  async refreshPresentation(nodeId?: string) {
    for (let attempt = 0; ; attempt++) {
      const state = await this.control.read(), resourceId = state.nodes.find(node => node.id === nodeId)?.resourceId;
      const commands: WorkspaceCommand[] = [];
      for (const resource of state.resources.filter(resource => hasResourceMapPresentation(this.host, resource) && (!nodeId || resource.id === resourceId))) {
        const cache = this.store.resourceCache(resource.id, 'snapshot', fingerprint(resource));
        if (!cache?.value) continue;
        this.observePresentationAttention(commands, state, resource, cache.value as ResourceSnapshot);
        const indicators = resourceMapIndicators(this.host, resource, cache.value as ResourceSnapshot, this.store);
        if (!indicators) continue;
        for (const node of state.nodes.filter(node => node.resourceId === resource.id)) {
          // Keep the independent disconnected cue until a successful provider read.
          const paused = node.indicators?.find(cue => cue.id === 'connection');
          const next = paused && !indicators.some(cue => cue.id === 'connection') ? [...indicators, paused] : indicators;
          if (canonical(node.indicators) !== canonical(next)) commands.push({ type: 'node.update', id: node.id, indicators: next });
        }
      }
      if (!commands.length) return;
      try { await this.control.dispatch({ commandId: randomUUID(), expectedRevision: state.revision, actor: { kind: 'system', id: 'resource-presentation' }, commands }); await this.changed(); return; }
      catch (error) { if ((error as { code?: string }).code !== 'REVISION_CONFLICT' || attempt >= 4) throw error; }
    }
  }
  async execute(nodeId: string, actionId: string, input: JsonObject, caller: AbortSignal, completing = false) {
    const resource = await this.record(nodeId), signal = AbortSignal.any([caller, this.closing.signal]);
    const action = this.host.actions(resource, signal).find(action => action.id === actionId);
    if (action?.completion && !completing) throw new Error('Use Mark done or Reopen on the item; that updates the provider too.');
    const blockers = action?.heedsBlockers ? await this.blockers(nodeId) : [];
    if (action?.readOnly && action.cacheChoices) {
      const choices = await this.choices(nodeId, resource, actionId, input, signal);
      return blockers.length ? heedBlockers(choices, blockers) : choices;
    }
    if (action?.readOnly === false) this.forgetChoices(resource.id);
    if (!action?.updatesSnapshot) {
      const sent = action?.readOnly === false ? this.signal() : signal;
      return blockers.length ? heedBlockers(await this.host.execute(resource, actionId, input, sent), blockers) : this.host.execute(resource, actionId, input, sent);
    }
    const acknowledged = new Set(String(input.overrideBlockers ?? '').split(','));
    const unacknowledged = blockers.filter(blocker => !acknowledged.has(blocker.id));
    if (unacknowledged.length) throw new Error(`Blocked by ${blockerList(unacknowledged.map(blocker => blocker.name))}. Reopen the menu and choose an option marked “anyway” to go ahead.`);
    const { requestId, sourceResourceId } = z.object({ requestId: z.string().uuid(), sourceResourceId: z.string().min(1) }).parse(input);
    if (sourceResourceId !== resource.id) throw new Error('This action belongs to another item. Reopen its menu.');
    this.restore(await this.control.read());
    const waiting = this.writes.get(resource.id);
    if (waiting && waiting.requestId !== requestId) throw new Error('The last change to this item is still being confirmed. Try again once it settles.');
    let show!: (result: JsonValue) => void;
    const shown = new Promise<JsonValue>(resolve => { show = resolve; });
    const written = this.once(`write:${resource.id}`, { actionId, input }, () => this.write(nodeId, resource, actionId, input, requestId, show));
    return Promise.race([shown, written]);
  }
  /** A menu's choices, saved per item: the prompt, the context it carries back (head SHA, node id, expected
   * state or title) and the blockers are the item's own, so another pull request in the same repository
   * could not reuse them. `cached` answers from the saved copy when there is one; `refresh` always reads. */
  private async choices(nodeId: string, resource: ResourceRecord, actionId: string, input: JsonObject, signal: AbortSignal): Promise<JsonValue> {
    const { cached, refresh, ...rest } = input, slot = `${CHOICES_SLOT}${actionId}`, key = fingerprint(resource);
    if (cached === true && refresh !== true) {
      const saved = this.store.resourceCache(resource.id, slot, key);
      if (saved?.value !== undefined) return { ...(saved.value as JsonObject), cachedAt: saved.checkedAt };
    }
    const writes = this.choiceWrites.get(resource.id) ?? 0, now = this.now();
    const result = await this.host.execute(resource, actionId, rest, signal);
    if ((this.choiceWrites.get(resource.id) ?? 0) === writes && fingerprint(await this.record(nodeId, false)) === key) this.store.cacheResource(resource.id, slot, key, result, now);
    return result;
  }
  private forgetChoices(resourceId: string) {
    this.choiceWrites.set(resourceId, (this.choiceWrites.get(resourceId) ?? 0) + 1);
    this.store.forgetResourceCache(resourceId, CHOICES_SLOT);
  }
  /** Sends one write, never retried, on the service's own deadline: the caller's shorter one would cut a write
   * off mid-request and leave its outcome unknown. An action that declares its expected result shows it at
   * once through `show`, so closing the view or menu that asked for it never matters; its outcome reconciles the overlay. */
  private async write(nodeId: string, resource: ResourceRecord, actionId: string, input: JsonObject, requestId: string, show: (result: JsonValue) => void) {
    let job = this.store.enqueueJob(requestId, { action: 'resource.action', nodeId, arguments: { actionId, input, fingerprint: fingerprint(resource) } });
    if (job.state === 'succeeded') return job.result;
    if (job.state !== 'queued') throw job.state === 'failed' ? new Error(job.error) : unconfirmed(new Error('The previous update could not be confirmed. Refresh the item before choosing a status again.'));
    job = this.store.transitionJob(job.id, 'queued', 'running');
    let confirmed = false, pending: PendingWrite | undefined;
    const signal = this.signal();
    try {
      // Drain an older poll before dispatching; new reads wait for this write.
      await this.pending.get(`read:${resource.id}`)?.promise.catch(() => {});
      const state = await this.control.read(), node = state.nodes.find(node => node.id === nodeId);
      if (!node || isArchived(node, state.nodes)) throw new Error('Restore this item before changing its provider state.');
      if (fingerprint(await this.record(nodeId, false)) !== fingerprint(resource)) throw new Error('The item changed. Reopen its menu.');
      const base = this.store.resourceCache(resource.id, 'snapshot', fingerprint(resource))?.value as ResourceSnapshot | undefined;
      const optimism = base ? this.host.optimistic(resource, actionId, base, input) : undefined;
      if (optimism) {
        pending = { requestId, actionId, nodeId, input, base: base!, since: this.now(), writing: true, optimism };
        this.writes.set(resource.id, pending); this.failures.delete(resource.id); this.persist(resource.id, pending);
        await this.changed();
        show({ snapshot: this.presented(resource.id, base!), pending: optimism.pending } as unknown as JsonValue);
      }
      const result = await this.host.execute(resource, actionId, input, signal); confirmed = true;
      const snapshot = (result as unknown as { snapshot: ResourceSnapshot })?.snapshot;
      if (!snapshot || snapshot.connection !== 'connected' || !snapshot.label) throw new Error('The provider did not return a confirmed status. Refresh the item.');
      await this.acceptSnapshot(nodeId, resource, snapshot, signal);
      this.observed(resource, undefined, snapshot, false);
      this.store.transitionJob(job.id, 'running', 'succeeded', { result });
      if (pending) { pending.writing = false; this.persist(resource.id, pending); await this.settle(resource, snapshot); }
      return result;
    } catch (error) {
      const unknown = confirmed || signal.aborted || (error as { outcomeUnknown?: boolean }).outcomeUnknown === true;
      this.store.transitionJob(job.id, 'running', unknown ? 'outcome-unknown' : 'failed', { error: (error as Error).message });
      await this.markStale(resource).catch(() => {});
      if (pending && this.writes.get(resource.id) === pending) {
        pending.writing = false;
        if (unknown) { this.persist(resource.id, pending); await this.changed().catch(() => {}); }
        else await this.revert(resource, pending, (error as Error).message).catch(() => {});
      }
      throw unknown ? unconfirmed(error) : error;
    }
  }
  /** Resolves once every write in flight has finished; exposed to deterministic service tests. */
  async writing() { await Promise.allSettled([...this.pending].filter(([key]) => key.startsWith('write:')).map(([, entry]) => entry.promise)); }
  /** Pending writes are saved, so an unconfirmed one survives a restart: it shows as
   * still confirming, and the next read settles it. The write itself is never sent again. */
  private restore(state: WorkspaceState) {
    if (this.restored) return;
    this.restored = true;
    for (const resource of state.resources) {
      const saved = this.store.resourceCache(resource.id, PENDING_SLOT, PENDING_KEY)?.value as Omit<PendingWrite, 'writing' | 'optimism'> | undefined;
      if (!saved) continue;
      const optimism = this.host.optimistic(resource, saved.actionId, saved.base, saved.input);
      if (optimism) this.writes.set(resource.id, { ...saved, writing: false, optimism });
      else this.store.cacheResource(resource.id, PENDING_SLOT, PENDING_KEY, undefined, this.now());
    }
  }
  private persist(resourceId: string, write: PendingWrite | undefined) {
    const value = write && { requestId: write.requestId, actionId: write.actionId, nodeId: write.nodeId, input: write.input, base: write.base, since: write.since };
    try { this.store.cacheResource(resourceId, PENDING_SLOT, PENDING_KEY, value, this.now()); } catch { /* The overlay still holds in memory; only a restart forgets it. */ }
  }
  /** What a person sees of this resource: the expected result while a change is pending, or the read with the reason a change was taken back. */
  private presented(resourceId: string, snapshot: ResourceSnapshot): ResourceSnapshot {
    const write = this.writes.get(resourceId), failure = this.failures.get(resourceId);
    if (write) return { ...write.optimism.snapshot, pending: write.optimism.pending, ...(snapshot.stale ? { stale: true, error: snapshot.error, connection: snapshot.connection } : {}) };
    if (failure && this.now() - failure.at < REVERTED_NOTICE_MS) return { ...snapshot, reverted: { requestId: failure.requestId, message: failure.message } };
    return snapshot;
  }
  /** The workspace as people see it: items with a pending change show its expected result and a
   * Confirming cue. The saved graph and agents keep the provider's last read. */
  overlay(state: WorkspaceState): WorkspaceState {
    this.restore(state);
    if (!this.writes.size) return state;
    return { ...state, nodes: state.nodes.map(node => {
      const write = node.resourceId ? this.writes.get(node.resourceId) : undefined, resource = write && state.resources.find(record => record.id === node.resourceId);
      if (!write || !resource) return node;
      const expected = write.optimism.snapshot, indicators = [...(resourceMapIndicators(this.host, resource, expected, this.store) ?? []).slice(0, 3), PENDING_CUE];
      return { ...node, ...(node.generatedTitle === undefined && expected.title ? { title: expected.title } : {}), summary: expected.label, activity: expected.activity, indicators };
    }) };
  }
  /** A provider read decides a change that is no longer being written: it shows the change, or it does not. */
  private async settle(resource: ResourceRecord, read: ResourceSnapshot) {
    const write = this.writes.get(resource.id);
    if (!write || write.writing || read.stale || read.connection !== 'connected') return;
    const landed = write.optimism.landed(read);
    if (landed === true) await this.confirm(resource, write);
    else if (landed === false) {
      const provider = this.control.registry.get(resource.pluginId)?.connectionProvider, name = this.connections.describe().find(entry => entry.id === provider)?.name ?? 'the provider';
      await this.revert(resource, write, `the next read from ${name} doesn’t show it.`);
    }
  }
  private async confirm(resource: ResourceRecord, write: PendingWrite) {
    if (this.writes.get(resource.id) !== write) return;
    this.writes.delete(resource.id); this.failures.delete(resource.id); this.persist(resource.id, undefined);
    await this.raise(resource, write, null);
    await this.changed();
  }
  /** Takes the expected result back and tells the person: Needs me names the change, the item's view the reason. */
  private async revert(resource: ResourceRecord, write: PendingWrite, reason: string, expired = false) {
    if (this.writes.get(resource.id) !== write) return;
    this.writes.delete(resource.id); this.persist(resource.id, undefined);
    const note = `${write.optimism.subject} ${expired ? 'couldn’t be confirmed' : 'didn’t go through'}`;
    this.failures.set(resource.id, { requestId: write.requestId, message: expired ? `${note}. ${reason}` : `${note}: ${reason}`, at: this.now() });
    await this.raise(resource, write, note);
    await this.changed();
  }
  private async raise(resource: ResourceRecord, write: PendingWrite, note: string | null) {
    const source = `action:${resource.pluginId}`;
    for (let attempt = 0; attempt < 5; attempt++) {
      const state = await this.control.read(), aliases = state.nodes.filter(node => node.resourceId === resource.id && !isOffMap(node, state.nodes));
      const target = aliases.find(node => node.id === write.nodeId) ?? aliases[0];
      if (!target || (note === null && !target.attentionSources?.[source])) return;
      const command: WorkspaceCommand = note === null ? { type: 'attention.set', id: target.id, source, reason: null }
        : { type: 'attention.set', id: target.id, source, reason: 'error', note: attentionNote(note), eventId: write.requestId };
      try { await this.control.dispatch({ commandId: randomUUID(), expectedRevision: state.revision, actor: { kind: 'system', id: 'providers' }, commands: [command] }); return; }
      catch (error) { if ((error as { code?: string }).code !== 'REVISION_CONFLICT') throw error; }
    }
  }
  /** An unconfirmed change that no read could settle is taken back after a while, so nothing stays “confirming” forever. */
  private async expire() {
    const state = await this.control.read();
    for (const [resourceId, write] of [...this.writes]) {
      const resource = state.resources.find(record => record.id === resourceId);
      if (write.writing || this.now() - write.since < PENDING_WRITE_MS) continue;
      if (resource) await this.revert(resource, write, 'Check it before trying again.', true);
      else this.writes.delete(resourceId);
    }
  }
  /** A person's Mark done/Reopen (UI or agent) is written to providers that mirror
   * completion. A refused or unconfirmed write reverts the local change and throws. */
  async mirrorCompletion(before: WorkspaceState, after: WorkspaceState, commandId: string, caller: AbortSignal) {
    const failures: Error[] = [];
    for (const node of after.nodes.filter(node => node.resourceId && Boolean(node.completedAt) !== Boolean(before.nodes.find(old => old.id === node.id)?.completedAt))) {
      const done = Boolean(node.completedAt), resource = after.resources.find(record => record.id === node.resourceId);
      // Items not bound to a provider account (legacy or never connected) complete locally.
      const bound = resource && (resource.connectionId || !this.control.registry.get(resource.pluginId)?.connectionProvider);
      const action = bound && this.host.capabilities(resource.pluginId).actions && this.control.registry.resolve(resource).available ? this.host.actions(resource, caller).find(action => action.completion) : undefined;
      if (!resource || !action) continue;
      try {
        const restore = (this.store.resourceCache(resource.id, 'completion', 'restore')?.value as string | undefined) ?? '';
        const result = await this.execute(node.id, action.id, { done: String(done), restore, requestId: stableUuid(`${commandId}:${node.id}:completion`), sourceResourceId: resource.id }, caller, true) as { restore?: string };
        if (!done || result.restore) this.store.cacheResource(resource.id, 'completion', 'restore', done ? result.restore : undefined, this.now());
      } catch (error) {
        failures.push(error as Error);
        for (let attempt = 0; attempt < 5; attempt++) {
          const state = await this.control.read();
          if (Boolean(state.nodes.find(current => current.id === node.id)?.completedAt) !== done) break;
          try { await this.control.dispatch({ commandId: randomUUID(), expectedRevision: state.revision, actor: { kind: 'system', id: 'providers' }, commands: [{ type: done ? 'node.reopen' : 'node.complete', id: node.id }] }); await this.changed(); break; }
          catch (conflict) { if ((conflict as { code?: string }).code !== 'REVISION_CONFLICT') throw conflict; }
        }
      }
    }
    if (failures.length) throw failures[0];
  }
  /** Unresolved blockers of this item, named for a prompt: “#64 Thumbnail refresh loop (open)”. */
  private async blockers(nodeId: string) {
    const state = await this.control.read();
    return blockedBy(nodeId, state.nodes, state.links).map(node => {
      const resource = state.resources.find(record => record.id === node.resourceId);
      const reference = resource && resourceReference(this.control.registry.get(resource.pluginId), resource);
      return { id: node.id, name: blockerName(node.title, reference), status: (node.indicators?.[0]?.label ?? 'open').toLowerCase() };
    });
  }
  private async markStale(resource: ResourceRecord) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const state = await this.control.read();
      const saved = state.resources.find(record => record.id === resource.id);
      if (!saved || fingerprint(saved) !== fingerprint(resource)) return;
      const commands: WorkspaceCommand[] = state.nodes.filter(node => node.resourceId === resource.id && node.indicators && !node.indicators.some(cue => cue.id === 'connection'))
        .map(node => ({ type: 'node.update', id: node.id, indicators: [...node.indicators!.slice(0, 3), { id: 'connection', label: 'Updates paused', icon: 'clock', tone: 'amber' }] }));
      if (!commands.length) return;
      try { await this.control.dispatch({ commandId: randomUUID(), expectedRevision: state.revision, actor: { kind: 'system', id: 'providers' }, commands }); await this.changed(); return; }
      catch (error) { if ((error as { code?: string }).code !== 'REVISION_CONFLICT') throw error; }
    }
  }
  content(nodeId: string, actionId: string, input: JsonObject, refresh = false) {
    return this.once(`content:${nodeId}:${actionId}`, { input, refresh }, async () => {
      const resource = await this.record(nodeId), signal = this.signal();
      if (!this.host.actions(resource, signal).find(action => action.id === actionId)?.readOnly) throw new Error('Only read-only provider content can be cached');
      const key = createHash('sha256').update(fingerprint(resource) + canonical(input)).digest('hex'), slot = `action:${actionId}`, now = this.now();
      const cached = this.store.resourceCache(resource.id, slot, key);
      if (cached && ((!refresh && now - cached.checkedAt < 60_000) || (cached.retryAt ?? 0) > now)) {
        if (cached.value !== undefined) return { content: cached.value, observedAt: cached.checkedAt, stale: Boolean(cached.error), error: cached.error };
        throw new Error(cached.error ?? 'Provider content unavailable');
      }
      try {
        const content = await this.host.execute(resource, actionId, input, signal);
        if (fingerprint(await this.record(nodeId, false)) !== fingerprint(resource)) throw new Error('The item changed while loading. Open it again.');
        this.store.cacheResource(resource.id, slot, key, content, now);
        return { content, observedAt: now, stale: false };
      } catch (error) {
        this.closing.signal.throwIfAborted();
        if (fingerprint(await this.record(nodeId, false)) !== fingerprint(resource)) throw new Error('The item changed while loading. Open it again.');
        const failure = error as Error & { retryAt?: number };
        this.store.cacheResource(resource.id, slot, key, cached?.value, now, failure.message, failure.retryAt ?? now + 15_000);
        if (cached?.value === undefined) throw error;
        return { content: cached.value, observedAt: cached.checkedAt, stale: true, error: failure.message };
      }
    });
  }
}

/** Choices stay available, each read “… anyway” after the warning; the acknowledged
 * blocker ids travel back with the choice so the write can check them. */
function heedBlockers(result: JsonValue, blockers: { id: string; name: string; status: string }[]): JsonValue {
  const choices = result as unknown as ResourceChoices;
  if (!choices || !Array.isArray(choices.options)) return result;
  const warning = `Blocked by ${blockerList(blockers.map(blocker => `${blocker.name} (${blocker.status})`))}.`.slice(0, 240);
  return { ...choices, prompt: [warning, choices.prompt].filter(Boolean).join(' ').slice(0, 500), context: { ...choices.context, overrideBlockers: blockers.map(blocker => blocker.id).join(',') },
    options: choices.options.map(option => ({ ...option, label: `${option.label} anyway` })) } as unknown as JsonValue;
}
