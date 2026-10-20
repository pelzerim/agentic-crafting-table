import { spawn } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { EventEmitter } from 'node:events';
import * as z from 'zod/v4';

const MAX_FRAME = 8 * 1024 * 1024;
/** A bounded native JSON-RPC connection. It never approves server requests. */
export class CodexRpc extends EventEmitter {
  private buffer = '';
  private sequence = 0;
  private closed = false;
  private pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private output: Writable; private dispose: () => void; private timeout: number;
  constructor(input: Readable, output: Writable, dispose: () => void, timeout = 10_000) {
    super(); this.output = output; this.dispose = dispose; this.timeout = timeout; input.setEncoding('utf8');
    input.on('data', data => this.receive(String(data)));
    input.once('end', () => this.close(new Error('Codex disconnected')));
    input.once('error', error => this.close(error)); output.once('error', error => this.close(error));
  }
  private receive(data: string) {
    this.buffer += data;
    if (Buffer.byteLength(this.buffer) > MAX_FRAME) { this.close(new Error('Codex response exceeded its size limit')); return; }
    let newline: number;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline); this.buffer = this.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let frame: { id?: number | string; method?: string; params?: unknown; result?: unknown; error?: { message?: string; code?: number } };
      try { frame = JSON.parse(line); if (!frame || typeof frame !== 'object') throw new Error(); }
      catch { this.close(new Error('Codex sent an invalid protocol frame')); return; }
      if (typeof frame.method === 'string') {
        if (frame.id !== undefined) this.send({ id: frame.id, error: { code: -32601, message: 'This observer cannot handle requests. Use the native terminal.' } });
        else this.emit('notification', { method: frame.method, params: frame.params });
        continue;
      }
      const pending = typeof frame.id === 'number' ? this.pending.get(frame.id) : undefined;
      if (!pending) continue;
      this.pending.delete(Number(frame.id)); clearTimeout(pending.timer);
      if (frame.error) pending.reject(Object.assign(new Error(String(frame.error.message ?? 'Codex request failed').slice(0, 2000)), { code: frame.error.code }));
      else pending.resolve(frame.result);
    }
  }
  private send(frame: unknown) {
    if (this.closed) throw new Error('Codex connection is closed');
    const encoded = JSON.stringify(frame) + '\n';
    if (Buffer.byteLength(encoded) + this.output.writableLength > MAX_FRAME) throw new Error('Codex request exceeded its size limit');
    this.output.write(encoded);
  }
  request<T = unknown>(method: string, params: unknown = {}): Promise<T> {
    if (this.closed) return Promise.reject(new Error('Codex connection is closed'));
    return new Promise<T>((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Codex timed out during ${method}`)); }, this.timeout);
      this.pending.set(id, { resolve: value => resolve(value as T), reject, timer });
      try { this.send({ id, method, params }); } catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  async initialize() {
    await this.request('initialize', { clientInfo: { name: 'agent-crafting-table', title: 'Agentic Crafting Table', version: '0.1.0' } });
    this.send({ method: 'initialized', params: {} });
  }
  close(error = new Error('Codex connection closed')) {
    if (this.closed) return; this.closed = true;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear(); this.dispose(); this.emit('closed', error);
  }
}

const model = z.object({ id: z.string(), model: z.string(), displayName: z.string(), hidden: z.boolean(), isDefault: z.boolean(),
  supportedReasoningEfforts: z.array(z.object({ reasoningEffort: z.string() })), defaultReasoningEffort: z.string(),
});
const thread = z.object({ id: z.string().uuid(), name: z.string().nullish(), preview: z.string().default(''), cwd: z.string(),
  updatedAt: z.number(), model: z.string().nullish(), status: z.object({ type: z.string(), activeFlags: z.array(z.string()).optional() }),
  gitInfo: z.object({ branch: z.string().nullish() }).nullish(),
});
const cursor = z.string().nullish();
export type CodexModel = z.infer<typeof model>;
export type CodexThread = z.infer<typeof thread>;
export class CodexMetadata {
  readonly rpc: CodexRpc;
  constructor(rpc: CodexRpc) { this.rpc = rpc; }
  async models(cursorValue?: string) { return z.object({ data: z.array(model), nextCursor: cursor }).parse(await this.rpc.request('model/list', { limit: 100, cursor: cursorValue })); }
  async sessions(options: { cursor?: string; query?: string; limit?: number } = {}) {
    return z.object({ data: z.array(thread), nextCursor: cursor }).parse(await this.rpc.request('thread/list', {
      cursor: options.cursor, searchTerm: options.query || undefined, limit: options.limit ?? 50,
      sortKey: 'updated_at', useStateDbOnly: true,
    }));
  }
  async session(id: string) { return z.object({ thread }).parse(await this.rpc.request('thread/read', { threadId: z.string().uuid().parse(id), includeTurns: false })).thread; }
  async skills(cwd: string) {
    return z.object({ data: z.array(z.object({ cwd: z.string(), skills: z.array(z.object({ name: z.string().min(1).max(200), description: z.string().max(16_000), path: z.string().min(1).max(4096), scope: z.string(), enabled: z.boolean() })).max(5000), errors: z.array(z.object({ path: z.string(), message: z.string() })) })) })
      .parse(await this.rpc.request('skills/list', { cwds: [cwd], forceReload: true }));
  }
}
/** Dedicated metadata process, never the user's shared daemon. No turns are started. */
export async function openCodexMetadata(executable: string, options: { env?: NodeJS.ProcessEnv; prefixArgs?: string[]; timeout?: number } = {}) {
  const child = spawn(executable, [...options.prefixArgs ?? [], 'app-server', '--stdio'], { env: options.env ?? process.env, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stderr.resume(); // Native diagnostics may contain private paths; do not expose them as metadata.
  const rpc = new CodexRpc(child.stdout, child.stdin, () => {
    child.stdin.end(); child.kill('SIGTERM');
    const force = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 1000); force.unref();
    child.once('exit', () => clearTimeout(force));
  }, options.timeout);
  child.once('error', error => rpc.close(error));
  try { await rpc.initialize(); return new CodexMetadata(rpc); } catch (error) { rpc.close(); throw error; }
}
