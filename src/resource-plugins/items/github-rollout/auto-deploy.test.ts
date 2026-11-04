import test from 'node:test';
import assert from 'node:assert/strict';
import { armRecord, autoDeployEvents, decide, observe, phaseTrack, recordKey, seedCatchUp, settle, statusLine, takeoverRefusal, trackNext, FINDINGS_DEADLINE_MS, FIX_ATTEMPTS, FIX_DEADLINE_MS, REBASE_ATTEMPTS, REBASE_DEADLINE_MS, ROLLOUT_DEADLINE_MS, VALIDATION_DEADLINE_MS, BLOCKED_GRACE_MS } from './auto-deploy.ts';
import type { AutoDeployDecision, AutoDeployFacts, AutoDeployRecord, PhaseTrack, PullFacts, RolloutFacts } from './auto-deploy.ts';
import { parseStageRules } from './stages.ts';
import type { RolloutJob } from '../../../../packages/provider-runtime/github-rollout.ts';
import type { LoopFinding } from '../code-review/review-loop.ts';

const T0 = Date.parse('2026-10-08T10:00:00Z'), MIN = 60_000, head = 'a'.repeat(40);
const pull = (over: Partial<PullFacts> = {}): PullFacts => ({ lifecycle: 'open', head, base: 'main', title: '[ship] Batch exports', tag: 'ship', mergeStateStatus: 'CLEAN', reviewDecision: 'APPROVED',
  checks: 'passing', failing: [], queued: false, queueEnabled: false, method: 'SQUASH', pullRequestId: 'PR_node42', ...over });
const job = (id: number, name: string, status = 'completed', conclusion: string | null = 'success', completed = '2026-10-08T10:20:00Z'): RolloutJob =>
  ({ id, run_id: 101, name, status, conclusion, started_at: '2026-10-08T10:10:00Z', completed_at: status === 'completed' ? completed : null });
const rollout = (over: Partial<RolloutFacts> = {}): RolloutFacts => ({ nodeId: 'rollout', title: 'Web / Release', run: { id: 101, attempt: 1, status: 'in_progress', conclusion: null, headSha: 'c'.repeat(40) },
  jobs: [job(1, 'preview / ship')], gates: [], validations: [], ...over });
const facts = (over: Partial<AutoDeployFacts> = {}): AutoDeployFacts => ({ now: T0, tagging: true, pull: pull(), rollouts: [], ...over });
const armed = (over: Partial<AutoDeployRecord> = {}): AutoDeployRecord => ({ ...armRecord({ id: 'arm-1', pullResourceId: 'pr-r', pullNodeId: 'pr', now: T0 }), ...over });
const merged = (over: Partial<AutoDeployRecord> = {}) => armed({ mergedAt: T0, writes: [{ key: 'merge', kind: 'merge', requestId: 'm', at: T0, state: 'sent' }], ...over });
const gate = (id: number, name: string, approvable = true) => ({ id, name, approvable });
const check = (key: string, validationId: string | undefined, requestedAt = T0, jobs?: number[]) => ({ key, rolloutNodeId: 'rollout', label: key.split(':').at(-1)!, requestId: `r-${key}`, ...(validationId ? { validationId } : {}), requestedAt, ...(jobs ? { jobs } : {}) });
const halts = (decision: AutoDeployDecision, code: string, reason?: RegExp) => {
  assert.equal(decision.kind, 'halt', JSON.stringify(decision));
  assert.equal((decision as { code: string }).code, code);
  if (reason) assert.match((decision as { reason: string }).reason, reason);
};
const waits = (decision: AutoDeployDecision, step: string, detail?: string) => { assert.deepEqual(decision.kind === 'wait' ? [decision.step, decision.detail] : decision, [step, detail]); };

test('arming starts a persisted record that waits for its first pass', () => {
  const record = armRecord({ id: 'arm-1', pullResourceId: 'pr-r', pullNodeId: 'pr', now: T0 });
  assert.deepEqual(record, { version: 1, id: 'arm-1', pullResourceId: 'pr-r', pullNodeId: 'pr', armedAt: T0, updatedAt: T0, state: 'armed', step: 'waiting-checks', writes: [], fixes: [], checks: [] });
  assert.equal(statusLine(record), 'Auto deploy · waiting for checks');
});

test('before the merge: tag [ship] once, wait for checks, then merge with the default method or the merge queue', () => {
  assert.deepEqual(decide(armed(), facts({ pull: pull({ title: 'Batch exports', tag: '' }) })), { kind: 'tag', title: 'Batch exports' });
  assert.deepEqual(decide(armed(), facts({ pull: pull({ title: '[show] Batch exports', tag: 'show' }) })), { kind: 'tag', title: '[show] Batch exports' });
  assert.equal(decide(armed({ writes: [{ key: 'tag', kind: 'tag', requestId: 't', at: T0, state: 'sent' }] }), facts({ pull: pull({ tag: '' }) })).kind, 'merge', 'one tag write, never repeated');
  assert.equal(decide(armed(), facts({ tagging: false, pull: pull({ tag: '' }) })).kind, 'merge', 'tagging off leaves the title alone');
  waits(decide(armed(), facts({ pull: undefined })), 'waiting-checks', 'reading the pull request');
  waits(decide(armed(), facts({ pull: pull({ checks: 'pending' }) })), 'waiting-checks');
  waits(decide(armed(), facts({ pull: pull({ mergeStateStatus: 'UNKNOWN' }) })), 'waiting-checks');
  waits(decide(armed(), facts({ pull: pull({ mergeStateStatus: 'BLOCKED' }) })), 'waiting-checks');
  assert.deepEqual(decide(armed(), facts()), { kind: 'merge', method: 'SQUASH', pullRequestId: 'PR_node42', head });
  assert.deepEqual(decide(armed(), facts({ pull: pull({ checks: 'none' }) })).kind, 'merge');
  assert.deepEqual(decide(armed(), facts({ pull: pull({ queueEnabled: true, mergeStateStatus: 'BEHIND', method: 'QUEUE' }) })), { kind: 'merge', method: 'QUEUE', pullRequestId: 'PR_node42', head });
  waits(decide(armed({ writes: [{ key: 'merge', kind: 'merge', requestId: 'm', at: T0, state: 'sent' }] }), facts({ pull: pull({ queued: true, queueEnabled: true }) })), 'merge-queue');
  waits(decide(armed({ writes: [{ key: 'merge', kind: 'merge', requestId: 'm', at: T0, state: 'sent' }] }), facts()), 'merging');
});

test('failing checks ask an agent to fix them, at most twice, one request per head commit', () => {
  const failing = facts({ pull: pull({ checks: 'failing', failing: ['unit', 'lint'] }) });
  assert.deepEqual(decide(armed(), failing), { kind: 'fix', attempt: 1, head, failing: ['unit', 'lint'] });
  const first = armed({ fixes: [{ head, at: T0 }] });
  waits(decide(first, failing), 'fixing-ci', '1/2');
  halts(decide(first, { ...failing, now: T0 + FIX_DEADLINE_MS }), 'fix-stalled', /no new commit/);
  const next = 'b'.repeat(40);
  waits(decide(first, facts({ pull: pull({ head: next, checks: 'pending' }) })), 'waiting-checks');
  assert.deepEqual(decide(first, facts({ pull: pull({ head: next, checks: 'failing', failing: ['unit'] }) })), { kind: 'fix', attempt: 2, head: next, failing: ['unit'] });
  const second = armed({ fixes: [{ head, at: T0 }, { head: next, at: T0 }] });
  halts(decide(second, facts({ pull: pull({ head: 'd'.repeat(40), checks: 'failing', failing: ['unit'] }) })), 'ci-failing', new RegExp(`after ${FIX_ATTEMPTS} fix attempts.*unit`));
  assert.equal(decide(second, facts({ pull: pull({ head: 'd'.repeat(40) }) })).kind, 'merge', 'green after the second fix merges');
});

test('every doubt before the merge halts with its reason', () => {
  halts(decide(armed(), facts({ pull: pull({ lifecycle: 'closed' }) })), 'closed', /closed/);
  halts(decide(armed(), facts({ pull: pull({ lifecycle: 'draft' }) })), 'draft', /draft/);
  halts(decide(armed(), facts({ pull: pull({ reviewDecision: 'CHANGES_REQUESTED' }) })), 'changes-requested', /requested changes/);
  halts(decide(armed(), facts({ pull: pull({ reviewDecision: 'REVIEW_REQUIRED' }) })), 'review-required', /only a person/);
  halts(decide(armed({ blockedSince: T0 - BLOCKED_GRACE_MS }), facts({ pull: pull({ mergeStateStatus: 'BLOCKED' }) })), 'blocked', /blocked/);
  halts(decide(armed({ writes: [{ key: 'merge', kind: 'merge', requestId: 'm', at: T0, state: 'sending' }] }), facts()), 'outcome-unknown', /merge.*could not be confirmed/i);
  halts(decide(merged({ writes: [{ key: 'approve:x', kind: 'approve', requestId: 'a', at: T0, state: 'sending' }] }), facts()), 'outcome-unknown', /approval.*could not be confirmed/i);
  halts(decide(armed({ writes: [{ key: 'fix:1', kind: 'fix', requestId: 'f', at: T0, state: 'sending' }] }), facts()), 'outcome-unknown', /fix request/i);
});

test('taking the pull request out of the merge queue stops auto deploy instead of halting it', () => {
  const queued = armed({ writes: [{ key: 'merge', kind: 'merge', requestId: 'm', at: T0, state: 'sent' }] });
  const decision = decide(queued, facts({ pull: pull({ queueEnabled: true }) }));
  assert.deepEqual(decision, { kind: 'stop', reason: 'The pull request was taken out of the merge queue.' });
  const stopped = settle(queued, decision, T0 + MIN);
  assert.deepEqual([stopped.state, stopped.step, stopped.halt, stopped.detail], ['stopped', 'stopped', undefined, 'The pull request was taken out of the merge queue.']);
  waits(decide(stopped, facts({ pull: pull({ queued: true, queueEnabled: true }) })), 'stopped');
});

test('observe notes the merge and how long GitHub has reported the pull request blocked', () => {
  const blocked = observe(armed(), facts({ pull: pull({ mergeStateStatus: 'BLOCKED' }) }));
  assert.equal(blocked.blockedSince, T0);
  assert.equal(observe(blocked, facts({ now: T0 + MIN, pull: pull({ mergeStateStatus: 'BLOCKED' }) })).blockedSince, T0);
  assert.equal(observe(blocked, facts()).blockedSince, undefined);
  const done = observe(armed(), facts({ pull: pull({ lifecycle: 'merged' }) }));
  assert.equal(done.mergedAt, T0); assert.equal(done.base, 'main');
  assert.equal(observe(done, facts({ now: T0 + MIN, pull: pull({ lifecycle: 'merged' }) })).mergedAt, T0);
});

test('after the merge: wait for the deploy run, halt when none appears or it fails', () => {
  waits(decide(merged(), facts({ rollouts: [] })), 'waiting-rollout');
  waits(decide(merged(), facts({ rollouts: [rollout({ run: undefined })] })), 'waiting-rollout');
  halts(decide(merged(), facts({ now: T0 + ROLLOUT_DEADLINE_MS, rollouts: [] })), 'no-rollout', /No deploy run appeared/);
  halts(decide(merged(), facts({ rollouts: [rollout({ run: { id: 101, attempt: 1, status: 'completed', conclusion: 'failure', headSha: head } })] })), 'deploy-failed', /Web \/ Release/);
  halts(decide(merged(), facts({ rollouts: [rollout({ run: { id: 101, attempt: 1, status: 'completed', conclusion: 'cancelled', headSha: head } })] })), 'deploy-failed', /cancelled/);
  halts(decide(merged(), facts({ rollouts: [rollout({ jobs: [job(1, 'preview / ship', 'completed', 'failure')] })] })), 'deploy-failed');
  waits(decide(merged(), facts({ rollouts: [rollout({ jobs: [job(1, 'preview / ship', 'in_progress', null)] })] })), 'deploying', 'preview');
});

test('without stage rules each gate is a phase boundary: validate what ran, approve on a pass, validate the whole run at the end', () => {
  const waiting = rollout({ gates: [gate(7, 'live')] });
  assert.deepEqual(decide(merged(), facts({ rollouts: [waiting] })), { kind: 'validate', key: 'rollout:101:1:gate:7', rolloutNodeId: 'rollout', label: 'before live', jobs: [1] });
  const asked = merged({ checks: [check('rollout:101:1:gate:7', 'V1', T0, [1])] });
  waits(decide(asked, facts({ rollouts: [{ ...waiting, validations: [{ label: 'V1', state: 'running' }] }] })), 'validating', 'before live');
  waits(decide(merged({ checks: [check('rollout:101:1:gate:7', undefined)] }), facts({ rollouts: [waiting] })), 'validating', 'before live');
  const passed = { ...waiting, validations: [{ label: 'V1', state: 'final' as const, verdict: 'passed' as const }] };
  assert.deepEqual(decide(asked, facts({ rollouts: [passed] })), { kind: 'approve', key: 'approve:rollout:101:1:7', rolloutNodeId: 'rollout', runId: 101, attempt: 1, environmentIds: [7], names: 'live' });
  const approved = { ...asked, writes: [...asked.writes, { key: 'approve:rollout:101:1:7', kind: 'approve' as const, requestId: 'a', at: T0, state: 'sent' as const }] };
  waits(decide(approved, facts({ rollouts: [passed] })), 'deploying', 'live');
  const live = rollout({ jobs: [job(1, 'preview / ship'), job(2, 'live / ship', 'in_progress', null)], validations: passed.validations });
  waits(decide(approved, facts({ rollouts: [live] })), 'deploying', 'live');
  const finished = rollout({ run: { id: 101, attempt: 1, status: 'completed', conclusion: 'success', headSha: head }, jobs: [job(1, 'preview / ship'), job(2, 'live / ship')], validations: passed.validations });
  assert.deepEqual(decide(approved, facts({ rollouts: [finished] })), { kind: 'validate', key: 'rollout:101:1:final', rolloutNodeId: 'rollout', label: 'whole run', jobs: [2] }, 'the last phase covers what no earlier validation did');
  const last = { ...approved, checks: [...approved.checks, check('rollout:101:1:final', 'V2')] };
  waits(decide(last, facts({ rollouts: [{ ...finished, validations: [...passed.validations, { label: 'V2', state: 'requested' }] }] })), 'validating', 'whole run');
  assert.deepEqual(decide(last, facts({ rollouts: [{ ...finished, validations: [...passed.validations, { label: 'V2', state: 'final', verdict: 'passed' }] }] })), { kind: 'done' });
});

test('a phased rollout gates the same environment once per phase: each phase is validated after the one before it and approved on its own', () => {
  const staging = job(1, 'apply-staging / apply');
  const phase1 = rollout({ jobs: [staging, job(2, 'apply-prod-phase-1 / apply (ap-northeast-3)', 'waiting', null)], gates: [gate(7, 'production')] });
  assert.deepEqual(decide(merged(), facts({ rollouts: [phase1] })), { kind: 'validate', key: 'rollout:101:1:gate:7@2', rolloutNodeId: 'rollout', label: 'before production (apply-prod-phase-1 / apply (ap-northeast-3))', jobs: [1] });
  const askedOne = merged({ checks: [check('rollout:101:1:gate:7@2', 'V1', T0, [1])] }), passedOne = [{ label: 'V1', state: 'final' as const, verdict: 'passed' as const }];
  assert.deepEqual(decide(askedOne, facts({ rollouts: [{ ...phase1, validations: passedOne }] })), { kind: 'approve', key: 'approve:rollout:101:1:7@2', rolloutNodeId: 'rollout', runId: 101, attempt: 1, environmentIds: [7], names: 'production' });
  const approvedOne = { ...askedOne, writes: [...askedOne.writes, { key: 'approve:rollout:101:1:7@2', kind: 'approve' as const, requestId: 'a1', at: T0, state: 'sent' as const }] };
  waits(decide(approvedOne, facts({ rollouts: [{ ...phase1, jobs: [staging, job(2, 'apply-prod-phase-1 / apply (ap-northeast-3)', 'in_progress', null)], gates: [], validations: passedOne }] })), 'deploying', 'production');
  // Phase 1 finished and the same environment gates phase 2: a new boundary, validated before it is approved.
  const phase2 = rollout({ jobs: [staging, job(2, 'apply-prod-phase-1 / apply (ap-northeast-3)'), job(3, 'apply-prod-phase-2 / apply (region-2)', 'waiting', null)], gates: [gate(7, 'production')], validations: passedOne });
  assert.deepEqual(decide(approvedOne, facts({ rollouts: [phase2] })), { kind: 'validate', key: 'rollout:101:1:gate:7@3', rolloutNodeId: 'rollout', label: 'before production (apply-prod-phase-2 / apply (region-2))', jobs: [2] }, 'phase 2 is validated on what phase 1 deployed');
  const askedTwo = { ...approvedOne, checks: [...approvedOne.checks, check('rollout:101:1:gate:7@3', 'V2', T0, [2])] };
  waits(decide(askedTwo, facts({ rollouts: [{ ...phase2, validations: [...passedOne, { label: 'V2', state: 'running' }] }] })), 'validating', 'before production (apply-prod-phase-2 / apply (region-2))');
  assert.deepEqual(decide(askedTwo, facts({ rollouts: [{ ...phase2, validations: [...passedOne, { label: 'V2', state: 'final', verdict: 'passed' }] }] })), { kind: 'approve', key: 'approve:rollout:101:1:7@3', rolloutNodeId: 'rollout', runId: 101, attempt: 1, environmentIds: [7], names: 'production' });
});

test('a gate before anything ran is approved without a validation; a gate only someone else may approve is waited on', () => {
  const first = rollout({ jobs: [job(1, 'preview / ship', 'waiting', null)], gates: [gate(5, 'preview')] });
  assert.deepEqual(decide(merged(), facts({ rollouts: [first] })), { kind: 'approve', key: 'approve:rollout:101:1:5@1', rolloutNodeId: 'rollout', runId: 101, attempt: 1, environmentIds: [5], names: 'preview' });
  const other = rollout({ jobs: [job(1, 'preview / ship', 'waiting', null)], gates: [gate(5, 'preview', false)] });
  waits(decide(merged(), facts({ rollouts: [other] })), 'waiting-gate', 'preview');
});

test('a rollout without gates is one phase, validated once when it finishes', () => {
  const finished = rollout({ run: { id: 101, attempt: 1, status: 'completed', conclusion: 'success', headSha: head } });
  assert.deepEqual(decide(merged(), facts({ rollouts: [finished] })), { kind: 'validate', key: 'rollout:101:1:final', rolloutNodeId: 'rollout', label: 'whole run', jobs: [1] });
  const record = merged({ checks: [check('rollout:101:1:final', 'V1')] });
  assert.deepEqual(decide(record, facts({ rollouts: [{ ...finished, validations: [{ label: 'V1', state: 'final', verdict: 'passed' }] }] })), { kind: 'done' });
  assert.deepEqual(decide(record, facts({ rollouts: [{ ...finished, validations: [{ label: 'V1', state: 'final', verdict: 'failed', resolvedBy: 'V2' }, { label: 'V2', state: 'final', verdict: 'passed' }] }] })), { kind: 'done' }, 'a newer final validation answers for it');
});

test('every validation answer but passed halts, and so does no verdict in time', () => {
  const finished = rollout({ run: { id: 101, attempt: 1, status: 'completed', conclusion: 'success', headSha: head } });
  const record = merged({ checks: [check('rollout:101:1:final', 'V1')] });
  const answer = (state: 'final' | 'no-report', verdict?: 'failed' | 'concerns' | 'inconclusive') => decide(record, facts({ rollouts: [{ ...finished, validations: [{ label: 'V1', state, ...(verdict ? { verdict } : {}) }] }] }));
  halts(answer('final', 'failed'), 'validation-failed', /V1 of whole run failed/);
  halts(answer('final', 'concerns'), 'validation-concerns', /V1 of whole run found concerns/);
  halts(answer('final', 'inconclusive'), 'validation-inconclusive', /V1 of whole run was inconclusive/);
  halts(answer('no-report'), 'no-verdict', /V1 of whole run sent no report/);
  halts(decide(record, facts({ now: T0 + VALIDATION_DEADLINE_MS, rollouts: [{ ...finished, validations: [{ label: 'V1', state: 'running' }] }] })), 'no-verdict', /within an hour/);
  halts(decide(record, facts({ rollouts: [finished] })), 'no-verdict', /V1.*no longer/);
});

test('with stage rules each stage is a phase: its delay is waited out, then it is validated before the next gate is approved', () => {
  const [rule] = parseStageRules(JSON.stringify([{ id: 'web-release', workflow: '^web', stages: [{ key: 'preview', environment: 'preview' }, { key: 'live', environment: 'live', delayMinutes: 10 }] }]));
  const previewDone = rollout({ rule, jobs: [job(1, 'preview / ship', 'completed', 'success', '2026-10-08T10:20:00Z'), job(2, 'live / ship', 'waiting', null)], gates: [gate(7, 'live')] });
  const now = Date.parse('2026-10-08T10:21:00Z');
  assert.deepEqual(decide(merged(), facts({ now, rollouts: [previewDone] })), { kind: 'validate', key: 'rollout:101:1:stage:preview', rolloutNodeId: 'rollout', label: 'preview', jobs: [1] });
  const previewPassed = merged({ checks: [check('rollout:101:1:stage:preview', 'V1', T0, [1])] }), verdicts = [{ label: 'V1', state: 'final' as const, verdict: 'passed' as const }];
  assert.equal(decide(previewPassed, facts({ now, rollouts: [{ ...previewDone, validations: verdicts }] })).kind, 'approve');
  const liveDone = rollout({ rule, run: { id: 101, attempt: 1, status: 'completed', conclusion: 'success', headSha: head }, validations: verdicts,
    jobs: [job(1, 'preview / ship', 'completed', 'success', '2026-10-08T10:20:00Z'), job(2, 'live / ship', 'completed', 'success', '2026-10-08T10:40:00Z')] });
  waits(decide(previewPassed, facts({ now: Date.parse('2026-10-08T10:43:00Z'), rollouts: [liveDone] })), 'delayed', 'live · 7 min');
  assert.deepEqual(decide(previewPassed, facts({ now: Date.parse('2026-10-08T10:50:00Z'), rollouts: [liveDone] })), { kind: 'validate', key: 'rollout:101:1:stage:live', rolloutNodeId: 'rollout', label: 'live', jobs: [2] });
  const livePassed = merged({ checks: [...previewPassed.checks, check('rollout:101:1:stage:live', 'V2')] });
  assert.deepEqual(decide(livePassed, facts({ now: Date.parse('2026-10-08T10:52:00Z'), rollouts: [{ ...liveDone, validations: [...verdicts, { label: 'V2', state: 'final', verdict: 'passed' }] }] })), { kind: 'done' });
});

test('settle records the step each decision leads to; halts and done end the record; a stopped record decides nothing', () => {
  const at = T0 + MIN;
  assert.equal(statusLine(settle(armed(), { kind: 'wait', step: 'waiting-checks' }, at)), 'Auto deploy · waiting for checks');
  assert.equal(statusLine(settle(armed(), { kind: 'fix', attempt: 1, head, failing: [] }, at)), 'Auto deploy · fixing CI (1/2)');
  assert.equal(statusLine(settle(armed(), { kind: 'tag', title: 'x' }, at)), 'Auto deploy · tagging [ship]');
  assert.equal(statusLine(settle(armed(), { kind: 'merge', method: 'SQUASH', pullRequestId: 'p', head }, at)), 'Auto deploy · merging');
  assert.equal(statusLine(settle(armed(), { kind: 'wait', step: 'merge-queue' }, at)), 'Auto deploy · in the merge queue');
  assert.equal(statusLine(settle(armed(), { kind: 'validate', key: 'k', rolloutNodeId: 'rollout', label: 'preview', jobs: [] }, at)), 'Auto deploy · validating preview');
  assert.equal(statusLine(settle(armed(), { kind: 'approve', key: 'k', rolloutNodeId: 'rollout', runId: 1, attempt: 1, environmentIds: [7], names: 'live' }, at)), 'Auto deploy · approving live');
  assert.equal(statusLine(settle(armed(), { kind: 'wait', step: 'waiting-gate', detail: 'live' }, at)), 'Auto deploy · live waits for another approver');
  assert.equal(statusLine(settle(armed(), { kind: 'wait', step: 'delayed', detail: 'live · 7 min' }, at)), 'Auto deploy · waiting out live · 7 min');
  const done = settle(armed(), { kind: 'done' }, at);
  assert.deepEqual([done.state, done.step, done.updatedAt, statusLine(done)], ['done', 'done', at, 'Auto deploy · done']);
  const halted = settle(armed(), { kind: 'halt', code: 'conflicts', reason: 'The branch has merge conflicts with main.' }, at);
  assert.deepEqual([halted.state, halted.halt, statusLine(halted)], ['halted', { code: 'conflicts', reason: 'The branch has merge conflicts with main.', at }, 'Auto deploy · halted: The branch has merge conflicts with main.']);
  const stopped = armed({ state: 'stopped', step: 'stopped' });
  assert.equal(statusLine(stopped), 'Auto deploy · stopped');
  assert.deepEqual(decide(stopped, facts()), { kind: 'wait', step: 'stopped' });
  assert.deepEqual(decide(done, facts()), { kind: 'wait', step: 'done' });
});

const takeoverRollout = (over: Partial<RolloutFacts> = {}) => rollout({ gates: [gate(7, 'production')], jobs: [job(1, 'build'), job(2, 'deploy-preview / ship'), job(3, 'deploy-staging / ship'), job(4, 'deploy-prod (eu-west)', 'waiting', null)],
  validations: [{ label: 'V1', state: 'final', verdict: 'passed', jobs: [1, 2], runId: 101, attempt: 1 }], ...over });

test('a takeover record is armed after the merge: keyed by the pull request when one discovered the rollout, else by the rollout', () => {
  const pulled = armRecord({ id: 'arm-2', pullResourceId: 'pr-r', pullNodeId: 'pr', now: T0, takeover: { catchUp: 'validate', rolloutNodeIds: ['rollout'] } });
  assert.deepEqual(pulled, { version: 1, id: 'arm-2', pullResourceId: 'pr-r', pullNodeId: 'pr', armedAt: T0, updatedAt: T0, state: 'armed', step: 'deploying', mergedAt: T0,
    takeover: { at: T0, catchUp: 'validate', rolloutNodeIds: ['rollout'] }, writes: [], fixes: [], checks: [] });
  assert.equal(recordKey(pulled), 'pr-r');
  const own = armRecord({ id: 'arm-3', rolloutResourceId: 'rollout-r', rolloutNodeId: 'rollout', now: T0, takeover: { catchUp: 'accept', rolloutNodeIds: ['rollout'] } });
  assert.equal('pullResourceId' in own, false); assert.equal('pullNodeId' in own, false);
  assert.deepEqual([own.rolloutResourceId, own.rolloutNodeId, own.mergedAt, recordKey(own)], ['rollout-r', 'rollout', T0, 'rollout-r']);
  assert.equal(statusLine(own), 'Auto deploy · deploying');
});

test('a record saved before takeovers existed still reads and decides', () => {
  const old = JSON.parse(JSON.stringify({ version: 1, id: 'arm-1', pullResourceId: 'pr-r', pullNodeId: 'pr', armedAt: T0, updatedAt: T0, state: 'armed', step: 'validating', detail: 'before live', mergedAt: T0,
    writes: [{ key: 'merge', kind: 'merge', requestId: 'm', at: T0, state: 'sent' }], fixes: [], checks: [{ key: 'rollout:101:1:gate:7', rolloutNodeId: 'rollout', label: 'before live', requestId: 'r', validationId: 'V1', requestedAt: T0, jobs: [1] }] })) as AutoDeployRecord;
  assert.equal(recordKey(old), 'pr-r');
  const waiting = rollout({ gates: [gate(7, 'live')], validations: [{ label: 'V1', state: 'final', verdict: 'passed' }] });
  assert.equal(decide(old, facts({ rollouts: [waiting] })).kind, 'approve');
  assert.deepEqual(autoDeployEvents(old).map(event => event.kind), ['armed', 'merged', 'validate']);
});

test('a takeover is refused on a run that finished, failed or has not started', () => {
  assert.equal(takeoverRefusal(rollout({ run: undefined })), 'Waiting for the deploy run.');
  assert.equal(takeoverRefusal(rollout({ run: { id: 101, attempt: 1, status: 'completed', conclusion: 'success', headSha: head } })), 'Already deployed.');
  assert.equal(takeoverRefusal(rollout({ run: { id: 101, attempt: 1, status: 'completed', conclusion: 'failure', headSha: head } })), 'The run failed. Re-run it on GitHub first.');
  assert.equal(takeoverRefusal(rollout({ run: { id: 101, attempt: 1, status: 'completed', conclusion: 'cancelled', headSha: head } })), 'The run failed. Re-run it on GitHub first.');
  assert.equal(takeoverRefusal(takeoverRollout()), undefined);
});

test('catching up by validating: a passing current validation counts for what it covered; the rest is validated before the waiting gate is approved', () => {
  const record = armRecord({ id: 'arm-2', pullResourceId: 'pr-r', pullNodeId: 'pr', now: T0, takeover: { catchUp: 'validate', rolloutNodeIds: ['rollout'] } });
  const stale = takeoverRollout({ validations: [{ label: 'V1', state: 'final', verdict: 'passed', jobs: [1, 2], runId: 101, attempt: 1, stale: true }, { label: 'V0', state: 'final', verdict: 'passed', jobs: [1, 2, 3], runId: 100, attempt: 1 }] });
  assert.deepEqual(seedCatchUp(record, [stale], T0).checks, [], 'a stale validation or one of another run counts for nothing');
  const seeded = seedCatchUp(record, [takeoverRollout()], T0);
  assert.deepEqual(seeded.checks, [{ key: 'rollout:101:1:seed:V1', rolloutNodeId: 'rollout', label: 'V1', requestId: 'arm-2:seed:rollout:101:1:seed:V1', validationId: 'V1', requestedAt: T0, jobs: [1, 2], seeded: true }]);
  assert.deepEqual(seeded.takeover?.counts, ['V1']);
  const first = decide(seeded, facts({ pull: undefined, rollouts: [takeoverRollout()] }));
  assert.deepEqual(first, { kind: 'validate', key: 'rollout:101:1:gate:7@4', rolloutNodeId: 'rollout', label: 'before production (deploy-prod (eu-west))', jobs: [3] }, 'only what V1 did not cover is validated');
  const asked = { ...seeded, checks: [...seeded.checks, check('rollout:101:1:gate:7@4', 'V2', T0, [3])] };
  const pending = takeoverRollout({ validations: [...takeoverRollout().validations, { label: 'V2', state: 'running' }] });
  waits(decide(asked, facts({ pull: undefined, rollouts: [pending] })), 'validating', 'before production (deploy-prod (eu-west))');
  const passed = takeoverRollout({ validations: [...takeoverRollout().validations, { label: 'V2', state: 'final', verdict: 'passed' }] });
  assert.equal(decide(asked, facts({ pull: undefined, rollouts: [passed] })).kind, 'approve', 'the gate is approved only after the catch-up validation passed');
  const covered = seedCatchUp(record, [takeoverRollout({ validations: [{ label: 'V1', state: 'final', verdict: 'passed', jobs: [1, 2, 3], runId: 101, attempt: 1 }] })], T0);
  assert.deepEqual(covered.checks.map(entry => [entry.key, entry.validationId]), [['rollout:101:1:seed:V1', 'V1'], ['rollout:101:1:gate:7@4', 'V1']], 'a due phase the validation fully covers counts at once');
  assert.equal(decide(covered, facts({ pull: undefined, rollouts: [takeoverRollout({ validations: [{ label: 'V1', state: 'final', verdict: 'passed' }] })] })).kind, 'approve');
});

test('catching up by accepting: what deployed counts as accepted, the waiting gate is approved at once, later phases are validated', () => {
  const record = armRecord({ id: 'arm-3', rolloutResourceId: 'rollout-r', rolloutNodeId: 'rollout', now: T0, takeover: { catchUp: 'accept', rolloutNodeIds: ['rollout'] } });
  const seeded = seedCatchUp(record, [takeoverRollout({ validations: [] })], T0);
  assert.deepEqual(seeded.checks.map(entry => [entry.key, entry.accepted, entry.jobs]), [['rollout:101:1:accepted', true, [1, 2, 3]], ['rollout:101:1:gate:7@4', true, []]]);
  assert.equal(decide(seeded, facts({ pull: undefined, rollouts: [takeoverRollout({ validations: [] })] })).kind, 'approve');
  const finished = takeoverRollout({ run: { id: 101, attempt: 1, status: 'completed', conclusion: 'success', headSha: head }, gates: [], validations: [], jobs: [job(1, 'build'), job(2, 'deploy-preview / ship'), job(3, 'deploy-staging / ship'), job(4, 'deploy-prod (eu-west)')] });
  assert.deepEqual(decide(seeded, facts({ pull: undefined, rollouts: [finished] })), { kind: 'validate', key: 'rollout:101:1:final', rolloutNodeId: 'rollout', label: 'whole run', jobs: [4] }, 'what deploys after arming is validated');
  assert.deepEqual(autoDeployEvents(seeded)[0], { at: T0, kind: 'armed', part: 'rollout', text: 'armed by you from here · what already deployed counts as accepted' });
});

const shape = (track: PhaseTrack) => track.phases.map(phase => [phase.name, phase.state, phase.noCheck ? 'no check' : phase.check ? `${phase.check.id ?? ''} ${phase.check.state}${phase.check.seeded ? ' counts' : ''}`.trim() : '', phase.gate ? `${phase.gate.state}${phase.gate.by ? ` by ${phase.gate.by}` : ''}${phase.gate.after ? ` after ${phase.gate.after}` : ''}` : '']);
const exampleJobs = () => [job(1, 'build'), job(2, 'test'), job(3, 'deploy-preview / ship'), job(4, 'smoke-preview'), job(5, 'deploy-staging / ship'), job(6, 'migrate-staging'), job(7, 'deploy-prod (eu-west)', 'waiting', null), job(8, 'deploy-prod (us-east)', 'waiting', null)];

test('phase track of the example: build, preview, staging and a gated production; a passing validation counts, the catch-up validates staging', () => {
  const record = { ...armRecord({ id: 'arm-2', pullResourceId: 'pr-r', pullNodeId: 'pr', now: T0, takeover: { catchUp: 'validate', rolloutNodeIds: ['rollout'] } }), step: 'validating' as const, detail: 'before production',
    checks: [{ ...check('rollout:101:1:seed:V1', 'V1', T0, [1, 2, 3, 4]), seeded: true as const }, check('rollout:101:1:gate:7@7,8', 'V2', T0, [5, 6])] };
  const example = rollout({ jobs: exampleJobs(), gates: [gate(7, 'production')], validations: [{ label: 'V1', state: 'final', verdict: 'passed' }, { label: 'V2', state: 'running' }] });
  const track = phaseTrack(record, example);
  assert.deepEqual(shape(track), [['build', 'done', 'no check', ''], ['preview', 'done', 'V1 passed counts', ''], ['staging', 'done', 'V2 running', ''], ['production', 'waiting', 'none', 'auto after V2']]);
  assert.deepEqual([track.current, track.currentGate], [2, undefined]);
  assert.deepEqual(track.phases.map(phase => phase.jobs), [{ done: 2, total: 2 }, { done: 2, total: 2 }, { done: 2, total: 2 }, { done: 0, total: 2 }]);
  assert.equal(track.phases[2].at, Date.parse('2026-10-08T10:20:00Z'));
  assert.equal(trackNext(track), 'approve production');
  const [rule] = parseStageRules(JSON.stringify([{ id: 'web', workflow: '^web', stages: [{ key: 'preview', environment: 'preview' }, { key: 'staging', environment: 'staging' }, { key: 'production', environment: 'production' }] }]));
  assert.deepEqual(phaseTrack(record, { ...example, rule }).phases.map(phase => phase.name), ['build', 'preview', 'staging', 'production'], 'a stage rule names the same phases, in its order');
  const concerns = { ...record, state: 'halted' as const, step: 'halted' as const, halt: { code: 'validation-concerns' as const, reason: 'V2 found concerns.', at: T0 } };
  const halted = phaseTrack(concerns, { ...example, validations: [{ label: 'V1', state: 'final', verdict: 'passed' }, { label: 'V2', state: 'final', verdict: 'concerns' }] });
  assert.deepEqual(shape(halted).slice(2), [['staging', 'done', 'V2 concerns', ''], ['production', 'waiting', 'none', 'you']], 'after a halt the gate waits for you');
  assert.equal(halted.current, 2);
});

test('phase track of a phased rollout: one phase per gate of the same environment, each approved on its own', () => {
  const record = { ...armRecord({ id: 'arm-2', rolloutResourceId: 'rollout-r', rolloutNodeId: 'rollout', now: T0, takeover: { catchUp: 'validate', rolloutNodeIds: ['rollout'] } }), step: 'approving' as const,
    checks: [check('rollout:101:1:gate:7@3', 'V1', T0, [1, 2]), check('rollout:101:1:gate:7@4', 'V2', T0, [3])],
    writes: [{ key: 'approve:rollout:101:1:7@3', kind: 'approve' as const, requestId: 'a', at: T0, state: 'sent' as const, label: 'production' }] };
  const phased = rollout({ gates: [gate(7, 'production')], gateEnvironments: ['production'], validations: [{ label: 'V1', state: 'final', verdict: 'passed' }, { label: 'V2', state: 'final', verdict: 'passed' }],
    jobs: [job(1, 'plan'), job(2, 'apply-staging / apply'), job(3, 'apply-prod-phase-1 / apply (region-1)'), job(4, 'apply-prod-phase-2 / apply (region-2)', 'waiting', null), job(5, 'apply-prod-phase-3 / apply (region-3)', 'queued', null)] });
  const track = phaseTrack(record, phased);
  assert.deepEqual(shape(track), [['build', 'done', 'no check', ''], ['staging', 'done', 'V1 passed', ''], ['production · phase-1', 'done', 'V2 passed', 'approved by auto deploy'],
    ['production · phase-2', 'waiting', 'none', 'approving after V2'], ['production · phase-3', 'waiting', 'none', 'auto']]);
  assert.deepEqual([track.current, track.currentGate], [3, true]);
  assert.equal(trackNext(track), 'deploy production · phase-2');
});

test('phase track of a rollout without gates is one phase; an accepted catch-up says so', () => {
  const record = { ...armRecord({ id: 'arm-3', rolloutResourceId: 'rollout-r', rolloutNodeId: 'rollout', now: T0, takeover: { catchUp: 'accept', rolloutNodeIds: ['rollout'] } }), step: 'deploying' as const };
  const single = phaseTrack(record, rollout({ jobs: [job(1, 'build'), job(2, 'deploy-web / ship', 'in_progress', null)] }));
  assert.deepEqual(shape(single), [['whole run', 'running', 'none', '']]);
  assert.deepEqual([single.current, trackNext(single)], [0, 'validate whole run']);
  const accepted = seedCatchUp(record, [takeoverRollout({ validations: [] })], T0);
  assert.deepEqual(shape(phaseTrack(accepted, takeoverRollout({ validations: [] }))), [['build', 'done', 'no check', ''], ['preview', 'done', 'accepted', ''], ['staging', 'done', 'accepted', ''], ['production', 'waiting', 'none', 'auto']]);
  const done = phaseTrack({ ...record, state: 'done', step: 'done' }, rollout({ run: { id: 101, attempt: 1, status: 'completed', conclusion: 'success', headSha: head } }));
  assert.deepEqual([done.current, trackNext(done)], [undefined, '']);
  const old = { version: 1, id: 'arm-1', pullResourceId: 'pr-r', pullNodeId: 'pr', armedAt: T0, updatedAt: T0, state: 'armed', step: 'validating', mergedAt: T0, writes: [], fixes: [], checks: [] } as AutoDeployRecord;
  assert.equal(phaseTrack(old, rollout({ gates: [gate(7, 'live')] })).phases.length, 1, 'a record saved before takeovers draws a track too');
});

const plainExample = (over: Partial<RolloutFacts> = {}) => rollout({ jobs: exampleJobs(), gates: [gate(7, 'production')], ...over });
const passed = (label: string, scope: { jobs?: number[]; environments?: string[] }, over: Partial<RolloutFacts['validations'][number]> = {}) =>
  ({ label, state: 'final' as const, verdict: 'passed' as const, runId: 101, attempt: 1, requestedAt: T0 + 30 * MIN, ...scope, ...over });

test('a plain rollout reads each phase check from its own validations: by jobs, by environment, or the whole run', () => {
  assert.deepEqual(shape(phaseTrack(undefined, plainExample({ validations: [passed('V1', { jobs: [3, 4] }), passed('V2', { environments: ['staging'] }, { verdict: 'concerns' })] }))),
    [['build', 'done', 'no check', ''], ['preview', 'done', 'V1 passed', ''], ['staging', 'done', 'V2 concerns', ''], ['production', 'waiting', 'none', 'you']]);
  const rechecked = phaseTrack(undefined, plainExample({ validations: [passed('V1', { environments: ['staging'] }, { verdict: 'concerns', resolvedBy: 'V2' }), passed('V2', { environments: ['staging'] })] }));
  assert.equal(shape(rechecked)[2][2], 'V2 passed', 'a newer passing re-check replaces concerns');
  const running = phaseTrack(undefined, plainExample({ validations: [passed('V1', { jobs: [5] }), { label: 'V2', state: 'running', runId: 101, attempt: 1, jobs: [5] }] }));
  assert.equal(shape(running)[2][2], 'V2 running');
  assert.equal(shape(phaseTrack(undefined, plainExample({ validations: [passed('V1', {})] })))[2][2], 'V1 passed', 'a whole-run validation covers the last phase that had run when it was requested');
  assert.equal(shape(phaseTrack(undefined, plainExample({ validations: [passed('V1', {}, { requestedAt: T0 })] })))[2][2], 'none', 'nothing had run yet');
  const ignored = phaseTrack(undefined, plainExample({ validations: [passed('V1', { jobs: [3, 4] }, { stale: true }), passed('V2', { jobs: [5] }, { attempt: 2 }), { label: 'V3', state: 'requested', runId: 101, attempt: 1, jobs: [5], resolvedBy: 'V4' }, passed('V4', { jobs: [1] })] }));
  assert.deepEqual(shape(ignored).slice(1, 3).map(phase => phase[2]), ['none', 'none'], 'stale, other attempts and requests a later final resolved do not count');
});

test('a plain rollout reads its gates from GitHub: you or another approver while held, approved with its time once it ran, later before it is reached', () => {
  assert.equal(phaseTrack(undefined, plainExample({ gates: [gate(7, 'production', false)] })).phases[3].gate?.state, 'other');
  const phased = rollout({ gates: [gate(7, 'production')], gateEnvironments: ['production'], gateApprovals: [{ environment: 'production', at: T0 + 5 * MIN }],
    jobs: [job(1, 'plan'), job(2, 'apply-staging / apply'), job(3, 'apply-prod-phase-1 / apply (region-1)'), job(4, 'apply-prod-phase-2 / apply (region-2)', 'waiting', null), job(5, 'apply-prod-phase-3 / apply (region-3)', 'queued', null)] });
  const track = phaseTrack(undefined, phased);
  assert.deepEqual(shape(track).map(phase => phase[3]), ['', '', 'approved', 'you', 'later']);
  assert.equal(track.phases[2].gate?.at, T0 + 5 * MIN, 'the approval time GitHub reported');
  const unseen = phaseTrack(undefined, { ...phased, gateApprovals: [] });
  assert.equal(unseen.phases[2].gate?.at, Date.parse('2026-10-08T10:10:00Z'), 'else the first job of the phase starting');
  assert.deepEqual(track.phases.map(phase => phase.jobIds), [[1], [2], [3], [4], [5]]);
});

test('a plain rollout is current at its held gate, else its running phase, else the phase being validated, else nowhere once finished; one phase draws no track', () => {
  const held = phaseTrack(undefined, plainExample());
  assert.deepEqual([held.current, held.currentGate, held.plain], [3, true, true]);
  const deploying = phaseTrack(undefined, plainExample({ gates: [], gateEnvironments: ['production'], jobs: exampleJobs().map(entry => entry.id === 7 ? { ...entry, status: 'in_progress' } : entry) }));
  assert.deepEqual([deploying.current, deploying.currentGate], [3, undefined]);
  const finished = (validations: RolloutFacts['validations']) => phaseTrack(undefined, rollout({ run: { id: 101, attempt: 1, status: 'completed', conclusion: 'success', headSha: head }, gateEnvironments: ['production'], validations,
    jobs: exampleJobs().map(entry => entry.status === 'waiting' ? job(entry.id, entry.name) : entry) }));
  assert.equal(finished([{ label: 'V1', state: 'running', runId: 101, attempt: 1, jobs: [7, 8] }]).current, 3);
  assert.equal(finished([]).current, undefined);
  assert.deepEqual(phaseTrack(undefined, rollout({ jobs: [job(1, 'build'), job(2, 'deploy-web / ship', 'in_progress', null)] })).phases, []);
  assert.equal(phaseTrack(undefined, plainExample({ autoValidate: true })).autoValidate, true);
});

test('a plain rollout whose parallel jobs interleave groups them by stage: per-stage builds are build, dev is a stage, a labelled gated phase is named', () => {
  const runners = rollout({ gates: [gate(7, 'app-production')], run: { id: 101, attempt: 1, status: 'waiting', conclusion: null, headSha: 'c'.repeat(40) }, jobs: [
    job(1, 'staging-build / build-worker-arm / Build app:worker-arm'), job(2, 'prod-build / build-tooling / Build app:tooling'), job(3, 'runtime-version'),
    job(4, 'prod-build / build-worker-amd / Build app:worker-amd'), job(5, 'staging-build / build-tooling / Build app:tooling'), job(6, 'get-regions / config'), job(7, 'dev-build'),
    job(8, 'promote-staging / get-regions / config'), job(9, 'Dev - ${{ matrix.zone.region }} ${{ matrix.zone.cluster }}'), job(10, 'promote-dev'), job(11, 'promote-staging / check-promoted'),
    job(12, 'promote-staging / promote ${{ inputs.env }} ${{ matrix.region }}'), job(13, 'prod-build / manifest-worker / create-manifest'), job(14, 'staging-build / manifest-worker / create-manifest'),
    job(15, 'staging-agentic-validate / agentic validation'), job(16, 'Staging - region-1 AWS / deploy'), job(17, 'Staging - region-2 SELF_HOSTED / deploy'),
    job(18, 'promote-prod / get-regions / config'), job(19, 'promote-prod / check-promoted'), job(20, 'prod-agentic-validate-phase-1 / agentic validation', 'waiting', null),
    job(21, 'Prod - region-3 AWS / deploy', 'waiting', null), job(22, 'promote-prod / promote ${{ inputs.env }} ${{ matrix.region }}')] });
  const track = phaseTrack(undefined, runners);
  assert.deepEqual(track.phases.map(phase => [phase.name, phase.jobs.total, phase.gate?.state ?? '']), [['build', 9, ''], ['dev', 2, ''], ['staging', 6, ''], ['production · phase-1', 5, 'you']]);
  assert.deepEqual([track.current, track.currentGate], [3, true]);
  const unnamed = rollout({ gates: [gate(7, 'live')], jobs: [job(1, 'plan'), job(2, 'apply-staging / apply'), job(3, 'apply-phase-1 / apply', 'waiting', null), job(4, 'apply-phase-2 / apply', 'queued', null)] });
  assert.deepEqual(phaseTrack(undefined, unnamed).phases.map(phase => phase.name), ['build', 'staging', 'phase-1', 'phase-2'], 'a phase named only by its label is not named twice');
});

test('staging stays before production when a staging job finishes after production is held at its gate', () => {
  const late = rollout({ gates: [gate(7, 'app-production')], run: { id: 101, attempt: 1, status: 'waiting', conclusion: null, headSha: 'c'.repeat(40) }, jobs: [
    job(1, 'build'), job(2, 'dev-deploy / deploy'), job(3, 'staging-deploy / deploy'), job(4, 'prod-deploy / deploy', 'waiting', null), job(5, 'staging-slack / slack')] });
  assert.deepEqual(phaseTrack(undefined, late).phases.map(phase => phase.name), ['build', 'dev', 'staging', 'production']);
});

test('a pull request with merge when ready on is not merged a second time: Auto deploy waits for GitHub as it does for the queue', () => {
  waits(decide(armed(), facts({ pull: pull({ mergeWhenReady: true }) })), 'merge-when-ready');
  waits(decide(armed(), facts({ pull: pull({ mergeWhenReady: true, mergeStateStatus: 'BLOCKED', reviewDecision: 'REVIEW_REQUIRED', checks: 'pending' }) })), 'merge-when-ready');
  assert.deepEqual(decide(armed(), facts({ pull: pull({ mergeWhenReady: true, title: 'Batch exports', tag: '' }) })), { kind: 'tag', title: 'Batch exports' });
  halts(decide(armed(), facts({ pull: pull({ mergeWhenReady: true, lifecycle: 'closed' }) })), 'closed');
  assert.deepEqual(decide(armed(), facts({ pull: pull({ mergeWhenReady: false }) })), { kind: 'merge', method: 'SQUASH', pullRequestId: 'PR_node42', head });
  const landed = facts({ pull: pull({ mergeWhenReady: true, lifecycle: 'merged' }) }), after = observe(armed(), landed);
  assert.equal(after.mergedAt, T0); waits(decide(after, landed), 'waiting-rollout');
  assert.equal(statusLine(settle(armed(), { kind: 'wait', step: 'merge-when-ready' }, T0)), 'Auto deploy · waiting for GitHub to merge when ready');
});

const moved = 'b'.repeat(40), baseHead = 'f'.repeat(40);
const finding = (id: string, kind: 'bug' | 'security' | 'hardening' | 'question', severity?: 'critical' | 'high' | 'medium' | 'low', over: Partial<LoopFinding> = {}): LoopFinding =>
  ({ id, kind, ...(severity ? { severity } : {}), title: `Finding ${id}`, status: 'open', ignored: false, ...over });
const review = (findings: LoopFinding[], state: 'running' | 'findings' = 'findings') => ({ nodeId: 'review', title: 'Claude review', state, findings });

test('an out-of-date branch without a merge queue is updated from its base once per base head, then checks are waited for', () => {
  const behind = facts({ pull: pull({ mergeStateStatus: 'BEHIND', baseHead }) });
  assert.deepEqual(decide(armed(), behind), { kind: 'update', pullRequestId: 'PR_node42', head, base: 'main', baseHead });
  const sentOnce = armed({ rebases: [{ head, base: baseHead, at: T0, mode: 'update' }], writes: [{ key: `update:${baseHead}`, kind: 'update', requestId: 'u', at: T0, state: 'sent' }] });
  waits(decide(sentOnce, behind), 'updating-branch', 'main');
  halts(decide(sentOnce, { ...behind, now: T0 + REBASE_DEADLINE_MS }), 'rebase-stalled', /GitHub did not update the branch within 45 minutes/);
  waits(decide(sentOnce, facts({ pull: pull({ head: moved, baseHead, checks: 'pending' }) })), 'waiting-checks');
  const newer = 'e'.repeat(40);
  assert.deepEqual(decide(sentOnce, facts({ pull: pull({ head: moved, mergeStateStatus: 'BEHIND', baseHead: newer }) })), { kind: 'update', pullRequestId: 'PR_node42', head: moved, base: 'main', baseHead: newer }, 'a base that moved again is a new update');
  assert.equal(decide(armed(), facts({ pull: pull({ queueEnabled: true, mergeStateStatus: 'BEHIND', method: 'QUEUE' }) })).kind, 'merge', 'the merge queue keeps the branch current itself');
  halts(decide(armed({ writes: [{ key: `update:${baseHead}`, kind: 'update', requestId: 'u', at: T0, state: 'sending' }] }), behind), 'outcome-unknown', /branch update could not be confirmed/);
  assert.equal(statusLine(settle(armed(), decide(armed(), behind), T0)), 'Auto deploy · updating the branch from main');
});

test('conflicts ask the fixer agent to rebase, once per head and at most twice; no new head within 45 minutes halts', () => {
  const dirty = facts({ pull: pull({ mergeStateStatus: 'DIRTY', checks: 'failing', failing: ['unit'] }) });
  assert.deepEqual(decide(armed(), dirty), { kind: 'rebase', attempt: 1, head, base: 'main' }, 'rebasing comes before fixing CI');
  const first = armed({ rebases: [{ head, base: 'main', at: T0, mode: 'agent', agentNodeId: 'impl', agentTitle: 'Claude · impl' }] });
  waits(decide(first, dirty), 'rebasing', 'main (1/2) · Claude · impl');
  assert.equal(statusLine(settle(first, decide(first, dirty), T0)), 'Auto deploy · rebasing onto main (1/2) · Claude · impl');
  halts(decide(first, { ...dirty, now: T0 + REBASE_DEADLINE_MS }), 'rebase-stalled', /Claude · impl pushed no rebased branch within 45 minutes/);
  assert.deepEqual(decide(first, facts({ pull: pull({ head: moved, mergeStateStatus: 'DIRTY' }) })), { kind: 'rebase', attempt: 2, head: moved, base: 'main' });
  const second = armed({ rebases: [...first.rebases!, { head: moved, base: 'main', at: T0, mode: 'agent' }] });
  halts(decide(second, facts({ pull: pull({ head: 'd'.repeat(40), mergeStateStatus: 'DIRTY' }) })), 'conflicts', new RegExp(`merge conflicts with main after ${REBASE_ATTEMPTS} rebase attempts`));
  assert.equal(decide(second, facts({ pull: pull({ head: 'd'.repeat(40) }) })).kind, 'merge', 'a clean branch after the second rebase merges');
  halts(decide(armed({ writes: [{ key: 'rebase:1', kind: 'rebase', requestId: 'r', at: T0, state: 'sending' }] }), dirty), 'outcome-unknown', /rebase request/);
  halts(decide(second, facts({ pull: pull({ head: 'd'.repeat(40), reviewDecision: 'REVIEW_REQUIRED' }) })), 'review-required', /only a person/);
});

test('blocking findings of the linked review go to the fixer once; a running review is waited for; ignored, fixed, medium and low ones stay', () => {
  waits(decide(armed(), facts({ review: review([], 'running') })), 'waiting-review', 'Claude review');
  assert.equal(statusLine(settle(armed(), decide(armed(), facts({ review: review([], 'running') })), T0)), 'Auto deploy · waiting for the Claude review');
  const findings = [finding('F1', 'bug', 'critical'), finding('F2', 'bug', 'high'), finding('F3', 'security'), finding('F4', 'bug', 'medium'), finding('F5', 'bug', 'low'), finding('F6', 'hardening'),
    finding('F7', 'bug', 'high', { ignored: true }), finding('F8', 'security', undefined, { status: 'fixed' }), finding('F9', 'question')];
  assert.deepEqual(decide(armed(), facts({ review: review(findings) })), { kind: 'send-findings', reviewNodeId: 'review', reviewTitle: 'Claude review', findingIds: ['F1', 'F2', 'F3'], head, counts: '1 critical, 1 high, 1 security' });
  assert.equal(decide(armed(), facts({ review: review(findings.slice(3)) })).kind, 'merge', 'nothing blocking moves on');
  assert.equal(observe(armed(), facts({ review: review(findings) })).reviewLeft, '1 medium, 1 low, 1 hardening, 1 question');
  assert.equal(statusLine(settle(observe(armed(), facts({ review: review(findings), pull: pull({ checks: 'pending' }) })), { kind: 'wait', step: 'waiting-checks' }, T0)), 'Auto deploy · waiting for checks · 1 medium, 1 low, 1 hardening, 1 question left for you');
  const dirty = facts({ review: review(findings), pull: pull({ mergeStateStatus: 'DIRTY' }) });
  assert.equal(decide(armed(), dirty).kind, 'rebase', 'the branch is rebased before findings are sent');
});

test('after the findings are sent: wait for the report and the push, then go on to checks; every doubt halts', () => {
  const findings = [finding('F1', 'bug', 'critical'), finding('F2', 'security')];
  const sentRecord = armed({ findingSends: [{ reviewNodeId: 'review', reviewTitle: 'Claude review', sendId: 's1', findingIds: ['F1', 'F2'], head, at: T0, agentNodeId: 'impl', agentTitle: 'Claude · impl', counts: '1 critical, 1 security' }] });
  const base = (send: AutoDeployFacts['send'], over: Partial<AutoDeployFacts> = {}) => facts({ review: review(findings.map(entry => ({ ...entry, status: 'sent' as const }))), send, ...over });
  waits(decide(sentRecord, base({ state: 'queued', reported: [] })), 'fixing-findings', 'Claude · impl is fixing 2 findings');
  assert.equal(statusLine(settle(sentRecord, decide(sentRecord, base({ state: 'sent', reported: [] })), T0)), 'Auto deploy · Claude · impl is fixing 2 findings');
  waits(decide(sentRecord, base({ state: 'sent', reported: ['F1'] })), 'fixing-findings', 'Claude · impl is fixing 2 findings');
  waits(decide(sentRecord, base({ state: 'sent', reported: ['F1', 'F2'] })), 'waiting-push', 'Claude · impl');
  assert.equal(statusLine(settle(sentRecord, decide(sentRecord, base({ state: 'sent', reported: ['F1', 'F2'] })), T0)), 'Auto deploy · waiting for Claude · impl to push');
  const pushed = base({ state: 'sent', reported: ['F1', 'F2'] }, { pull: pull({ head: moved, checks: 'pending' }) });
  waits(decide(sentRecord, pushed), 'waiting-checks');
  const seen = observe(sentRecord, pushed);
  assert.deepEqual([seen.findingSends![0].pushed, seen.findingSends![0].pushedAt, seen.findingSends![0].fixed], [moved, T0, ['F1', 'F2']]);
  assert.equal(decide(seen, facts({ pull: pull({ head: moved }), review: review(findings.map(entry => ({ ...entry, status: 'fixed' as const }))) })).kind, 'merge', 'once per review: no second send, no new review');
  const late = { now: T0 + FINDINGS_DEADLINE_MS };
  halts(decide(sentRecord, base({ state: 'sent', reported: [] }, late)), 'findings-stalled', /Claude · impl reported no fixes within 45 minutes/);
  halts(decide(sentRecord, base({ state: 'sent', reported: ['F1', 'F2'] }, late)), 'findings-no-push', /reported the findings fixed but pushed no new commit within 45 minutes/);
  halts(decide(sentRecord, base({ state: 'sent', reported: ['F1'], titles: { F2: 'Token leaks into logs' } }, late)), 'findings-unfixed', /did not report F2 “Token leaks into logs” fixed/);
  halts(decide(sentRecord, base({ state: 'failed', error: 'Claude · impl was removed from the map before it could receive the findings.', reported: [] })), 'findings-failed', /removed from the map/);
  halts(decide(sentRecord, base({ state: 'cancelled', reported: [] })), 'findings-failed', /cancelled/);
  halts(decide(sentRecord, base({ state: 'uncertain', reported: [] })), 'outcome-unknown', /could not be confirmed/);
  assert.deepEqual(decide(sentRecord, base({ state: 'missing', reported: [] })), { kind: 'send-findings', reviewNodeId: 'review', reviewTitle: 'Claude review', findingIds: ['F1', 'F2'], head, counts: '1 critical, 1 security' }, 'a send recorded but never journaled goes out again under its id');
});

test('a record saved before rebases and findings existed reads and decides unchanged', () => {
  const old = JSON.parse(JSON.stringify({ version: 1, id: 'arm-1', pullResourceId: 'pr-r', pullNodeId: 'pr', armedAt: T0, updatedAt: T0, state: 'armed', step: 'fixing-ci', detail: '1/2',
    writes: [{ key: 'tag', kind: 'tag', requestId: 't', at: T0, state: 'sent' }, { key: 'fix:1', kind: 'fix', requestId: 'f', at: T0, state: 'sent' }], fixes: [{ head, at: T0 }], checks: [] })) as AutoDeployRecord;
  waits(decide(old, facts({ pull: pull({ checks: 'failing', failing: ['unit'] }) })), 'fixing-ci', '1/2');
  assert.equal(decide(old, facts()).kind, 'merge');
  assert.deepEqual(autoDeployEvents(old).map(event => event.kind), ['armed', 'tag', 'fix']);
  assert.equal(statusLine(old), 'Auto deploy · fixing CI (1/2)');
});

test('the action list of a full run, in order, split into the pull request part and each rollout', () => {
  const at = (minutes: number) => T0 + minutes * MIN;
  const record: AutoDeployRecord = { ...armed(), state: 'done', step: 'done', updatedAt: at(80), base: 'main', mergedAt: at(30),
    writes: [{ key: 'tag', kind: 'tag', requestId: 't', at: at(0), state: 'sent' }, { key: 'rebase:1', kind: 'rebase', requestId: 'r', at: at(1), state: 'sent' }, { key: 'findings:review', kind: 'findings', requestId: 's1', at: at(10), state: 'sent' },
      { key: 'fix:1', kind: 'fix', requestId: 'f', at: at(20), state: 'sent' }, { key: 'merge', kind: 'merge', requestId: 'm', at: at(29), state: 'sent' },
      { key: 'approve:rollout:101:1:7', kind: 'approve', requestId: 'a', at: at(50), state: 'sent', label: 'production' }],
    rebases: [{ head, base: baseHead, at: at(1), mode: 'agent', agentNodeId: 'impl', agentTitle: 'Claude · impl', pushed: moved, pushedAt: at(9) }],
    findingSends: [{ reviewNodeId: 'review', reviewTitle: 'Claude review', sendId: 's1', findingIds: ['F1', 'F2', 'F3'], head: moved, at: at(10), agentNodeId: 'impl', agentTitle: 'Claude · impl', counts: '1 critical, 1 high, 1 security', left: '4 medium', fixed: ['F1', 'F2', 'F3'], pushed: 'c'.repeat(40), pushedAt: at(18) }],
    fixes: [{ head: 'c'.repeat(40), at: at(20), agentNodeId: 'impl', agentTitle: 'Claude · impl' }],
    checks: [{ ...check('rollout:101:1:gate:7', 'V1', at(40), [1]), label: 'staging', verdict: 'passed', answeredAt: at(48) }, { ...check('rollout:101:1:final', 'V2', at(60)), label: 'whole run', verdict: 'passed', answeredAt: at(75) }] };
  const events = autoDeployEvents(record);
  assert.deepEqual(events.map(event => [event.part, event.kind, event.text]), [
    ['pull', 'armed', 'armed by you'],
    ['pull', 'tag', 'tagged the title [ship]'],
    ['pull', 'rebase', 'asked Claude · impl to rebase onto main (1/2)'],
    ['pull', 'rebased', 'Claude · impl rebased and pushed bbbbbbb'],
    ['pull', 'findings', 'sent 3 findings of Claude review to Claude · impl · 1 critical, 1 high, 1 security · 4 medium left for you'],
    ['pull', 'fixed', 'Claude · impl fixed 3 and pushed ccccccc'],
    ['pull', 'fix', 'asked Claude · impl to fix CI (1/2)'],
    ['pull', 'merged', 'merged into main'],
    ['rollout', 'validate', 'asked Claude to validate staging · V1'],
    ['rollout', 'verdict', 'V1 passed'],
    ['rollout', 'approve', 'approved production'],
    ['rollout', 'validate', 'asked Claude to validate whole run · V2'],
    ['rollout', 'verdict', 'V2 passed'],
    ['rollout', 'done', 'done'],
  ]);
  assert.deepEqual(events.find(event => event.kind === 'rebased'), { at: at(9), kind: 'rebased', part: 'pull', text: 'Claude · impl rebased and pushed bbbbbbb', agentNodeId: 'impl', commit: moved });
  assert.deepEqual(events.find(event => event.kind === 'findings'), { at: at(10), kind: 'findings', part: 'pull', text: 'sent 3 findings of Claude review to Claude · impl · 1 critical, 1 high, 1 security · 4 medium left for you', agentNodeId: 'impl', reviewNodeId: 'review' });
  assert.equal(events.find(event => event.kind === 'validate')?.rolloutNodeId, 'rollout');
  const update = autoDeployEvents({ ...armed(), base: 'main', rebases: [{ head, base: baseHead, at: at(1), mode: 'update', pushed: moved, pushedAt: at(1) }], writes: [{ key: `update:${baseHead}`, kind: 'update', requestId: 'u', at: at(1), state: 'sent' }] });
  assert.deepEqual(update.map(event => event.text), ['armed by you', 'updated the branch from main · bbbbbbb']);
});

test('the action list of a halt ends with the halt, on the pull request before the merge', () => {
  const record: AutoDeployRecord = { ...armed(), state: 'halted', step: 'halted', base: 'main', updatedAt: T0 + 50 * MIN,
    rebases: [{ head, base: 'main', at: T0 + MIN, mode: 'agent', agentTitle: 'Claude · impl' }, { head: moved, base: 'main', at: T0 + 2 * MIN, mode: 'agent', agentTitle: 'Claude · impl' }],
    halt: { code: 'conflicts', reason: 'The branch still has merge conflicts with main after 2 rebase attempts.', at: T0 + 50 * MIN } };
  assert.deepEqual(autoDeployEvents(record).map(event => [event.part, event.kind, event.text]), [['pull', 'armed', 'armed by you'], ['pull', 'rebase', 'asked Claude · impl to rebase onto main (1/2)'],
    ['pull', 'rebase', 'asked Claude · impl to rebase onto main (2/2)'], ['pull', 'halted', 'halted: The branch still has merge conflicts with main after 2 rebase attempts.']]);
});

test('observe records each validation verdict once, when it is first seen final', () => {
  const record = merged({ checks: [check('rollout:101:1:final', 'V1', T0, [1])] });
  const finished = rollout({ run: { id: 101, attempt: 1, status: 'completed', conclusion: 'success', headSha: head } });
  assert.equal(observe(record, facts({ pull: undefined, rollouts: [{ ...finished, validations: [{ label: 'V1', state: 'running' }] }] })).checks[0].verdict, undefined);
  const seen = observe(record, facts({ now: T0 + 5 * MIN, pull: undefined, rollouts: [{ ...finished, validations: [{ label: 'V1', state: 'final', verdict: 'concerns' }] }] }));
  assert.deepEqual([seen.checks[0].verdict, seen.checks[0].answeredAt], ['concerns', T0 + 5 * MIN]);
  assert.equal(observe(seen, facts({ now: T0 + 9 * MIN, pull: undefined, rollouts: [{ ...finished, validations: [{ label: 'V1', state: 'final', verdict: 'concerns' }] }] })).checks[0].answeredAt, T0 + 5 * MIN);
});

test('a running group of jobs with no environment is named by what runs, never “other”', () => {
  waits(decide(merged(), facts({ rollouts: [rollout({ jobs: [job(1, 'publish-image', 'in_progress', null), job(2, 'lint')] })] })), 'deploying', 'publish-image');
  waits(decide(merged(), facts({ rollouts: [rollout({ jobs: [job(1, 'publish-image', 'in_progress', null), job(2, 'lint', 'in_progress', null), job(3, 'unit', 'in_progress', null)] })] })), 'deploying', '3 jobs');
  waits(decide(merged(), facts({ rollouts: [rollout({ jobs: [job(1, 'lint'), job(2, 'publish-image', 'queued', null), job(3, 'release', 'queued', null)] })] })), 'deploying', '2 jobs');
});
