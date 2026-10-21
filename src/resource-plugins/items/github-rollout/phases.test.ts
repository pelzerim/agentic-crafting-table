import test from 'node:test';
import assert from 'node:assert/strict';
import { currentPhase } from './phases.ts';
import type { RolloutGate, RolloutJob } from '../../../../packages/provider-runtime/github-rollout.ts';

const job = (id: number, name: string, status: RolloutJob['status'] = 'completed', conclusion: RolloutJob['conclusion'] = status === 'completed' ? 'success' : null) =>
  ({ id, run_id: 101, name, status, conclusion, started_at: '2026-10-21T10:00:00Z', completed_at: status === 'completed' ? '2026-10-21T10:05:00Z' : null }) as RolloutJob;
const gate = (id: number, name: string) => ({ environment: { id, name }, wait_timer: 0, current_user_can_approve: true, reviewers: [] }) as unknown as RolloutGate;

test('a waiting gate after something ran is a phase boundary: what ran and no validation covered, named before the gate', () => {
  const jobs = [job(1, 'apply (staging)'), job(2, 'apply (prod-1)', 'waiting'), job(3, 'skip', 'completed', 'skipped')];
  assert.deepEqual(currentPhase({ status: 'in_progress' }, jobs, [gate(7, 'production')], []), { boundary: 'gate', focus: 'before production (apply (prod-1))', jobs: [1] });
  assert.deepEqual(currentPhase({ status: 'in_progress' }, jobs, [gate(7, 'production')], [1]), undefined, 'already covered');
  assert.equal(currentPhase({ status: 'in_progress' }, [job(2, 'apply (prod-1)', 'waiting')], [gate(7, 'production')], []), undefined, 'a gate before anything ran');
});

test('the second gate on the same environment covers only the jobs the first approval released', () => {
  const jobs = [job(1, 'apply (staging)'), job(2, 'apply (prod-1)'), job(3, 'apply (prod-2)', 'waiting')];
  assert.deepEqual(currentPhase({ status: 'in_progress' }, jobs, [gate(7, 'production')], [1]), { boundary: 'gate', focus: 'before production (apply (prod-2))', jobs: [2] });
});

test('a finished run ends with the rest; between gates the phase runs up to the last finished job', () => {
  const jobs = [job(1, 'apply (staging)'), job(2, 'apply (prod-1)'), job(3, 'apply (prod-2)')];
  assert.deepEqual(currentPhase({ status: 'completed' }, jobs, [], [1, 2]), { boundary: 'end', focus: 'whole run', jobs: [3] });
  assert.equal(currentPhase({ status: 'completed' }, jobs, [], [1, 2, 3]), undefined);
  assert.deepEqual(currentPhase({ status: 'in_progress' }, [job(1, 'apply (staging)'), job(2, 'apply (prod-1)', 'in_progress')], [], []), { boundary: 'running', focus: 'through apply (staging)', jobs: [1] });
});
