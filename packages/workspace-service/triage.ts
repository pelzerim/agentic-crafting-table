import { createHash, randomUUID } from 'node:crypto';
import { canonical, reduceCommands } from '../core/control.ts';
import type { WorkspaceControl, WorkspaceCommand, WorkspaceState, CommandEnvelope } from '../core/control.ts';
import type { ProviderConnection } from '../core/connections.ts';
import type { JsonObject } from '../../src/resource-plugins/types.ts';
import type { SqliteStore } from './sqlite-store.ts';
import { inBackground } from '../provider-runtime/request-budget.ts';

/** Work a provider says is waiting for the connected person. `key` is its stable identity;
 * `aliases` are other keys an existing item may use for it. `item` becomes a map item of
 * the adapter's type once the to-do is placed in a project. */
export interface TriageTicket { key: string; aliases: string[]; label: string; title: string; url?: string; status?: string; item: { title: string; data: JsonObject } }
export interface TriageAdapter {
  providerId: string; pluginId: string;
  /** The package setting that turns this import on. */
  setting: { plugin: string; key: string };
  /** Keys an existing item of this type answers to. */
  keys(data: JsonObject): string[];
  /** What the package's settings select, as a stable string; undefined when they select nothing,
   * which stops the import like its switch. A changed scope is read at once. */
  scope?(settings: JsonObject): string | undefined;
  /** `complete` is false only when the provider had more matching tickets than it returned; nothing
   * is removed then. Tickets the settings leave out are simply absent from a complete list. */
  discover(connection: ProviderConnection, signal: AbortSignal, settings: JsonObject): Promise<{ tickets: TriageTicket[]; complete: boolean }>;
}
/** Every ticket handled in its current assignment: imported (with the to-do and the title it was
 * given) or found already present. An entry outlives its to-do, so a dismissed ticket stays dismissed.
 * `held` keeps an entry whose ticket a settings change left out, until the ticket matches again. */
interface Entry { key: string; todoId?: string; title?: string; held?: true }
/** `scope` is the adapter scope of the last complete read. */
interface Checkpoint { account: string; entries: Entry[]; scope?: string; checkedAt?: number; nextAt?: number; retryAt?: number; error?: string }
export const TRIAGE_POLL_MS = 120_000;
const ledger = (connectionId: string) => `triage:${createHash('sha256').update(connectionId).digest('hex')}`;

/** Keeps one quiet inbox entry per ticket assigned to each connected account until a person takes it
 * into Next or Later (TODO-09). Never raises Needs me, never places anything on the map and never writes to the provider. */
export class TriageCoordinator {
  private store: SqliteStore; private control: WorkspaceControl; private adapters: TriageAdapter[]; private changed: () => Promise<void>;
  private readConnections: () => ProviderConnection[]; private settings: () => Readonly<Record<string, JsonObject>>; private enabled: () => boolean; private now: () => number;
  private pending = new Map<string, { controller: AbortController; promise: Promise<void>; scope: string; superseded?: true }>();
  /** Connections read since this service started or since their import was last switched on, with the scope they were read in. */
  private read = new Map<string, string>();
  private timer?: ReturnType<typeof setTimeout>; private paused = true; private generation = 0;
  constructor(store: SqliteStore, control: WorkspaceControl, adapters: TriageAdapter[], readConnections: () => ProviderConnection[], settings: () => Readonly<Record<string, JsonObject>>, changed: () => Promise<void>, enabled = () => true, now = Date.now) {
    this.store = store; this.control = control; this.adapters = adapters; this.readConnections = readConnections; this.settings = settings; this.changed = changed; this.enabled = enabled; this.now = now;
  }
  private adapter(connection: ProviderConnection) {
    const settings = this.settings();
    return this.adapters.find(adapter => adapter.providerId === connection.providerId && settings[adapter.setting.plugin]?.[adapter.setting.key] === true && this.scope(adapter, settings[adapter.setting.plugin]) !== undefined);
  }
  private scope(adapter: TriageAdapter, settings: JsonObject = this.settings()[adapter.setting.plugin] ?? {}) { return adapter.scope ? adapter.scope(settings) : ''; }
  private active() { return this.readConnections().filter(connection => connection.enabled && this.adapter(connection)); }
  private checkpoint(connection: ProviderConnection) { const saved = this.store.observation<Checkpoint>(ledger(connection.id)); return { ...saved, value: saved.value ?? { account: connection.account, entries: [] } }; }
  status() { return this.readConnections().filter(connection => this.adapter(connection)).map(connection => {
    const state = this.checkpoint(connection).value;
    return { connectionId: connection.id, providerId: connection.providerId, enabled: connection.enabled, checkedAt: state.checkedAt, nextAt: state.nextAt, error: state.error, working: this.pending.has(connection.id) };
  }); }
  start() { this.paused = false; this.schedule(0); }
  private schedule(delay = 5000) {
    clearTimeout(this.timer); if (this.paused) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.tick().catch(() => {}).finally(() => this.schedule()); }, delay); this.timer.unref();
  }
  async pause() { this.paused = true; this.generation++; clearTimeout(this.timer); for (const job of this.pending.values()) job.controller.abort(); await Promise.allSettled([...this.pending.values()].map(job => job.promise)); }
  settingsChanged() {
    const active = new Map(this.active().map(connection => [connection.id, this.scope(this.adapter(connection)!)]));
    // A read under way for other settings would reconcile against the wrong list.
    for (const [id, job] of this.pending) if (active.get(id) !== job.scope) { if (active.has(id)) job.superseded = true; job.controller.abort(); }
    for (const id of this.read.keys()) if (!active.has(id)) this.read.delete(id);
    if (!this.paused) this.schedule(0);
  }
  async tick() {
    if (this.paused || !this.enabled()) return;
    const active = this.active();
    for (const id of this.read.keys()) if (!active.some(connection => connection.id === id)) this.read.delete(id);
    for (const connection of active) {
      // Changed settings are read at once; otherwise the saved schedule decides.
      if (this.read.get(connection.id) === this.scope(this.adapter(connection)!) && !this.pending.get(connection.id)?.superseded && (this.checkpoint(connection).value.nextAt ?? 0) > this.now()) continue;
      await inBackground(() => this.sync(connection));
    }
  }
  /** A manual refresh reads now; a provider cooldown is still honoured. */
  async refresh(connectionId?: string) {
    if (!this.enabled()) return this.status();
    for (const connection of this.active().filter(connection => !connectionId || connection.id === connectionId)) await this.sync(connection);
    return this.status();
  }
  private sync(connection: ProviderConnection): Promise<void> {
    const old = this.pending.get(connection.id), generation = this.generation;
    if (old) return old.superseded ? old.promise.then(() => generation === this.generation ? this.sync(connection) : undefined) : old.promise;
    const adapter = this.adapter(connection); if (!adapter) return Promise.resolve();
    const settings = this.settings()[adapter.setting.plugin] ?? {}, scope = this.scope(adapter, settings)!; this.read.set(connection.id, scope);
    if ((this.checkpoint(connection).value.retryAt ?? 0) > this.now()) return Promise.resolve();
    const controller = new AbortController(), signal = AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)]);
    const promise = this.syncOnce(connection, adapter, settings, scope, signal).finally(() => this.pending.delete(connection.id));
    this.pending.set(connection.id, { controller, promise, scope }); return promise;
  }
  private current(connection: ProviderConnection) { return this.active().some(saved => saved.id === connection.id && saved.account === connection.account && saved.providerId === connection.providerId); }
  private async syncOnce(connection: ProviderConnection, adapter: TriageAdapter, settings: JsonObject, scope: string, signal: AbortSignal) {
    try {
      const old = this.checkpoint(connection).value;
      if (old.account !== connection.account) throw new Error('This account binding changed. Reconnect with a new binding.');
      const { tickets, complete } = await adapter.discover(connection, signal, settings); signal.throwIfAborted();
      // Tickets missing from the first complete list under new settings were left out by the settings, not by the provider.
      const narrowed = old.scope !== scope;
      const incoming = new Map<string, TriageTicket>();
      for (const ticket of tickets) {
        this.control.registry.createRecord(adapter.pluginId, 'validate', ticket.item);
        if (!incoming.has(ticket.key)) incoming.set(ticket.key, ticket);
      }
      const keys = [...new Set([...incoming.keys(), ...old.entries.map(entry => entry.key)])];
      // Read and validate the whole list first, then commit small batches, each atomic with its checkpoint.
      for (let offset = 0; offset < keys.length; offset += 20) { signal.throwIfAborted(); await this.applyBatch(connection, adapter, incoming, keys.slice(offset, offset + 20), complete, narrowed, signal); }
      const current = this.checkpoint(connection); signal.throwIfAborted(); if (!this.current(connection)) return;
      this.store.commitObservation(ledger(connection.id), current.revision, { ...current.value, ...(complete ? { scope } : {}), checkedAt: this.now(), nextAt: this.now() + TRIAGE_POLL_MS, error: undefined, retryAt: undefined });
    } catch (failure) {
      if (signal.aborted && signal.reason?.name !== 'TimeoutError') return;
      if (!this.current(connection)) return;
      // Failures stay in the checkpoint: no notice, no Needs me. The next read is delayed.
      const error = failure as Error & { retryAt?: number }, current = this.checkpoint(connection), retryAt = Math.max(this.now() + 30_000, error.retryAt ?? this.now() + TRIAGE_POLL_MS);
      this.store.commitObservation(ledger(connection.id), current.revision, { ...current.value, nextAt: retryAt, retryAt, error: error.message });
    }
  }
  /** The stable key matches under any account; an alias (a short name another workspace could reuse) only for this account or an unbound item. */
  private exists(state: WorkspaceState, adapter: TriageAdapter, connection: ProviderConnection, ticket: TriageTicket) {
    const key = ticket.key.toLowerCase(), aliases = new Set(ticket.aliases.map(alias => alias.toLowerCase()));
    return state.resources.some(resource => resource.pluginId === adapter.pluginId && adapter.keys(resource.data).map(found => found.toLowerCase())
      .some(found => found === key || aliases.has(found) && (!resource.connectionId || resource.connectionId === connection.id)))
      || state.todos.some(todo => todo.triage?.source === adapter.providerId && todo.triage.key.toLowerCase() === key);
  }
  private async applyBatch(connection: ProviderConnection, adapter: TriageAdapter, incoming: Map<string, TriageTicket>, keys: string[], complete: boolean, narrowed: boolean, signal: AbortSignal) {
    for (let retry = 0; retry < 5; retry++) {
      signal.throwIfAborted(); if (!this.current(connection)) throw new Error('Provider account changed during sync');
      const saved = this.checkpoint(connection), entries = new Map(saved.value.entries.map(entry => [entry.key, entry])), state = await this.control.read(), commands: WorkspaceCommand[] = [];
      let dirty = false;
      for (const key of keys) {
        const ticket = incoming.get(key), entry = entries.get(key), todo = entry?.todoId ? state.todos.find(todo => todo.id === entry.todoId && !todo.archivedAt && todo.triage) : undefined;
        // Untouched: still waiting in the inbox. A dismissed one waits hidden until its ticket changes.
        const waiting = todo?.horizon === 'inbox' ? todo : undefined, untouched = waiting && !waiting.dismissed ? waiting : undefined;
        if (ticket && entry) {
          const { held, ...kept } = entry, before = commands.length;
          if (todo) {
            // A taken to-do keeps a title the person changed; the ticket it carries stays current either way.
            const title = waiting || todo.title === entry.title ? ticket.title : todo.title;
            const triage = { ...todo.triage!, label: ticket.label, ...(ticket.url ? { url: ticket.url } : {}), ...(ticket.status ? { status: ticket.status } : {}), item: { ...todo.triage!.item, title: ticket.item.title, data: ticket.item.data } };
            if (title !== todo.title || canonical(triage) !== canonical(todo.triage)) commands.push({ type: 'todo.save', todo: { id: todo.id, title, completed: todo.completed, nodeIds: todo.nodeIds, triage } });
            if (waiting?.dismissed && (ticket.title !== waiting.dismissed.title || ticket.status !== waiting.dismissed.status)) commands.push({ type: 'todo.dismiss', id: todo.id, dismissed: false });
          }
          const next = { ...kept, ...(entry.title !== undefined && (!todo || waiting || todo.title === entry.title) ? { title: ticket.title } : {}) };
          if (commands.length === before && !held && canonical(next) === canonical(entry)) continue;
          entries.set(key, next);
        } else if (ticket) {
          // Present anywhere already (map, project, done, archive): remember it and never add a second one.
          if (this.exists(state, adapter, connection, ticket)) entries.set(key, { key });
          else {
            const todoId = randomUUID();
            commands.push({ type: 'todo.save', todo: { id: todoId, title: ticket.title, completed: false, nodeIds: [], horizon: 'inbox', triage: { source: adapter.providerId, key, label: ticket.label, ...(ticket.url ? { url: ticket.url } : {}), ...(ticket.status ? { status: ticket.status } : {}),
              item: { pluginId: adapter.pluginId, connectionId: connection.id, title: ticket.item.title, data: ticket.item.data } } } });
            entries.set(key, { key, todoId, title: ticket.title });
          }
        } else if (entry && complete) {
          // Gone from the list. An untouched entry goes with it and the ticket starts over if it returns.
          // A dismissed one goes too when the ticket itself left (unassigned, finished), so a reassigned
          // ticket shows again. Left out by a settings change, it is held so it stays dismissed.
          // Anything the person took is forgotten only when the ticket itself left.
          if (untouched || waiting && !narrowed && !entry.held) { commands.push({ type: 'todo.archive', id: waiting!.id }, { type: 'todo.remove', id: waiting!.id }); entries.delete(key); }
          else if (entry.held) continue;
          else if (narrowed) entries.set(key, { ...entry, held: true });
          else entries.delete(key);
        } else continue;
        dirty = true;
      }
      if (!dirty) return;
      const envelope: CommandEnvelope = { commandId: randomUUID(), expectedRevision: state.revision, actor: { kind: 'provider', id: connection.id }, commands };
      try {
        this.store.commitObservation(ledger(connection.id), saved.revision, { ...saved.value, entries: [...entries.values()] }, commands.length ? { envelope, reduce: state => reduceCommands(state, commands, envelope.expectedRevision, this.control.registry, this.store.readMapSizes(), envelope.actor) } : undefined);
        if (commands.length) await this.changed(); return;
      } catch (error) { if (!['REVISION_CONFLICT', 'OBSERVATION_CONFLICT'].includes((error as { code?: string }).code ?? '')) throw error; }
    }
    throw new Error('The workspace kept changing. The assigned-ticket import will retry.');
  }
}
