import { EventEmitter } from 'node:events';
import { ensureWorkspace } from './launcher.ts';
import type { WorkspaceClient } from './client.ts';
import type { WorkspaceSnapshot } from './protocol.ts';

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
  snapshot?: WorkspaceSnapshot;
  constructor(directory: string, executable: string, entrypoint: string, electronRuntime = false) {
    super(); this.options = [directory, executable, entrypoint, electronRuntime];
  }
  connect(): Promise<WorkspaceClient> {
    if (this.disposed) return Promise.reject(new Error('Workspace connection closed'));
    if (this.client) return Promise.resolve(this.client);
    if (this.connecting) return this.connecting;
    this.emit('status', 'connecting');
    this.connecting = (async () => {
      const client = await ensureWorkspace(...this.options, this.lifetime.signal);
      if (this.disposed) { client.close(); throw new Error('Workspace connection closed'); }
      this.subscribing = client;
      let disconnected = false;
      client.on('snapshot', (snapshot: WorkspaceSnapshot) => {
        if (this.disposed || disconnected) return;
        this.cursor = snapshot.cursor; this.snapshot = snapshot; this.emit('snapshot', snapshot);
      });
      client.on('notification', value => {
        if (this.disposed || disconnected) return;
        if (value.event === 'settings') this.emit('settings', value.settings);
        if (value.event === 'recording-deleted') this.emit('recording-deleted', value.sessionId);
        if (value.event === 'reminder-due') this.emit('reminder-due', { reminder: value.reminder, day: value.day });
      });
      client.once('disconnected', () => { disconnected = true; if (this.client === client) this.client = undefined; this.scheduleReconnect(); });
      try {
        await client.subscribe(this.cursor);
        if (this.disposed) throw new Error('Workspace connection closed');
        if (disconnected) throw new Error('Workspace disconnected while subscribing');
        this.client = client; this.emit('status', 'connected'); return client;
      } catch (error) { client.close(); throw error; }
      finally { if (this.subscribing === client) this.subscribing = undefined; }
    })().catch(error => {
      if (this.disposed) throw new Error('Workspace connection closed', { cause: error });
      this.emit('status', 'disconnected'); this.scheduleReconnect(); throw error;
    })
      .finally(() => { this.connecting = undefined; });
    return this.connecting;
  }
  private scheduleReconnect() {
    if (this.disposed || this.retry) return;
    this.emit('status', 'disconnected');
    this.retry = setTimeout(() => { this.retry = undefined; void this.connect().catch(() => {}); }, 500);
  }
  async call<T = unknown>(method: string, args?: unknown): Promise<T> { return (await this.connect()).call<T>(method, args); }
  close() { this.disposed = true; clearTimeout(this.retry); this.lifetime.abort(); this.subscribing?.close(); this.client?.close(); this.client = undefined; }
}
