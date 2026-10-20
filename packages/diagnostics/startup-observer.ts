import { createConnection } from 'node:net';
import { performance } from 'node:perf_hooks';
import { WorkspaceClient } from '../workspace-service/client.ts';
import { readWorkspaceSecret, workspacePaths } from '../workspace-service/paths.ts';
import { PROTOCOL_VERSION } from '../workspace-service/protocol.ts';
import type { WorkspaceSnapshot } from '../workspace-service/protocol.ts';

type Phase = 'waiting' | 'connect' | 'hello' | 'snapshot' | 'ready' | 'stopped';
type FailureCode = 'ENOENT' | 'ECONNREFUSED' | 'TIMEOUT' | 'UNAUTHORIZED' | 'CONNECTION_LOST' | 'INCOMPATIBLE' | 'OTHER';
export interface StartupFailure { attempt: number; phase: Exclude<Phase, 'ready' | 'stopped'>; code: FailureCode; elapsedMs: number }
export interface StartupObservation {
  phase: Phase; attempts: number; elapsedMs: number; failures: StartupFailure[];
  serviceReadyMs?: number; snapshotReadyMs?: number; nodes?: number; links?: number;
  lastFailure?: FailureCode;
}
const knownErrors = new Set(['ENOENT', 'ECONNREFUSED', 'TIMEOUT', 'UNAUTHORIZED', 'CONNECTION_LOST', 'INCOMPATIBLE']);
function failureCode(error: unknown): FailureCode {
  const value = error as { code?: string; cause?: { code?: string } };
  const cause = value?.code === 'CONNECTION_LOST' ? value.cause?.code : undefined;
  const code = knownErrors.has(cause ?? '') ? cause : value?.code;
  return knownErrors.has(code ?? '') ? code as FailureCode : 'OTHER';
}

/** Read-only test/support probe: never starts a service and retains only counts,
 * phase timings and allowlisted error codes, not graph data, paths or error text. */
export function observeWorkspaceStartup(directory: string) {
  const started = performance.now(), paths = workspacePaths(directory);
  const state: StartupObservation = { phase: 'waiting', attempts: 0, elapsedMs: 0, failures: [] };
  let stopped = false, client: WorkspaceClient | undefined, wake: (() => void) | undefined;
  let pendingPhase: StartupFailure['phase'] = 'waiting';
  const enter = (phase: StartupFailure['phase']) => { pendingPhase = phase; state.phase = phase; };
  const elapsed = () => Math.round((performance.now() - started) * 10) / 10;
  const snapshot = (): StartupObservation => ({ ...state, elapsedMs: elapsed(), failures: state.failures.map(failure => ({ ...failure })) });
  const run = async () => {
    while (!stopped && elapsed() < 15_000) {
      state.attempts++; enter('waiting');
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const secret = readWorkspaceSecret(paths.token), socket = createConnection(paths.socket);
        enter('connect');
        socket.once('connect', () => { if (!stopped) enter('hello'); });
        client = new WorkspaceClient(socket, secret);
        // Bound each probe independently of the production RPC timeout. Closing
        // destroys any pending call; no connection can outlive stop().
        timer = setTimeout(() => socket.destroy(Object.assign(new Error('Startup probe timeout'), { code: 'TIMEOUT' })), 1000);
        const hello = await client.call<{ protocol: number }>('hello');
        if (hello.protocol !== PROTOCOL_VERSION) throw Object.assign(new Error('Incompatible protocol'), { code: 'INCOMPATIBLE' });
        state.serviceReadyMs ??= elapsed(); enter('snapshot');
        const snapshot = await client.call<WorkspaceSnapshot>('read');
        state.snapshotReadyMs = elapsed(); state.nodes = snapshot.state.nodes.length; state.links = snapshot.state.links.length; state.phase = 'ready';
        return;
      } catch (error) {
        if (stopped) return;
        state.lastFailure = failureCode(error);
        state.failures.push({ attempt: state.attempts, phase: pendingPhase, code: state.lastFailure, elapsedMs: elapsed() });
        if (state.failures.length > 8) state.failures.shift();
      } finally { clearTimeout(timer); client?.close(); client = undefined; state.elapsedMs = elapsed(); }
      await new Promise<void>(resolve => { const timer = setTimeout(() => { wake = undefined; resolve(); }, 100); wake = () => { clearTimeout(timer); wake = undefined; resolve(); }; });
    }
  };
  const done = run();
  return {
    snapshot,
    async stop() { stopped = true; wake?.(); client?.close(); await done; if (state.phase !== 'ready') state.phase = 'stopped'; return snapshot(); },
  };
}
