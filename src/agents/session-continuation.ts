import { AGENT_TOOL_CONTEXT_VERSION, buildAgentToolContext } from './tool-context.ts';

export interface SavedAgentSession {
  resourceId: string;
  projectId: string;
  provider: string;
  connectionId: string;
  nativeSessionId: string;
  workspaceId: string;
  model: string;
  state: 'working' | 'waiting' | 'idle' | 'paused' | 'ended';
  transport: 'attached' | 'detached';
  canResume: boolean;
  workspaceAvailable: boolean;
  agentNodeId?: string;
  /** Last guide version confirmed delivered by the provider adapter. */
  toolContextVersion?: string;
}

/** The host deduplicates on provider identity, not a title or transcript copy. */
export function sessionIdentity(session: SavedAgentSession): string {
  return JSON.stringify([session.provider, session.connectionId, session.workspaceId, session.nativeSessionId]);
}

/** Resume is a separate operation from create; no initial prompt is regenerated. */
export function buildSessionContinuation(projectId: string, session: SavedAgentSession) {
  if (session.projectId !== projectId) throw new Error('Session belongs to another project');
  if ([session.resourceId, session.provider, session.connectionId, session.nativeSessionId, session.workspaceId].some(value => !value.trim())) {
    throw new Error('A complete saved session identity is required');
  }
  if (!session.workspaceAvailable) throw new Error('Original workspace unavailable');
  const active = ['working', 'waiting', 'idle'].includes(session.state);
  const operation = active && session.transport === 'attached' ? 'attach' as const : 'resume' as const;
  if (operation === 'resume' && !session.canResume) throw new Error('Provider cannot resume this session');
  return Object.freeze({
    operation, resourceId: session.resourceId, projectId,
    provider: session.provider, connectionId: session.connectionId,
    nativeSessionId: session.nativeSessionId, workspaceId: session.workspaceId,
    model: session.model, identity: sessionIdentity(session),
    // A UI reattach sends nothing. A real resume can queue the missing guide at
    // the next input boundary without replacing history or interrupting work.
    ...(operation === 'resume' && session.toolContextVersion !== AGENT_TOOL_CONTEXT_VERSION ? {
      toolContextUpdate: Object.freeze({
        ...buildAgentToolContext({ projectId, agentNodeId: session.agentNodeId, workspaceId: session.workspaceId }),
        delivery: 'next-turn' as const,
      }),
    } : {}),
  });
}
