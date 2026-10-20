import type { RolloutQueue, RolloutQueueRun } from '../../../../packages/provider-runtime/github-rollout.ts';

/** Queue ladder: who is ahead
 * of a queued rollout and roughly when it starts. Shared by the card, view and timeline. */
const time = (value?: string | null) => { const parsed = Date.parse(value ?? ''); return Number.isFinite(parsed) ? parsed : undefined; };
export const queueWho = (entry: RolloutQueueRun) => entry.pull?.mergedBy ?? entry.pull?.author ?? entry.actor ?? 'unknown';
export const queueRef = (entry: RolloutQueueRun) => entry.pull ? `#${entry.pull.number}` : `run #${entry.number}`;

export function queueLabel(queue: RolloutQueue) {
  const stuck = queue.ahead.find(entry => entry.stuck), next = queue.ahead[0];
  return stuck ? `Queued · behind stuck ${queueRef(stuck)} (${queueWho(stuck)})` : `Queued · ${queue.ahead.length} ahead · next: ${queueWho(next)} ${queueRef(next)}`;
}

export interface QueueRung { entry: RolloutQueueRun; state: 'running' | 'stuck' | 'queued'; remainingMs?: number; stuckMs?: number }
/** A running blocker has the typical duration minus its elapsed time left; each queued
 * one adds a typical run. No estimate while any blocker is stuck. */
export function queuePlan(queue: RolloutQueue, now: number) {
  const typical = queue.ahead.some(entry => entry.stuck) ? undefined : queue.typicalMs;
  let wait = 0;
  const rungs = queue.ahead.map((entry): QueueRung => {
    if (entry.stuck) return { entry, state: 'stuck', stuckMs: Math.max(0, now - (time(entry.stuck.since) ?? now)) };
    const state = entry.status === 'queued' || entry.status === 'pending' ? 'queued' : 'running';
    if (typical === undefined) return { entry, state };
    const remainingMs = state === 'running' ? Math.max(0, typical - (now - (time(entry.startedAt) ?? now))) : typical;
    wait += remainingMs;
    return { entry, state, remainingMs };
  });
  return { rungs, startsInMs: typical === undefined ? undefined : wait };
}
