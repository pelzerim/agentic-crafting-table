import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REPORTED_RUN_EVENTS, TIMED_SKEW_MS, TIMED_WINDOW_MS, correlateWorkflowRun, correlateWorkflowRunByTime, reconcileUncertainWorkflowTrigger, reportedWorkflowRuns, workflowReviewRunName } from './workflow-correlation.ts';
import { reportMarker } from './workflow-contract.ts';

test('workflow correlation separates simultaneous comments and rejects title, repository and event lookalikes', () => {
  const run = { id: 10, repository: 'example/app', path: '.github/workflows/review.yml', event: 'issue_comment', displayTitle: workflowReviewRunName(123) };
  const unrelated = [
    { ...run, id: 11, displayTitle: workflowReviewRunName(124) },
    { ...run, id: 12, displayTitle: 'Fix the same pull request' },
    { ...run, id: 13, repository: 'another/app' }, { ...run, id: 14, path: '.github/workflows/other.yml' },
    { ...run, id: 15, event: 'pull_request' }, { ...run, id: 16, displayTitle: run.displayTitle + ' extra' },
  ];
  assert.deepEqual(correlateWorkflowRun('example/app', 123, unrelated), { status: 'not-observed' });
  assert.deepEqual(correlateWorkflowRun('example/app', 123, [run, run, ...unrelated]), { status: 'matched', run });
  assert.deepEqual(correlateWorkflowRun('example/app', 123, [run, { ...run, id: 20 }]), { status: 'ambiguous', runIds: [10, 20] });
  assert.throws(() => workflowReviewRunName(0)); assert.throws(() => workflowReviewRunName(Number.MAX_SAFE_INTEGER + 1));
});

test('accepted-POST timeouts never repost or auto-adopt identical comments from concurrent clients', () => {
  const request = { repository: 'example/app', prNumber: 42, author: 'reviewer', attemptedAt: '2026-09-25T12:00:00.800Z', knownCommentIds: [1] };
  const comment = { id: 2, repository: request.repository, prNumber: 42, author: request.author, body: '/review', createdAt: '2026-09-25T12:00:00Z' };
  for (const comments of [[], [comment], [comment, { ...comment, id: 3 }]]) {
    const result = reconcileUncertainWorkflowTrigger(request, comments);
    assert.equal(result.status, 'needs-confirmation'); assert.equal(result.safeToRepost, false);
    assert.deepEqual(result.commentIds, comments.map(comment => comment.id));
  }
  const unrelated = [{ ...comment, id: 1 }, { ...comment, id: 4, author: 'someone-else' }, { ...comment, id: 5, prNumber: 43 },
    { ...comment, id: 6, repository: 'other/app' }, { ...comment, id: 7, body: '/review extra' }, { ...comment, id: 8, createdAt: '2026-09-25T11:59:59Z' }];
  assert.deepEqual(reconcileUncertainWorkflowTrigger(request, unrelated).commentIds, []);
  assert.deepEqual(reconcileUncertainWorkflowTrigger(request, [comment, comment]).commentIds, [2]);
  assert.throws(() => reconcileUncertainWorkflowTrigger({ ...request, attemptedAt: 'unknown' }, []));
});

test('timed correlation adopts the single review run that started around the trigger comment', () => {
  const trigger = { id: 123, body: '/review', createdAt: '2026-09-25T12:00:00Z' };
  const run = { id: 10, repository: 'example/app', path: '.github/workflows/review.yml', event: 'issue_comment', createdAt: '2026-09-25T12:00:03Z', review: 'started' as const };
  assert.deepEqual(correlateWorkflowRunByTime('example/app', trigger, [trigger], [run, run]), { status: 'matched', run });
  assert.deepEqual(correlateWorkflowRunByTime('example/app', trigger, [trigger], []), { status: 'not-observed' });
  const outside = [{ ...run, id: 11, createdAt: '2026-09-25T12:03:01Z' }, { ...run, id: 12, createdAt: '2026-09-25T11:59:49Z' }, { ...run, id: 13, repository: 'another/app' },
    { ...run, id: 14, path: '.github/workflows/other.yml' }, { ...run, id: 15, event: 'pull_request' }, { ...run, id: 16, review: 'skipped' as const }];
  assert.deepEqual(correlateWorkflowRunByTime('example/app', trigger, [trigger], outside), { status: 'not-observed' });
  const skewed = { ...run, createdAt: '2026-09-25T11:59:55Z' }, late = { ...run, createdAt: '2026-09-25T12:02:59Z' };
  assert.deepEqual(correlateWorkflowRunByTime('example/app', trigger, [trigger], [skewed, ...outside]), { status: 'matched', run: skewed });
  assert.deepEqual(correlateWorkflowRunByTime('example/app', trigger, [trigger], [late]), { status: 'matched', run: late });
  assert.equal(TIMED_WINDOW_MS, 3 * 60_000); assert.ok(TIMED_SKEW_MS > 5000 && TIMED_SKEW_MS < 11_000);
  assert.throws(() => correlateWorkflowRunByTime('example/app', { ...trigger, createdAt: 'unknown' }, [], [run]));
});

test('timed correlation waits for undecided runs and never guesses between candidates', () => {
  const trigger = { id: 123, body: '/review', createdAt: '2026-09-25T12:00:00Z' };
  const run = { id: 10, repository: 'example/app', path: '.github/workflows/review.yml', event: 'issue_comment', createdAt: '2026-09-25T12:00:03Z', review: 'started' as const };
  const queued = { ...run, id: 11, review: 'pending' as const };
  assert.deepEqual(correlateWorkflowRunByTime('example/app', trigger, [trigger], [run, queued]), { status: 'pending', runIds: [11] });
  assert.deepEqual(correlateWorkflowRunByTime('example/app', trigger, [trigger], [queued]), { status: 'pending', runIds: [11] });
  const two = correlateWorkflowRunByTime('example/app', trigger, [trigger], [run, { ...run, id: 20, createdAt: '2026-09-25T12:01:00Z' }]);
  assert.equal(two.status, 'ambiguous'); assert.deepEqual(two.status === 'ambiguous' && two.runIds, [10, 20]); assert.match(two.status === 'ambiguous' ? two.reason : '', /more than one/i);
  for (const other of [{ id: 124, body: '/review', createdAt: '2026-09-25T12:01:30Z' }, { id: 125, body: '/review please', createdAt: '2026-09-25T11:59:52Z' }]) {
    const result = correlateWorkflowRunByTime('example/app', trigger, [trigger, other], [run]);
    assert.equal(result.status, 'ambiguous'); assert.deepEqual(result.status === 'ambiguous' && result.commentIds, [other.id]); assert.match(result.status === 'ambiguous' ? result.reason : '', /another \/review/i);
  }
  const unrelated = [{ id: 126, body: '/review', createdAt: '2026-09-25T11:50:00Z' }, { id: 127, body: '/review', createdAt: '2026-09-25T12:03:01Z' }, { id: 128, body: 'Looks good, /review later', createdAt: '2026-09-25T12:00:30Z' }];
  assert.deepEqual(correlateWorkflowRunByTime('example/app', trigger, [trigger, ...unrelated], [run]), { status: 'matched', run });
});

test('a bot comment that links exactly one workflow run of the repository names a reported run', () => {
  const marker = reportMarker({}), link = (id: number, repository = 'fixture/billing') => `[View run](https://github.com/${repository}/actions/runs/${id})`;
  const started = { id: 1, author: 'github-actions[bot]', body: `Review started. ${link(10)}`, createdAt: '2026-09-25T12:00:00Z' };
  assert.deepEqual(reportedWorkflowRuns('fixture/billing', [started, started], marker), [{ runId: 10, commentId: 1, createdAt: started.createdAt }]);
  assert.deepEqual(reportedWorkflowRuns('Fixture/Billing', [started], marker).map(run => run.runId), [10], 'a repository name is the same in any letter case');
  const ignored = [
    { ...started, id: 2, author: 'fixture-developer' }, { ...started, id: 3, body: `Review started. ${link(11, 'another/app')}` },
    { ...started, id: 4, body: `${link(12)} and ${link(13)}` }, { ...started, id: 5, body: 'Review started.' },
    { ...started, id: 6, body: 'https://github.com/fixture/billing/actions/runs/14' }, { ...started, id: 7, body: '[job](https://github.com/fixture/billing/actions/runs/15/job/3)' },
    { ...started, id: 8, body: link(16, 'fixture/billing-tools') }, { ...started, id: 9, body: link(0) },
  ];
  assert.deepEqual(reportedWorkflowRuns('fixture/billing', ignored, marker), []);
  assert.deepEqual(reportedWorkflowRuns('fixture/billing', [{ ...started, body: `${link(10)} ${link(10)}` }], marker).map(run => run.runId), [10]);
  assert.deepEqual(REPORTED_RUN_EVENTS, ['issue_comment', 'pull_request', 'pull_request_target']);
});

test('several bot comments on one run yield the single one the report marker matches; reported runs come oldest first', () => {
  const marker = reportMarker({}), link = (id: number) => `[View run](https://github.com/fixture/billing/actions/runs/${id})`;
  const note = { id: 1, author: 'github-actions[bot]', body: `Score 3 of 5. ${link(10)}`, createdAt: '2026-09-25T12:00:00Z' };
  const report = { id: 2, author: 'github-actions[bot]', body: `## Summary\nOne finding\n${link(10)}`, createdAt: '2026-09-25T12:05:00Z' };
  assert.deepEqual(reportedWorkflowRuns('fixture/billing', [note, report], marker), [{ runId: 10, commentId: 2, createdAt: report.createdAt }]);
  assert.deepEqual(reportedWorkflowRuns('fixture/billing', [note, { ...note, id: 3 }], marker), []);
  assert.deepEqual(reportedWorkflowRuns('fixture/billing', [report, { ...report, id: 3 }], marker), []);
  const earlier = { ...report, id: 4, body: report.body.replaceAll('/runs/10', '/runs/9'), createdAt: '2026-09-25T11:00:00Z' };
  assert.deepEqual(reportedWorkflowRuns('fixture/billing', [report, earlier], marker).map(run => run.runId), [9, 10]);
});
