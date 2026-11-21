import type { ResourceViewServices } from '../../types.ts';

/** Explain in video from a pull request or an agent session: one request, never resent after a lost reply. */
export async function runVideoExplainAction(services: Pick<ResourceViewServices, 'runAction'>, signal: AbortSignal): Promise<{ nodeId?: string; detail?: string }> {
  signal.throwIfAborted();
  const result = await services.runAction('video.explain', { requestId: crypto.randomUUID() }) as { nodeId?: string; reused?: boolean; sent?: boolean };
  if (typeof result?.nodeId === 'string') return { nodeId: result.nodeId, ...(result.reused ? { detail: 'Already running' } : {}) };
  return result?.sent ? { detail: 'Asked the agent' } : {};
}
