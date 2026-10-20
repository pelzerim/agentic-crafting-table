import * as z from 'zod/v4';
import type { NativeAgentState } from './protocol.ts';
const status = z.object({ type: z.enum(['idle', 'active', 'systemError', 'notLoaded']), activeFlags: z.array(z.string()).optional() });
const notice = z.object({ threadId: z.string(), status });

/** Global native status notifications need no turn subscription or approval ownership. */
export function codexStatus(event: { method: string; params?: unknown }, nativeId: string): NativeAgentState['status'] | undefined {
  if (event.method !== 'thread/status/changed') return;
  const parsed = notice.safeParse(event.params);
  if (!parsed.success || parsed.data.threadId !== nativeId) return;
  const value = parsed.data.status;
  return value.type === 'systemError' ? 'error' : value.type === 'active' ? value.activeFlags?.some(flag => ['waitingOnApproval', 'waitingOnUserInput'].includes(flag)) ? 'input' : 'working' : value.type === 'idle' ? 'idle' : 'unknown';
}
/** What an `input` status waits for: an approval takes precedence over a question. */
export function codexInput(event: { method: string; params?: unknown }, nativeId: string): NativeAgentState['input'] {
  const parsed = notice.safeParse(event.params), flags = parsed.success && parsed.data.threadId === nativeId ? parsed.data.status.activeFlags ?? [] : [];
  return flags.includes('waitingOnApproval') ? 'approval' : flags.includes('waitingOnUserInput') ? 'question' : undefined;
}
