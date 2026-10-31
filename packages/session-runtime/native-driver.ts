import type { LaunchRequest, NativeAgentState } from './protocol.ts';
import { openCodexTerminalServer } from './codex-transport.ts';
import { codexInput, codexStatus, codexSwitch, codexThreadStatus, nativeInput, nativeStatus } from './codex-status.ts';
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
    let state: NativeAgentState | undefined;
    const notified: { method: string; params?: any }[] = [], subagents = new Set<string>();
    const apply = (event: { method: string; params?: any }, current: NativeAgentState) => {
      const switched = current.switched ? undefined : codexSwitch(event, current.nativeSessionId, subagents);
      if (switched) { state = { ...current, switched, observedAt: new Date().toISOString() }; observe(state); return; }
      const status = codexStatus(event, current.nativeSessionId);
      const started = event.method === 'thread/started' && event.params?.thread?.id === current.nativeSessionId;
      if (status === undefined && !started) return;
      const input = status === 'input' ? codexInput(event, current.nativeSessionId) : undefined;
      const next: NativeAgentState = { ...current, status: status ?? 'idle' as const, ...((started || (status && status !== 'unknown')) ? { readyAt: current.readyAt ?? new Date().toISOString() } : {}), observedAt: new Date().toISOString() };
      if (status === 'idle' && ['working', 'input'].includes(current.status)) next.completionId = randomUUID();
      if (input) next.input = input; else delete next.input;
      if (next.status !== current.status || next.input !== current.input || next.readyAt !== current.readyAt) { state = next; observe(next); }
    };
    // From before the first request: nothing repeats a status sent while the launch is still in progress.
    server.rpc.on('notification', event => {
      if (closing || signal?.aborted) return;
      if (state) apply(event, state); else notified.push(event);
    });
    const method = native.nativeSessionId ? 'thread/resume' : 'thread/start';
    const response = z.object({ thread: z.object({ id: z.string().uuid(), status: codexThreadStatus.optional() }) }).parse(await server.rpc.request(method, {
      ...(native.nativeSessionId ? { threadId: native.nativeSessionId, excludeTurns: true } : { ephemeral: false }),
      cwd: request.cwd, model: native.model, config: native.config,
    }));
    signal?.throwIfAborted();
    if (native.nativeSessionId && response.thread.id !== native.nativeSessionId) throw new Error('Codex resumed a different native conversation');
    const observedAt = new Date().toISOString(), status = response.thread.status ? nativeStatus(response.thread.status) : 'unknown', input = response.thread.status && status === 'input' ? nativeInput(response.thread.status) : undefined;
    const seeded: NativeAgentState = { provider: 'codex', nativeSessionId: response.thread.id, status, ...(input ? { input } : {}), ...(status !== 'unknown' ? { readyAt: observedAt } : {}), observedAt };
    state = seeded; observe(seeded); // Journal the returned identity before any subsequent external action.
    for (const event of notified.splice(0)) apply(event, state);
    // This persists an otherwise empty conversation without submitting a task or model turn.
    if (!native.contextDelivered) await server.rpc.request('thread/inject_items', { threadId: seeded.nativeSessionId, items: [{ type: 'message', role: 'developer', content: [{ type: 'input_text', text: native.instructions }] }, { type: 'message', role: 'user', content: [{ type: 'input_text', text: native.context }] }] });
    signal?.throwIfAborted();
    // The real terminal becomes the turn subscriber and owns native approvals/input.
    await server.rpc.request('thread/unsubscribe', { threadId: seeded.nativeSessionId });
    signal?.throwIfAborted();
    server.rpc.once('closed', (error: Error) => { if (!closing && !signal?.aborted) disconnected(error); });
    return { args: [...request.args, '--remote', server.endpoint, 'resume', seeded.nativeSessionId, ...(native.initialPrompt ? ['--', native.initialPrompt] : [])], async close() { closing = true; await server.close(); } };
  } catch (error) { closing = true; await server.close(); throw error; }
}
