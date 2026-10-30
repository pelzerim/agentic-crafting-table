import * as z from 'zod/v4';
import type { NativeAgentState } from './protocol.ts';
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
export function codexInput(event: { method: string; params?: unknown }, nativeId: string): NativeAgentState['input'] {
  const parsed = notice.safeParse(event.params);
  return parsed.success && parsed.data.threadId === nativeId ? nativeInput(parsed.data.status) : undefined;
}
