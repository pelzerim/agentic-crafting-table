import type { LaunchRequest, NativeAgentState } from './protocol.ts';
import { openCodexTerminalServer } from './codex-transport.ts';
import { codexInput, codexStatus } from './codex-status.ts';
import * as z from 'zod/v4';
import { randomUUID } from 'node:crypto';

export interface NativeDriver { args: string[]; close(): Promise<void> }
export async function prepareNativeDriver(request: LaunchRequest, env: NodeJS.ProcessEnv, observe: (state: NativeAgentState) => void, disconnected: (error: Error) => void, owner?: { executable: string; entrypoint: string; electron: boolean }, signal?: AbortSignal): Promise<NativeDriver | undefined> {
  signal?.throwIfAborted();
  if (!request.native) return;
  const native = request.native;
  const server = await openCodexTerminalServer(request.executable, { cwd: request.cwd, env, arguments: native.serverArguments, owner, signal });
  let closing = false;
  try {
    const method = native.nativeSessionId ? 'thread/resume' : 'thread/start';
    const response = z.object({ thread: z.object({ id: z.string().uuid() }) }).parse(await server.rpc.request(method, {
      ...(native.nativeSessionId ? { threadId: native.nativeSessionId, excludeTurns: true } : { ephemeral: false }),
      cwd: request.cwd, model: native.model, config: native.config,
    }));
    signal?.throwIfAborted();
    if (native.nativeSessionId && response.thread.id !== native.nativeSessionId) throw new Error('Codex resumed a different native conversation');
    let state: NativeAgentState = { provider: 'codex', nativeSessionId: response.thread.id, status: 'unknown', observedAt: new Date().toISOString() };
    observe(state); // Journal the returned identity before any subsequent external action.
    // This persists an otherwise empty conversation without submitting a task or model turn.
    await server.rpc.request('thread/inject_items', { threadId: state.nativeSessionId, items: [{ type: 'message', role: 'developer', content: [{ type: 'input_text', text: native.instructions }] }, { type: 'message', role: 'user', content: [{ type: 'input_text', text: native.context }] }] });
    signal?.throwIfAborted();
    // The real terminal becomes the turn subscriber and owns native approvals/input.
    await server.rpc.request('thread/unsubscribe', { threadId: state.nativeSessionId });
    signal?.throwIfAborted();
    server.rpc.on('notification', event => {
      if (closing || signal?.aborted) return;
      const status = codexStatus(event, state.nativeSessionId);
      const started = event.method === 'thread/started' && event.params?.thread?.id === state.nativeSessionId;
      if (status === undefined && !started) return;
      const input = status === 'input' ? codexInput(event, state.nativeSessionId) : undefined;
      const next: NativeAgentState = { ...state, status: status ?? 'idle' as const, ...((started || (status && status !== 'unknown')) ? { readyAt: state.readyAt ?? new Date().toISOString() } : {}), observedAt: new Date().toISOString() };
      if (status === 'idle' && ['working', 'input'].includes(state.status)) next.completionId = randomUUID();
      if (input) next.input = input; else delete next.input;
      if (next.status !== state.status || next.input !== state.input || next.readyAt !== state.readyAt) { state = next; observe(state); }
    });
    server.rpc.once('closed', (error: Error) => { if (!closing && !signal?.aborted) disconnected(error); });
    return { args: [...request.args, '--remote', server.endpoint, 'resume', state.nativeSessionId, ...(native.initialPrompt ? ['--', native.initialPrompt] : [])], async close() { closing = true; await server.close(); } };
  } catch (error) { closing = true; await server.close(); throw error; }
}
