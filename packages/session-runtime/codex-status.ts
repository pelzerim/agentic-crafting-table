import * as z from 'zod/v4';
import type { ConversationSwitch, NativeAgentState } from './protocol.ts';
export const codexThreadStatus = z.object({ type: z.enum(['idle', 'active', 'systemError', 'notLoaded']), activeFlags: z.array(z.string()).optional() });
const notice = z.object({ threadId: z.string(), status: codexThreadStatus });
type ThreadStatus = z.infer<typeof codexThreadStatus>;

export function nativeStatus(value: ThreadStatus): NativeAgentState['status'] {
  return value.type === 'systemError' ? 'error' : value.type === 'active' ? value.activeFlags?.some(flag => ['waitingOnApproval', 'waitingOnUserInput'].includes(flag)) ? 'input' : 'working' : value.type === 'idle' ? 'idle' : 'unknown';
}
/** What an `input` status waits for: an approval takes precedence over a question. */
export function nativeInput(value: ThreadStatus): NativeAgentState['input'] {
  const flags = value.activeFlags ?? [];
  return flags.includes('waitingOnApproval') ? 'approval' : flags.includes('waitingOnUserInput') ? 'question' : undefined;
}

/** Global native status notifications need no turn subscription or approval ownership. */
export function codexStatus(event: { method: string; params?: unknown }, nativeId: string): NativeAgentState['status'] | undefined {
  if (event.method !== 'thread/status/changed') return;
  const parsed = notice.safeParse(event.params);
  if (!parsed.success || parsed.data.threadId !== nativeId) return;
  return nativeStatus(parsed.data.status);
}
const startedThread = z.object({ thread: z.object({ id: z.string().uuid(), forkedFromId: z.string().nullish(), parentThreadId: z.string().nullish(), source: z.unknown() }) });
/** The conversation Codex's terminal moved to. A subagent's thread also starts on this server, and is noted so that its status is not read as a resume. */
export function codexSwitch(event: { method: string; params?: unknown }, nativeId: string, subagents: Set<string>): ConversationSwitch | undefined {
  if (event.method === 'thread/started') {
    const parsed = startedThread.safeParse(event.params);
    if (!parsed.success || parsed.data.thread.id === nativeId) return;
    const { id, forkedFromId, parentThreadId, source } = parsed.data.thread;
    if (parentThreadId || (source !== null && typeof source === 'object')) { subagents.add(id); return; }
    return { kind: forkedFromId ? 'fork' : 'new', nativeSessionId: id };
  }
  if (event.method !== 'thread/status/changed') return;
  const parsed = notice.safeParse(event.params);
  if (!parsed.success || parsed.data.threadId === nativeId || subagents.has(parsed.data.threadId)) return;
  return { kind: 'resume', nativeSessionId: parsed.data.threadId };
}
export function codexInput(event: { method: string; params?: unknown }, nativeId: string): NativeAgentState['input'] {
  const parsed = notice.safeParse(event.params);
  return parsed.success && parsed.data.threadId === nativeId ? nativeInput(parsed.data.status) : undefined;
}
