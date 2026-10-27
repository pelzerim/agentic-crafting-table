import type { Socket } from 'node:net';
import { readWorkspaceSecret, workspacePaths } from './paths.ts';
import { PROTOCOL_VERSION } from './protocol.ts';
import type { WireError, WorkspaceSnapshot } from './protocol.ts';
import { LocalRpcClient, connectSocket } from './local-rpc.ts';
import type { FrameParse } from './local-rpc.ts';
import type { MapLayer } from '../../src/graph/layers.ts';

export class WorkspaceClient extends LocalRpcClient {
  private cursor = -1;
  private plots?: number;
  private projectSummaries?: number;
  private reminders?: number;
  private layer?: MapLayer;
  constructor(socket: Socket, secret: string) {
    super(socket, secret);
    this.on('notification', (response, parse?: FrameParse) => { if (response.event === 'snapshot') this.acceptSnapshot(response.snapshot, parse); });
  }
  /** A plot, project summary or reminder change keeps the cursor; its own revision still makes it news. */
  private acceptSnapshot(snapshot: WorkspaceSnapshot, parse?: FrameParse, answer = false) {
    if (snapshot.layer && snapshot.layer !== this.layer) return;
    if (!answer && (snapshot.cursor < this.cursor || (snapshot.cursor === this.cursor && snapshot.plots?.revision === this.plots && snapshot.projectSummaries?.revision === this.projectSummaries && snapshot.reminders?.revision === this.reminders))) return;
    this.cursor = snapshot.cursor; this.plots = snapshot.plots?.revision; this.projectSummaries = snapshot.projectSummaries?.revision; this.reminders = snapshot.reminders?.revision; this.emit('snapshot', snapshot, parse);
  }
  /** With a `layer`, snapshots arrive presented for it; subscribing again with another layer answers with that layer at once,
   * and a snapshot of the layer left that was still on its way is ignored. */
  async subscribe(after = 0, layer?: MapLayer) {
    this.layer = layer;
    const snapshot = await this.call<WorkspaceSnapshot>('subscribe', { after, ...(layer ? { layer } : {}) });
    if (this.layer === layer) this.acceptSnapshot(snapshot, undefined, true);
    return snapshot;
  }
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
