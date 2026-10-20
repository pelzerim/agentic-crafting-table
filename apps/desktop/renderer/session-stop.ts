import type { SessionRecord } from '../../../packages/session-runtime/protocol.ts';

/** Stopping ends the agent's current turn; idle sessions and plain shells stop at once. */
export function stopNeedsConfirm(session: Pick<SessionRecord, 'state' | 'stopRequestedAt'> & { native?: Pick<NonNullable<SessionRecord['native']>, 'status'> } | undefined, agent: boolean, activity: string | undefined) {
  return agent && session?.state === 'running' && !session.stopRequestedAt && (session.native?.status === 'working' || activity === 'working');
}
