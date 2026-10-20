import test from 'node:test';
import assert from 'node:assert/strict';
import { armRecord, decide, observe, settle, statusLine, FIX_ATTEMPTS, FIX_DEADLINE_MS, ROLLOUT_DEADLINE_MS, VALIDATION_DEADLINE_MS, BLOCKED_GRACE_MS } from './auto-deploy.ts';
import type { AutoDeployDecision, AutoDeployFacts, AutoDeployRecord, PullFacts, RolloutFacts } from './auto-deploy.ts';
import { parseStageRules } from './stages.ts';
import type { RolloutJob } from '../../../../packages/provider-runtime/github-rollout.ts';

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
  halts(decide(armed(), facts({ pull: pull({ mergeStateStatus: 'DIRTY' }) })), 'conflicts', /merge conflicts with main/);
  halts(decide(armed(), facts({ pull: pull({ mergeStateStatus: 'BEHIND' }) })), 'behind', /out of date with main/);
  halts(decide(armed({ blockedSince: T0 - BLOCKED_GRACE_MS }), facts({ pull: pull({ mergeStateStatus: 'BLOCKED' }) })), 'blocked', /blocked/);
  halts(decide(armed({ writes: [{ key: 'merge', kind: 'merge', requestId: 'm', at: T0, state: 'sent' }] }), facts({ pull: pull({ queueEnabled: true }) })), 'left-queue', /left the merge queue/);
  halts(decide(armed({ writes: [{ key: 'merge', kind: 'merge', requestId: 'm', at: T0, state: 'sending' }] }), facts()), 'outcome-unknown', /merge.*could not be confirmed/i);
  halts(decide(merged({ writes: [{ key: 'approve:x', kind: 'approve', requestId: 'a', at: T0, state: 'sending' }] }), facts()), 'outcome-unknown', /approval.*could not be confirmed/i);
  halts(decide(armed({ writes: [{ key: 'fix:1', kind: 'fix', requestId: 'f', at: T0, state: 'sending' }] }), facts()), 'outcome-unknown', /fix request/i);
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
