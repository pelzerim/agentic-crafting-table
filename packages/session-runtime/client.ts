import { LocalRpcClient, connectSocket } from '../workspace-service/local-rpc.ts';
import { readWorkspaceSecret, workspacePaths } from '../workspace-service/paths.ts';
import { ensureLocalService } from '../workspace-service/launcher.ts';

export interface RuntimeOptions { directory: string; executable: string; entrypoint: string; electronRuntime: boolean }

export class SupervisorConnection {
  private options: RuntimeOptions;
  private client?: LocalRpcClient;
  private connecting?: Promise<LocalRpcClient>;
  private closed = false;
  private lifetime = new AbortController();
  private initialize?: (client: LocalRpcClient) => Promise<unknown>;
  private notified = new Set<(notification: { event: string; data: unknown }) => void>();
  private connected = new Set<() => void>();
  constructor(options: RuntimeOptions, initialize?: (client: LocalRpcClient) => Promise<unknown>) { this.options = options; this.initialize = initialize; }
  async connect() {
    if (this.closed) throw new Error('Supervisor connection closed');
    if (this.client) return this.client;
    if (!this.connecting) {
      const options = this.options;
      this.connecting = ensureLocalService(options.directory, options.executable, options.entrypoint, options.electronRuntime, connectSupervisor, this.lifetime.signal)
        .then(async client => {
          if (this.closed) { client.close(); throw new Error('Supervisor connection closed'); }
          let disconnected = false;
          client.once('disconnected', () => { disconnected = true; if (this.client === client) this.client = undefined; });
          client.on('notification', (notification: { event: string; data: unknown }) => { for (const listener of this.notified) listener(notification); });
          try { await this.initialize?.(client); } catch (error) { client.close(); throw error; }
          if (this.closed) { client.close(); throw new Error('Supervisor connection closed'); }
          if (disconnected) throw new Error('Supervisor disconnected while initializing');
          this.client = client;
          for (const listener of this.connected) listener();
          return client;
        }).catch(error => {
          if (this.closed) throw new Error('Supervisor connection closed', { cause: error });
          throw error;
        }).finally(() => { this.connecting = undefined; });
    }
    return this.connecting;
  }
  async call<T = unknown>(method: string, input?: unknown) { return (await this.connect()).call<T>(method, input); }
  /** Server events (`{ event, data }`) from whichever connection is live. */
  onNotification(listener: (notification: { event: string; data: unknown }) => void) { this.notified.add(listener); return () => { this.notified.delete(listener); }; }
  /** Fires after each (re)connection is ready; subscriptions do not survive a reconnect. */
  onConnect(listener: () => void) { this.connected.add(listener); return () => { this.connected.delete(listener); }; }
  close() { this.closed = true; this.lifetime.abort(); this.client?.close(); this.client = undefined; }
}

export async function connectSupervisor(directory: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const paths = workspacePaths(directory), secret = readWorkspaceSecret(paths.token);
  const client = new LocalRpcClient(await connectSocket(paths.socket, signal), secret);
  try {
    const hello = await client.call<{ protocol: number; service: string }>('hello');
    if (hello.protocol !== 1 || hello.service !== 'sessions') throw new Error('Incompatible session supervisor');
    return client;
  } catch (error) { client.close(); throw error; }
}
