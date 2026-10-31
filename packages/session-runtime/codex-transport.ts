import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, chmod, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import WebSocket from 'ws';
import { CodexRpc } from './codex-client.ts';
import { stopProcessTree } from '../platform/process-tree.ts';

const REMOTE_TOKEN_ENV = 'ACT_CODEX_REMOTE_TOKEN';
type CodexListener = 'unix' | 'websocket';

const unusedLoopbackPort = () => new Promise<number>((resolve, reject) => {
  const probe = createServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => { const { port } = probe.address() as { port: number }; probe.close(() => resolve(port)); });
});

/** Codex has no Unix socket listener on Windows. Every local account can reach a loopback port, so the server there demands a token only this launch knows. */
async function serverAddress(listener: CodexListener, directory: string) {
  if (listener === 'unix') {
    const endpoint = `unix://${join(directory, 'server.sock')}`;
    return { endpoint, url: `ws+unix://${join(directory, 'server.sock')}:/`, listen: [endpoint], headers: {}, terminal: { arguments: [], environment: {} } };
  }
  const endpoint = `ws://127.0.0.1:${await unusedLoopbackPort()}`, token = randomBytes(32).toString('hex');
  return { endpoint, url: `${endpoint}/`, listen: [endpoint, '--ws-auth', 'capability-token', '--ws-token-sha256', createHash('sha256').update(token).digest('hex')],
    headers: { Authorization: `Bearer ${token}` }, terminal: { arguments: ['--remote-auth-token-env', REMOTE_TOKEN_ENV], environment: { [REMOTE_TOKEN_ENV]: token } } };
}

/** Owns a private native server. It never connects to or stops the user's shared daemon. */
export async function openCodexTerminalServer(executable: string, options: { cwd: string; env: NodeJS.ProcessEnv; arguments?: string[]; timeout?: number; signal?: AbortSignal; owner?: { executable: string; entrypoint: string; electron: boolean }; listener?: CodexListener }) {
  options.signal?.throwIfAborted();
  // macOS Unix socket paths have a small limit; don't put them in Application Support.
  const directory = await mkdtemp(join(tmpdir(), 'act-codex-')); await chmod(directory, 0o700);
  if (options.signal?.aborted) { await rm(directory, { recursive: true, force: true }); options.signal.throwIfAborted(); }
  const address = await serverAddress(options.listener ?? (process.platform === 'win32' ? 'websocket' : 'unix'), directory);
  const args = [...options.arguments ?? [], 'app-server', '--listen', ...address.listen];
  const child = options.owner ? spawn(options.owner.executable, [options.owner.entrypoint, JSON.stringify({ executable, args, cwd: options.cwd })], {
    cwd: options.cwd, env: { ...options.env, ...(options.owner.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}) }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  }) : spawn(executable, args, { cwd: options.cwd, env: options.env, stdio: ['ignore', 'ignore', 'pipe'] });
  child.stderr!.resume();
  let failed: Error | undefined, socket: WebSocket | undefined, connecting: WebSocket | undefined, rpc: CodexRpc | undefined, closing: Promise<void> | undefined;
  const exited = new Promise<void>(resolve => { child.once('exit', () => resolve()); child.once('error', error => { failed = error; resolve(); }); });
  const close = () => closing ??= (async () => {
    options.signal?.removeEventListener('abort', abort);
    rpc?.close(); socket?.terminate(); connecting?.terminate();
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      const tree = stopProcessTree({ pid: child.pid, kill: signal => child.kill(signal) });
      await exited; tree.settle();
    }
    await rm(directory, { recursive: true, force: true });
  })();
  const abort = () => { void close().catch(() => {}); }; // Awaited and surfaced by the preparation path below.
  options.signal?.addEventListener('abort', abort, { once: true });
  try {
    const deadline = Date.now() + (options.timeout ?? 10_000);
    while (!socket) {
      options.signal?.throwIfAborted();
      if (failed || child.exitCode !== null || child.signalCode !== null) throw failed ?? new Error('Codex native server exited before startup');
      try {
        socket = await new Promise<WebSocket>((resolve, reject) => {
          const connection = new WebSocket(address.url, { headers: address.headers, perMessageDeflate: false, maxPayload: 8 * 1024 * 1024, handshakeTimeout: 1000 });
          connecting = connection;
          connection.once('open', () => resolve(connection));
          connection.once('error', error => { connection.terminate(); reject(error); });
        });
      } catch {
        options.signal?.throwIfAborted();
        if (Date.now() >= deadline) throw new Error('Codex native server startup timed out');
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
    connecting = undefined; options.signal?.throwIfAborted();
    const input = new PassThrough(), connection = socket;
    const output = new Writable({ write(chunk, _encoding, callback) { connection.send(String(chunk).trimEnd(), callback); } });
    connection.on('message', data => input.write(String(data) + '\n'));
    connection.on('close', () => input.end()); connection.on('error', error => input.destroy(error));
    rpc = new CodexRpc(input, output, () => connection.terminate());
    child.once('exit', () => rpc?.close(new Error('Codex native server exited')));
    await rpc.initialize();
    options.signal?.throwIfAborted();
    return { rpc, endpoint: address.endpoint, terminal: address.terminal, pid: child.pid!, close };
  } catch (error) { await close(); throw error; }
}
