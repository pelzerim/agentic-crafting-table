import type { Socket } from 'node:net';
import { readWorkspaceSecret, workspacePaths } from './paths.ts';
import { PROTOCOL_VERSION } from './protocol.ts';
import type { WireError, WorkspaceSnapshot } from './protocol.ts';
import { LocalRpcClient, connectSocket } from './local-rpc.ts';

export class WorkspaceClient extends LocalRpcClient {
  private cursor = -1;
  private plots?: number;
  private projectSummaries?: number;
  private reminders?: number;
  constructor(socket: Socket, secret: string) {
    super(socket, secret);
    this.on('notification', response => { if (response.event === 'snapshot') this.acceptSnapshot(response.snapshot); });
  }
  /** A plot, project summary or reminder change keeps the cursor; its own revision still makes it news. */
  private acceptSnapshot(snapshot: WorkspaceSnapshot) {
    if (snapshot.cursor < this.cursor || (snapshot.cursor === this.cursor && snapshot.plots?.revision === this.plots && snapshot.projectSummaries?.revision === this.projectSummaries && snapshot.reminders?.revision === this.reminders)) return;
    this.cursor = snapshot.cursor; this.plots = snapshot.plots?.revision; this.projectSummaries = snapshot.projectSummaries?.revision; this.reminders = snapshot.reminders?.revision; this.emit('snapshot', snapshot);
  }
  async subscribe(after = 0) { const snapshot = await this.call<WorkspaceSnapshot>('subscribe', { after }); this.acceptSnapshot(snapshot); return snapshot; }
}

export async function connectWorkspace(directory: string, signal?: AbortSignal): Promise<WorkspaceClient> {
  signal?.throwIfAborted();
  const paths = workspacePaths(directory), secret = readWorkspaceSecret(paths.token);
  const client = new WorkspaceClient(await connectSocket(paths.socket, signal), secret);
  try {
    const hello = await client.call<{ protocol: number }>('hello');
    if (hello.protocol !== PROTOCOL_VERSION) throw new Error('Workspace service protocol is incompatible; restart the service with this app version');
    return client;
  } catch (error) { client.close(); throw error; }
}
export type WorkspaceClientError = Error & WireError;
