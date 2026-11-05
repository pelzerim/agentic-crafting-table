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
const nativeThread = z.object({ id: z.string().uuid(), forkedFromId: z.string().nullish(), parentThreadId: z.string().nullish(), source: z.unknown(), threadSource: z.string().nullish() });
const startedThread = z.object({ thread: nativeThread });
/** A thread Codex started for its own work (a sub-agent, a review, a compaction), which the terminal never shows as its conversation. */
export const isHelperThread = (thread: z.infer<typeof nativeThread>) => Boolean(thread.parentThreadId) || (thread.source !== null && typeof thread.source === 'object') || thread.threadSource === 'subagent';
/** The thread `thread/read` returns, or undefined for an answer that is not one. */
export const readThread = (response: unknown) => { const parsed = startedThread.safeParse(response); return parsed.success ? parsed.data.thread : undefined; };
/** The conversation Codex's terminal moved to. A subagent's thread also starts on this server, and is noted so that its status is not read as a resume.
 * A status from a thread not seen before is only a candidate `resume`: a sub-agent's status can arrive without, or before, its `thread/started`. */
export function codexSwitch(event: { method: string; params?: unknown }, nativeId: string, ignored: Set<string>): ConversationSwitch | undefined {
  if (event.method === 'thread/started') {
    const parsed = startedThread.safeParse(event.params);
    if (!parsed.success || parsed.data.thread.id === nativeId) return;
    const { id, forkedFromId } = parsed.data.thread;
    if (isHelperThread(parsed.data.thread)) { ignored.add(id); return; }
    return { kind: forkedFromId ? 'fork' : 'new', nativeSessionId: id };
  }
  if (event.method !== 'thread/status/changed') return;
  const parsed = notice.safeParse(event.params);
  if (!parsed.success || parsed.data.threadId === nativeId || ignored.has(parsed.data.threadId)) return;
  return { kind: 'resume', nativeSessionId: parsed.data.threadId };
}
export function codexInput(event: { method: string; params?: unknown }, nativeId: string): NativeAgentState['input'] {
  const parsed = notice.safeParse(event.params);
  return parsed.success && parsed.data.threadId === nativeId ? nativeInput(parsed.data.status) : undefined;
}
