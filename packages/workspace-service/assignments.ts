import { createHash, randomUUID } from 'node:crypto';
import { canonical, reduceCommands } from '../core/control.ts';
import type { WorkspaceControl, WorkspaceCommand, WorkspaceState, CommandEnvelope } from '../core/control.ts';
import type { ProviderConnection } from '../core/connections.ts';
import type { JsonObject } from '../../src/resource-plugins/types.ts';
import type { SqliteStore } from './sqlite-store.ts';
import { isArchived } from '../../src/graph/archive.ts';
import { inBackground } from '../provider-runtime/request-budget.ts';

export interface DiscoveredAssignment { data: JsonObject; title: string; assigned: boolean }
export interface AssignmentEntry extends DiscoveredAssignment { key: string; cycle: string; viewedAt?: string; nodeId?: string }
interface Checkpoint { account: string; entries: AssignmentEntry[]; checkedAt?: number; nextAt?: number; retryAt?: number; error?: string }
export interface AssignmentAdapter {
  providerId: string; pluginId: string;
  /** Short Needs me reason for a new assignment, e.g. "Assigned to you". */
  attentionNote: string;
  key(data: JsonObject): string; group(data: JsonObject): string;
  discover(connection: ProviderConnection, previous: AssignmentEntry[], signal: AbortSignal): Promise<DiscoveredAssignment[]>;
}
export interface AssignmentReceipt { connectionId: string; key: string; cycle: string }
const scope = (connectionId: string) => `assignments:${createHash('sha256').update(connectionId).digest('hex')}`;
export class AssignmentCoordinator {
  private store: SqliteStore; private control: WorkspaceControl; private adapters: AssignmentAdapter[]; private changed: () => Promise<void>;
  private readConnections: () => ProviderConnection[]; private enabled: () => boolean; private now: () => number;
  private pending = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  private timer?: ReturnType<typeof setTimeout>; private paused = true;
  constructor(store: SqliteStore, control: WorkspaceControl, adapters: AssignmentAdapter[], readConnections: () => ProviderConnection[], changed: () => Promise<void>, enabled = () => true, now = Date.now) {
    this.store = store; this.control = control; this.adapters = adapters; this.readConnections = readConnections; this.changed = changed; this.enabled = enabled; this.now = now;
  }
  private connection(id: string) { const found = this.readConnections().find(connection => connection.id === id && connection.enabled); if (!found) throw new Error('Provider connection is disabled'); return found; }
  private checkpoint(connection: ProviderConnection) { const saved = this.store.observation<Checkpoint>(scope(connection.id)); return { ...saved, value: saved.value ?? { account: connection.account, entries: [] } }; }
  status() { return this.readConnections().filter(connection => this.adapters.some(adapter => adapter.providerId === connection.providerId)).map(connection => {
    const state = this.checkpoint(connection).value;
    return { connectionId: connection.id, providerId: connection.providerId, enabled: connection.enabled, checkedAt: state.checkedAt, nextAt: state.nextAt, error: state.error, working: this.pending.has(connection.id) };
  }); }
  start() { this.paused = false; this.schedule(0); }
  private schedule(delay = 5000) {
    clearTimeout(this.timer); if (this.paused) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.tick().catch(() => {}).finally(() => this.schedule()); }, delay); this.timer.unref();
  }
  async pause() { this.paused = true; clearTimeout(this.timer); for (const job of this.pending.values()) job.controller.abort(); await Promise.allSettled([...this.pending.values()].map(job => job.promise)); }
  settingsChanged() { for (const [id, job] of this.pending) if (!this.readConnections().some(connection => connection.id === id && connection.enabled)) job.controller.abort(); if (!this.paused) this.schedule(0); }
  async tick() {
    if (this.paused || !this.enabled()) return;
    for (const connection of this.readConnections().filter(connection => connection.enabled)) {
      if (!this.adapters.some(adapter => adapter.providerId === connection.providerId) || (this.checkpoint(connection).value.nextAt ?? 0) > this.now()) continue;
      await inBackground(() => this.sync(connection.id));
    }
  }
  async refresh(connectionId?: string) {
    if (!this.enabled()) throw new Error('Resume the workspace before syncing providers');
    for (const connection of this.readConnections().filter(connection => connection.enabled && (!connectionId || connection.id === connectionId))) await this.sync(connection.id);
    return this.status();
  }
  private sync(connectionId: string): Promise<void> {
    const old = this.pending.get(connectionId); if (old) return old.promise;
    const connection = this.connection(connectionId), adapter = this.adapters.find(adapter => adapter.providerId === connection.providerId);
    if (!adapter || (this.checkpoint(connection).value.retryAt ?? 0) > this.now()) return Promise.resolve();
    const controller = new AbortController(), signal = AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)]);
    const promise = this.syncOnce(connection, adapter, signal).finally(() => this.pending.delete(connectionId));
    this.pending.set(connectionId, { controller, promise }); return promise;
  }
  private async syncOnce(connection: ProviderConnection, adapter: AssignmentAdapter, signal: AbortSignal) {
    try {
      const old = this.checkpoint(connection).value;
      if (old.account !== connection.account) throw new Error('This account binding changed. Reconnect with a new binding.');
      const discovered = await adapter.discover(connection, old.entries, signal); signal.throwIfAborted();
      const incoming = new Map<string, DiscoveredAssignment>();
      for (const item of discovered) {
        this.control.registry.createRecord(adapter.pluginId, 'validate', item);
        const key = adapter.key(item.data);
        if (incoming.has(key) && canonical(incoming.get(key)) !== canonical(item)) throw new Error('Provider returned inconsistent assignment pages. Retry sync.');
        incoming.set(key, item);
      }
      const keys = [...new Set([...old.entries.map(entry => entry.key), ...incoming.keys()])];
      // Fetch and validate every page before touching attention. Commit small
      // graph batches, each atomic with its durable assignment checkpoint.
      for (let offset = 0; offset < keys.length; offset += 10) {
        signal.throwIfAborted(); await this.applyBatch(connection, adapter, incoming, keys.slice(offset, offset + 10), signal);
      }
      const current = this.checkpoint(connection); signal.throwIfAborted(); this.assertConnection(connection);
      this.store.commitObservation(scope(connection.id), current.revision, { ...current.value, checkedAt: this.now(), nextAt: this.now() + 60_000, error: undefined, retryAt: undefined });
    } catch (failure) {
      if (signal.aborted && signal.reason?.name !== 'TimeoutError') return;
      if (!this.readConnections().some(saved => saved.id === connection.id && saved.enabled && saved.account === connection.account)) return;
      const error = failure as Error & { retryAt?: number }, current = this.checkpoint(connection), retryAt = Math.max(this.now() + 30_000, error.retryAt ?? this.now() + 60_000);
      this.store.commitObservation(scope(connection.id), current.revision, { ...current.value, nextAt: retryAt, retryAt, error: error.message });
    }
  }
  private assertConnection(connection: ProviderConnection) { const current = this.connection(connection.id); if (current.account !== connection.account || current.providerId !== connection.providerId) throw new Error('Provider account changed during sync'); }
  private project(adapter: AssignmentAdapter, connection: ProviderConnection, data: JsonObject, state: WorkspaceState) {
    const group = adapter.group(data), matches = new Set<string>();
    for (const node of state.nodes) {
      if (!node.projectId || isArchived(node, state.nodes)) continue;
      const resource = state.resources.find(resource => resource.id === node.resourceId);
      if (resource?.pluginId === adapter.pluginId && (!resource.connectionId || resource.connectionId === connection.id) && adapter.group(resource.data) === group) matches.add(node.projectId);
    }
    return matches.size === 1 ? [...matches][0] : undefined;
  }
  private async applyBatch(connection: ProviderConnection, adapter: AssignmentAdapter, incoming: Map<string, DiscoveredAssignment>, keys: string[], signal: AbortSignal) {
    for (let retry = 0; retry < 5; retry++) {
      signal.throwIfAborted(); this.assertConnection(connection);
      const saved = this.checkpoint(connection), entries = new Map(saved.value.entries.map(entry => [entry.key, entry])), state = await this.control.read(), commands: WorkspaceCommand[] = [];
      for (const key of keys) {
        const old = entries.get(key), discovered = incoming.get(key), assigned = discovered?.assigned === true;
        if (!old && !assigned) continue;
        const item = discovered ?? old!, newCycle = assigned && !old?.assigned;
        const entry: AssignmentEntry = { ...item, key, assigned, cycle: newCycle ? randomUUID() : old!.cycle, viewedAt: newCycle ? undefined : old?.viewedAt, nodeId: old?.nodeId };
        const matches = state.resources.filter(resource => resource.pluginId === adapter.pluginId && (!resource.connectionId || resource.connectionId === connection.id) && adapter.key(resource.data) === key);
        const aliases = state.nodes.filter(node => matches.some(resource => resource.id === node.resourceId));
        let node = aliases.find(node => !isArchived(node, state.nodes)) ?? aliases[0];
        // A deliberate deletion stays deleted until a new assignment cycle.
        if (!node && assigned && (!old?.nodeId || newCycle)) {
          const projectId = this.project(adapter, connection, item.data, state), project = state.nodes.find(node => node.id === projectId);
          entry.nodeId = randomUUID();
          commands.push({ type: 'item.add', id: entry.nodeId, resourceId: randomUUID(), pluginId: adapter.pluginId, connectionId: connection.id, title: item.title, data: item.data, projectId, position: project?.position ?? { x: 0, y: 0 } });
          commands.push({ type: 'attention.set', id: entry.nodeId, source: `${adapter.providerId}.assignment`, reason: 'assigned', note: adapter.attentionNote });
        } else if (node) {
          entry.nodeId = node.id;
          for (const resource of matches.filter(resource => !resource.connectionId)) {
            const alias = aliases.find(node => node.resourceId === resource.id)!;
            commands.push({ type: 'item.bind', id: alias.id, connectionId: connection.id });
          }
          const source = `${adapter.providerId}.assignment`, reason = assigned && !entry.viewedAt ? 'assigned' : null;
          if (aliases.some(node => (node.attentionSources?.[source] ?? null) !== reason)) commands.push({ type: 'attention.set', id: node.id, source, reason, ...(reason ? { note: adapter.attentionNote } : {}) });
          for (const alias of aliases) if (alias.title !== item.title) commands.push({ type: 'node.update', id: alias.id, title: item.title });
        }
        entries.set(key, entry);
      }
      const envelope: CommandEnvelope = { commandId: randomUUID(), expectedRevision: state.revision, actor: { kind: 'provider', id: connection.id }, commands };
      try {
        this.store.commitObservation(scope(connection.id), saved.revision, { ...saved.value, entries: [...entries.values()] }, commands.length ? { envelope, reduce: state => reduceCommands(state, commands, envelope.expectedRevision, this.control.registry, this.store.readMapLayout(), envelope.actor) } : undefined);
        if (commands.length) await this.changed(); return;
      } catch (error) { if (!['REVISION_CONFLICT', 'OBSERVATION_CONFLICT'].includes((error as { code?: string }).code ?? '')) throw error; }
    }
    throw new Error('The workspace kept changing. Assignment sync will retry.');
  }
  async receipt(nodeId: string): Promise<AssignmentReceipt | undefined> {
    const state = await this.control.read(), resource = state.resources.find(resource => resource.id === state.nodes.find(node => node.id === nodeId)?.resourceId);
    if (!resource) return;
    const adapter = this.adapters.find(adapter => adapter.pluginId === resource.pluginId); if (!adapter) return;
    const connection = this.readConnections().find(connection => connection.providerId === adapter.providerId && connection.enabled && (resource.connectionId ? connection.id === resource.connectionId : connection.isDefault)); if (!connection) return;
    const key = adapter.key(resource.data), entry = this.checkpoint(connection).value.entries.find(entry => entry.key === key);
    return entry?.assigned && !entry.viewedAt ? { connectionId: connection.id, key, cycle: entry.cycle } : undefined;
  }
  async viewed(nodeId: string, receipt: AssignmentReceipt) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const actual = await this.receipt(nodeId); if (canonical(actual) !== canonical(receipt)) return { acknowledged: false };
      const connection = this.connection(receipt.connectionId), saved = this.checkpoint(connection), state = await this.control.read();
      const entry = saved.value.entries.find(entry => entry.key === receipt.key), resource = state.resources.find(resource => resource.id === state.nodes.find(node => node.id === nodeId)?.resourceId);
      const adapter = this.adapters.find(adapter => adapter.providerId === connection.providerId && adapter.pluginId === resource?.pluginId);
      if (!entry?.assigned || entry.viewedAt || entry.cycle !== receipt.cycle || resource?.connectionId !== connection.id || !adapter || adapter.key(resource.data) !== receipt.key) return { acknowledged: false };
      const entries = saved.value.entries.map(entry => entry.key === receipt.key && entry.cycle === receipt.cycle ? { ...entry, viewedAt: new Date(this.now()).toISOString() } : entry);
      const commands: WorkspaceCommand[] = [{ type: 'attention.set', id: nodeId, source: `${connection.providerId}.assignment`, reason: null }];
      const envelope: CommandEnvelope = { commandId: randomUUID(), expectedRevision: state.revision, actor: { kind: 'user', id: 'item-view' }, commands };
      try { this.store.commitObservation(scope(connection.id), saved.revision, { ...saved.value, entries }, { envelope, reduce: state => reduceCommands(state, commands, envelope.expectedRevision, this.control.registry, this.store.readMapLayout(), envelope.actor) }); await this.changed(); return { acknowledged: true }; }
      catch (error) { if (!['REVISION_CONFLICT', 'OBSERVATION_CONFLICT'].includes((error as { code?: string }).code ?? '')) throw error; }
    }
    throw new Error('Attention changed while opening the item. Refresh to acknowledge it.');
  }
}
