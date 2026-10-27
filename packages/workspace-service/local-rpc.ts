import { createConnection, createServer } from 'node:net';
import type { Socket } from 'node:net';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { addAbortListener, EventEmitter } from 'node:events';
import { chmodSync, rmSync } from 'node:fs';
import { CONNECTION_LOST, MAX_FRAME_BYTES, REQUEST_TIMEOUT, replyTimeout, serializeError } from './protocol.ts';

/** How long a received notification took to parse, and its length in characters. */
export interface FrameParse { parseMs: number; length: number }

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
          const started = performance.now(), response = JSON.parse(line);
          if (typeof response.event === 'string') { this.emit('notification', response, { parseMs: performance.now() - started, length: line.length } satisfies FrameParse); continue; }
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

export interface FrameDrop { at: number; queuedBytes: number; frameBytes: number; label: string }
/** Told about every frame a server writes, replaces or drops; `peer` is the writer's number. */
export interface FrameObserver {
  written?(peer: number, label: string, bytes: number): void;
  coalesced?(peer: number, label: string): void;
  dropped?(peer: number, drop: FrameDrop): void;
}
export interface EncodedFrame { data: string; bytes: number }
export const encodeFrame = (value: unknown): EncodedFrame => { const data = JSON.stringify(value) + '\n'; return { data, bytes: Buffer.byteLength(data) }; };

let writers = 0;
/** Writes newline-delimited frames to one client. A replaceable frame (a snapshot) waits while the
 * socket still has unsent data, a newer one replaces it, and the one left is written on 'drain'.
 * A frame that would take the backlog over MAX_FRAME_BYTES drops the client. */
export class FrameWriter {
  readonly peer = ++writers;
  private socket: Socket;
  private observer?: FrameObserver;
  private waiting?: { frame: EncodedFrame; label: string };
  constructor(socket: Socket, observer?: FrameObserver) {
    this.socket = socket; this.observer = observer;
    socket.on('drain', () => {
      const waiting = this.waiting; this.waiting = undefined;
      if (waiting) this.write(waiting.frame, waiting.label);
    });
  }
  send(value: unknown, label: string, options?: { replaceable?: boolean; flushed?: () => void }) {
    if (this.socket.destroyed) return;
    this.sendEncoded(encodeFrame(value), label, options);
  }
  sendEncoded(frame: EncodedFrame, label: string, options: { replaceable?: boolean; flushed?: () => void } = {}) {
    if (this.socket.destroyed) return;
    if (options.replaceable && (this.socket.writableNeedDrain || this.waiting)) {
      if (this.waiting) this.observer?.coalesced?.(this.peer, this.waiting.label);
      this.waiting = { frame, label }; return;
    }
    this.write(frame, label, options.flushed);
  }
  private write(frame: EncodedFrame, label: string, flushed?: () => void) {
    if (this.socket.destroyed) return;
    const queuedBytes = this.socket.writableLength;
    if (frame.bytes + queuedBytes > MAX_FRAME_BYTES) {
      console.error(`Local client dropped: ${queuedBytes} bytes queued, ${frame.bytes} bytes frame, ${label}`);
      this.observer?.dropped?.(this.peer, { at: Date.now(), queuedBytes, frameBytes: frame.bytes, label });
      this.socket.destroy(); return;
    }
    this.socket.write(frame.data, flushed);
    this.observer?.written?.(this.peer, label, frame.bytes);
  }
}

export interface RpcPeer { notify(event: string, data: unknown): void; onClose(listener: () => void): void }
export interface LocalServerOptions {
  observer?: FrameObserver;
  /** Runs each request's handler, so a caller can tell which method was running and for how long. */
  operation?<T>(method: string, run: () => Promise<T>): Promise<T>;
}
/** Callers must acquire process ownership before listening/removing a stale socket. */
export async function serveLocal(path: string, secret: string, handle: (method: string, args: unknown, peer: RpcPeer) => unknown | Promise<unknown>, options: LocalServerOptions = {}) {
  const sockets = new Set<Socket>();
  const server = createServer(socket => {
    sockets.add(socket); socket.setEncoding('utf8'); socket.setTimeout(5000, () => socket.destroy());
    socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {});
    const writer = new FrameWriter(socket, options.observer);
    const peer: RpcPeer = { notify: (event, data) => writer.send({ event, data }, event, { replaceable: event === 'snapshot' }), onClose: listener => socket.once('close', listener) };
    const request = async (line: string) => {
      let id = '', method = 'request';
      try {
        const value = JSON.parse(line);
        if (typeof value.id !== 'string' || value.id.length > 128) throw new Error('Invalid request ID'); id = value.id;
        if (typeof value.token !== 'string' || !/^[a-f0-9]{64}$/.test(value.token) || !timingSafeEqual(Buffer.from(value.token), Buffer.from(secret))) {
          writer.send({ id, error: { code: 'UNAUTHORIZED', message: 'Local service authentication failed' } }, method); socket.end(); return;
        }
        socket.setTimeout(0);
        if (typeof value.method !== 'string') throw new Error('Invalid method');
        method = value.method;
        const run = async () => handle(value.method, value.args ?? {}, peer);
        writer.send({ id, result: await (options.operation ? options.operation(method, run) : run()) }, method);
      } catch (error) { writer.send({ id, error: serializeError(error) }, method); }
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
