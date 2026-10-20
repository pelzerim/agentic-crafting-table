import test from 'node:test';
import assert from 'node:assert/strict';
import { queueLabel, queuePlan } from './queue.ts';
import type { RolloutQueue, RolloutQueueRun } from '../../../../packages/provider-runtime/github-rollout.ts';

const at = (minute: number) => Date.UTC(2026, 8, 30, 10, minute), iso = (minute: number) => new Date(at(minute)).toISOString();
const entry = (id: number, status: string, patch: Partial<RolloutQueueRun> = {}): RolloutQueueRun => ({ id, number: id - 70, status, url: `https://github.com/acme/app/actions/runs/${id}`, createdAt: iso(id - 90), ...patch });
const pull = (number: number, mergedBy?: string) => ({ number, title: `PR ${number}`, url: `https://github.com/acme/app/pull/${number}`, ...(mergedBy ? { mergedBy } : {}) });
const queue = (ahead: RolloutQueueRun[], typicalMs?: number): RolloutQueue => ({ ahead, you: entry(101, 'queued', { pull: pull(144, 'you') }), branch: 'main', ...(typicalMs ? { typicalMs } : {}) });

test('the card label names how many are ahead and whose is next, or the stuck blocker', () => {
  const two = queue([entry(99, 'in_progress', { pull: pull(141, 'octo-a') }), entry(100, 'queued', { pull: pull(143, 'octo-b') })]);
  assert.equal(queueLabel(two), 'Queued · 2 ahead · next: octo-a #141');
  assert.equal(queueLabel(queue([entry(99, 'waiting', { pull: pull(141, 'octo-a'), stuck: { reason: 'approval', environment: 'production', since: iso(10) } })])), 'Queued · behind stuck #141 (octo-a)');
  assert.equal(queueLabel(queue([entry(99, 'in_progress', { actor: 'deploy-bot' })])), 'Queued · 1 ahead · next: deploy-bot run #29');
  assert.equal(queueLabel(queue([entry(99, 'in_progress', { pull: { number: 141, title: 'x', author: 'ada' } })])), 'Queued · 1 ahead · next: ada #141');
});

test('the estimate adds what is left of the running one and a typical run per queued one; none while a blocker is stuck or without history', () => {
  const two = queue([entry(99, 'in_progress', { startedAt: iso(12) }), entry(100, 'queued')], 22 * 60_000);
  const plan = queuePlan(two, at(25));
  assert.deepEqual(plan.rungs.map(rung => [rung.state, rung.remainingMs]), [['running', 9 * 60_000], ['queued', 22 * 60_000]]);
  assert.equal(plan.startsInMs, 31 * 60_000);
  assert.equal(queuePlan(two, at(50)).rungs[0].remainingMs, 0, 'an overrunning blocker has nothing left to estimate');
  const stuck = queuePlan(queue([entry(99, 'waiting', { stuck: { reason: 'approval', since: iso(19) } })], 22 * 60_000), at(60));
  assert.deepEqual([stuck.rungs[0].state, stuck.rungs[0].stuckMs, stuck.rungs[0].remainingMs, stuck.startsInMs], ['stuck', 41 * 60_000, undefined, undefined]);
  assert.equal(queuePlan(queue([entry(99, 'in_progress')]), at(25)).startsInMs, undefined);
});
