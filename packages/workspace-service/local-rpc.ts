import { createConnection, createServer } from 'node:net';
import type { Socket } from 'node:net';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { addAbortListener, EventEmitter } from 'node:events';
import { chmodSync, rmSync } from 'node:fs';
import { CONNECTION_LOST, MAX_FRAME_BYTES, REQUEST_TIMEOUT, replyTimeout, serializeError } from './protocol.ts';

export class LocalRpcClient extends EventEmitter {
  private socket: Socket;
  private secret: string;
  private pending = new Map<string, { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private closed = false;
  constructor(socket: Socket, secret: string) {
    super(); this.socket = socket; this.secret = secret;
    socket.setEncoding('utf8'); let buffer = '';
    socket.on('data', (data: string) => {
      buffer += data;
      if (Buffer.byteLength(buffer) > MAX_FRAME_BYTES) { socket.destroy(new Error('Local service response exceeded frame limit')); return; }
      let newline: number;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        try {
          const response = JSON.parse(line);
          if (typeof response.event === 'string') { this.emit('notification', response); continue; }
          const pending = this.pending.get(response.id);
          if (!pending) continue;
          clearTimeout(pending.timer); this.pending.delete(response.id);
          if (response.error) pending.reject(Object.assign(new Error(response.error.message), response.error)); else pending.resolve(response.result);
        } catch (error) { socket.destroy(error as Error); return; }
      }
    });
    const disconnected = (error?: Error) => {
      if (this.closed) return; this.closed = true;
      // Calls may already have executed: keep CONNECTION_LOST for reconciliation,
      // but do not erase the socket error needed by local diagnostics.
      const failure = Object.assign(new Error(error?.message ?? 'Local service disconnected', error ? { cause: error } : undefined), { code: CONNECTION_LOST });
      for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(failure); }
      this.pending.clear(); this.emit('disconnected', error);
    };
    socket.on('error', disconnected); socket.on('close', () => disconnected());
  }
  async call<T = unknown>(method: string, args: unknown = {}): Promise<T> {
    if (this.closed) throw Object.assign(new Error('Local service disconnected'), { code: CONNECTION_LOST });
    const id = randomUUID(), data = JSON.stringify({ id, token: this.secret, method, args }) + '\n';
    if (Buffer.byteLength(data) + this.socket.writableLength > MAX_FRAME_BYTES) throw new Error('Local service request exceeded frame limit');
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(Object.assign(new Error(`${method} timed out; reconcile before retrying`), { code: REQUEST_TIMEOUT })); }, replyTimeout(method));
      this.pending.set(id, { resolve, reject, timer }); this.socket.write(data);
    });
  }
  close() { this.socket.destroy(); }
}

export async function connectSocket(path: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  // Keep cancellation attached for the socket's lifetime, including hello and
  // initialization before a connection owner can expose the ready client.
  const socket = createConnection(path);
  const cancellation = signal && addAbortListener(signal, () => socket.destroy(Object.assign(
    new Error('Local connection aborted', { cause: signal.reason }), { name: 'AbortError', code: 'ABORT_ERR' },
  )));
  socket.once('close', () => cancellation?.[Symbol.dispose]());
  await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
  return socket;
}

export interface RpcPeer { notify(event: string, data: unknown): void; onClose(listener: () => void): void }
/** Callers must acquire process ownership before listening/removing a stale socket. */
export async function serveLocal(path: string, secret: string, handle: (method: string, args: unknown, peer: RpcPeer) => unknown | Promise<unknown>) {
  const sockets = new Set<Socket>();
  const server = createServer(socket => {
    sockets.add(socket); socket.setEncoding('utf8'); socket.setTimeout(5000, () => socket.destroy());
    socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {});
    const send = (value: unknown) => {
      const data = JSON.stringify(value) + '\n';
      if (socket.destroyed) return;
      if (Buffer.byteLength(data) + socket.writableLength > MAX_FRAME_BYTES) { socket.destroy(); return; }
      socket.write(data);
    };
    const peer: RpcPeer = { notify: (event, data) => send({ event, data }), onClose: listener => socket.once('close', listener) };
    const request = async (line: string) => {
      let id = '';
      try {
        const value = JSON.parse(line);
        if (typeof value.id !== 'string' || value.id.length > 128) throw new Error('Invalid request ID'); id = value.id;
        if (typeof value.token !== 'string' || !/^[a-f0-9]{64}$/.test(value.token) || !timingSafeEqual(Buffer.from(value.token), Buffer.from(secret))) {
          send({ id, error: { code: 'UNAUTHORIZED', message: 'Local service authentication failed' } }); socket.end(); return;
        }
        socket.setTimeout(0);
        if (typeof value.method !== 'string') throw new Error('Invalid method');
        send({ id, result: await handle(value.method, value.args ?? {}, peer) });
      } catch (error) { send({ id, error: serializeError(error) }); }
    };
    let buffer = '';
    socket.on('data', (data: string) => {
      buffer += data;
      if (Buffer.byteLength(buffer) > MAX_FRAME_BYTES) { socket.destroy(); return; }
      let newline: number;
      while ((newline = buffer.indexOf('\n')) !== -1) { const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1); if (line) void request(line); }
    });
  });
  rmSync(path, { force: true });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(path, () => { server.removeListener('error', reject); resolve(); }); });
  chmodSync(path, 0o600);
  return { async close() { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(path, { force: true }); } };
}
