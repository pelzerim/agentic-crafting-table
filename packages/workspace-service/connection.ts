import { EventEmitter } from 'node:events';
import { ensureWorkspace } from './launcher.ts';
import type { WorkspaceClient } from './client.ts';
import type { FrameParse } from './local-rpc.ts';
import type { WorkspaceSnapshot } from './protocol.ts';
import type { MapLayer } from '../../src/graph/layers.ts';

const KEPT_CONNECTION_EVENTS = 50;
const KEPT_SLOWEST_SNAPSHOTS = 20;

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected';
/** One status change of the workspace connection; `reason` is the socket error, `closed`, or `subscribe failed: …`. */
export interface ConnectionEvent { at: string; status: ConnectionStatus; reason?: string }
/** How long one snapshot took to parse and to forward to the windows. */
export interface SnapshotDelivery { at: string; parseMs: number; forwardMs: number; totalMs: number; length: number }

/** Reconnects the transport; never silently replays an uncertain mutation. */
export class WorkspaceConnection extends EventEmitter {
  private options: [string, string, string, boolean];
  private client?: WorkspaceClient;
  private subscribing?: WorkspaceClient;
  private connecting?: Promise<WorkspaceClient>;
  private retry?: ReturnType<typeof setTimeout>;
  private disposed = false;
  private lifetime = new AbortController();
  private cursor = 0;
  private layer?: MapLayer;
  private events: ConnectionEvent[] = [];
  private slowestSnapshots: SnapshotDelivery[] = [];
  snapshot?: WorkspaceSnapshot;
  /** `subscribe: false` connects for requests only: no snapshots are sent to it, for callers such as an agent's MCP bridge that read on demand. */
  private readonly subscribes: boolean;
  constructor(directory: string, executable: string, entrypoint: string, electronRuntime = false, mode: { subscribe?: boolean } = {}) {
    super(); this.options = [directory, executable, entrypoint, electronRuntime]; this.subscribes = mode.subscribe !== false;
  }
  connect(): Promise<WorkspaceClient> {
    if (this.disposed) return Promise.reject(new Error('Workspace connection closed'));
    if (this.client) return Promise.resolve(this.client);
    if (this.connecting) return this.connecting;
    this.setStatus('connecting');
    let subscribing = false;
    this.connecting = (async () => {
      const client = await ensureWorkspace(...this.options, this.lifetime.signal);
      if (this.disposed) { client.close(); throw new Error('Workspace connection closed'); }
      this.subscribing = client;
      let disconnected = false;
      client.on('snapshot', (snapshot: WorkspaceSnapshot, parse?: FrameParse) => {
        if (this.disposed || disconnected) return;
        this.cursor = snapshot.cursor; this.snapshot = snapshot; this.emit('snapshot', snapshot, parse);
      });
      client.on('notification', value => {
        if (this.disposed || disconnected) return;
        if (value.event === 'settings') this.emit('settings', value.settings);
        if (value.event === 'recording-deleted') this.emit('recording-deleted', value.sessionId);
        if (value.event === 'reminder-due') this.emit('reminder-due', { reminder: value.reminder, day: value.day });
      });
      client.once('disconnected', (error?: Error) => { disconnected = true; if (this.client === client) this.client = undefined; this.scheduleReconnect(error?.message ?? 'closed'); });
      try {
        subscribing = this.subscribes;
        if (subscribing) await client.subscribe(this.cursor, this.layer);
        if (this.disposed) throw new Error('Workspace connection closed');
        if (disconnected) throw new Error('Workspace disconnected while subscribing');
        this.client = client; this.setStatus('connected'); return client;
      } catch (error) { client.close(); throw error; }
      finally { if (this.subscribing === client) this.subscribing = undefined; }
    })().catch(error => {
      if (this.disposed) throw new Error('Workspace connection closed', { cause: error });
      const reason = subscribing ? `subscribe failed: ${(error as Error).message}` : (error as Error).message;
      this.setStatus('disconnected', reason); this.scheduleReconnect(reason); throw error;
    })
      .finally(() => { this.connecting = undefined; });
    return this.connecting;
  }
  private scheduleReconnect(reason: string) {
    if (this.disposed || this.retry) return;
    this.setStatus('disconnected', reason);
    this.retry = setTimeout(() => { this.retry = undefined; void this.connect().catch(() => {}); }, 500);
  }
  /** Emits `status` as before; records the change, unless it repeats the last one, and emits it as `connection-event`. */
  private setStatus(status: ConnectionStatus, reason?: string) {
    const last = this.events.at(-1);
    if (last?.status !== status || last.reason !== reason) {
      const event: ConnectionEvent = { at: new Date().toISOString(), status, ...(reason ? { reason } : {}) };
      this.events.push(event); if (this.events.length > KEPT_CONNECTION_EVENTS) this.events.shift();
      this.emit('connection-event', event);
    }
    this.emit('status', status);
  }
  /** Keeps the slowest snapshot deliveries by parse plus forward time. */
  recordSnapshotDelivery(parse: FrameParse | undefined, forwardMs: number) {
    const parseMs = parse?.parseMs ?? 0, totalMs = parseMs + forwardMs, round = (ms: number) => Math.round(ms * 10) / 10;
    if (this.slowestSnapshots.length >= KEPT_SLOWEST_SNAPSHOTS && totalMs <= this.slowestSnapshots.at(-1)!.totalMs) return;
    this.slowestSnapshots.push({ at: new Date().toISOString(), parseMs: round(parseMs), forwardMs: round(forwardMs), totalMs: round(totalMs), length: parse?.length ?? 0 });
    this.slowestSnapshots.sort((a, b) => b.totalMs - a.totalMs);
    if (this.slowestSnapshots.length > KEPT_SLOWEST_SNAPSHOTS) this.slowestSnapshots.pop();
  }
  connectionEvents() { return { events: [...this.events], slowestSnapshots: [...this.slowestSnapshots] }; }
  /** Subscribes on `layer` from now on and across reconnects; while connected, the service answers with that layer's snapshot, which is also emitted. */
  async setLayer(layer: MapLayer): Promise<WorkspaceSnapshot | undefined> {
    if (this.layer === layer && this.client) return this.snapshot;
    this.layer = layer;
    const client = this.client ?? await this.connecting?.catch(() => undefined);
    return client && this.layer === layer ? client.subscribe(this.cursor, layer) : undefined;
  }
  async call<T = unknown>(method: string, args?: unknown): Promise<T> { return (await this.connect()).call<T>(method, args); }
  close() { this.disposed = true; clearTimeout(this.retry); this.lifetime.abort(); this.subscribing?.close(); this.client?.close(); this.client = undefined; }
}
