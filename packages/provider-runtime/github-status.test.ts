import test from 'node:test';
import assert from 'node:assert/strict';
import { isDeployRun, pullStatus } from './github-status.ts';
import { githubFixture, pullFixture } from '../../tests/fixtures/github.ts';
import type { GitHubReview, GitHubWorkflowRun } from './github.ts';

const review = (id: number, state: string, login = 'reviewer'): GitHubReview => ({ id, state, user: { login }, body: '', submitted_at: `2026-09-${String(id).padStart(2, '0')}T00:00:00Z`, commit_id: pullFixture.head.sha });
test('latest decisive reviews determine approval; comments and pending reviews cannot revoke it', () => {
  const status = (reviews: GitHubReview[]) => pullStatus({ ...pullFixture, state: 'open' }, reviews, [], []).state;
  assert.equal(status([review(1, 'APPROVED'), review(2, 'COMMENTED'), review(3, 'PENDING')]), 'approved');
  assert.equal(status([review(1, 'APPROVED'), review(2, 'CHANGES_REQUESTED', 'second')]), 'changes-requested');
  assert.equal(status([review(2, 'APPROVED'), review(1, 'CHANGES_REQUESTED')]), 'approved');
  assert.equal(status([review(1, 'DISMISSED'), review(2, 'COMMENTED')]), 'open');
  assert.equal(status([review(1, 'APPROVED'), review(2, 'DISMISSED')]), 'open');
  assert.equal(status([{ ...review(1, 'APPROVED'), user: null }]), 'open');
});
test('closed/merged PRs cannot produce approval attention, with combined discussion and inline counts', async () => {
  const fixture = githubFixture(), signal = new AbortController().signal;
  fixture.inline = [{ ...fixture.comments[0], id: 10 }];
  const comments = await fixture.client.comments(pullFixtureIdentity, signal), inline = await fixture.client.reviewComments(pullFixtureIdentity, signal);
  for (const merged of [false, true]) {
    const status = pullStatus({ ...pullFixture, state: 'closed', merged }, [review(1, 'APPROVED')], comments, inline);
    assert.equal(status.state, merged ? 'merged' : 'closed'); assert.equal(status.approved, false);
    assert.equal(status.comments, 2); assert.equal(status.indicators[1].label, '2 comments');
  }
  assert.equal(pullStatus({ ...pullFixture, draft: true, state: 'open' }, [], [], []).state, 'draft');
});
const pullFixtureIdentity = { owner: 'fixture', repo: 'billing', number: 42 };
test('merge queue membership shows Queued over review outcome but never over closed/merged', () => {
  const queued = { queued: true, position: 2 };
  const status = pullStatus({ ...pullFixture, state: 'open' }, [review(1, 'APPROVED')], [], [], queued);
  assert.equal(status.state, 'queued'); assert.equal(status.approved, false);
  assert.deepEqual(status.indicators[0], { id: 'review-state', label: 'Queued', tone: 'amber', icon: 'git-merge' });
  assert.equal(pullStatus({ ...pullFixture, state: 'open' }, [review(1, 'CHANGES_REQUESTED')], [], [], queued).state, 'queued');
  assert.equal(pullStatus({ ...pullFixture, state: 'closed', merged: true }, [], [], [], queued).state, 'merged');
  assert.equal(pullStatus({ ...pullFixture, state: 'open' }, [review(1, 'APPROVED')], [], [], { queued: false, position: null }).state, 'approved');
  assert.equal(pullStatus({ ...pullFixture, state: 'open' }, [review(1, 'APPROVED')], [], [], null).state, 'approved');
});
test('merge commit discovery keeps deploy-like push/workflow_run runs and skips plain CI', () => {
  const run = (name: string, extra: Partial<GitHubWorkflowRun> = {}): GitHubWorkflowRun => ({ id: 1, name, path: '.github/workflows/ci.yml', event: 'push', status: 'in_progress', head_sha: 'c'.repeat(40), ...extra });
  for (const name of ['Web CD', 'Deploy production', 'Web / Release', 'Docs apply', 'Release']) assert.equal(isDeployRun(run(name)), true, name);
  assert.equal(isDeployRun(run('Build', { path: '.github/workflows/api-cd.yml' })), true);
  assert.equal(isDeployRun(run('Build', { status: 'waiting' })), true);
  assert.equal(isDeployRun(run('Deploy chained', { event: 'workflow_run' })), true);
  for (const name of ['CI', 'Unit tests', 'Lint', 'Codecov', 'Abcdef']) assert.equal(isDeployRun(run(name)), false, name);
  assert.equal(isDeployRun(run('Deploy preview', { event: 'pull_request' })), false);
  assert.equal(isDeployRun(run('Deploy manually', { event: 'workflow_dispatch' })), false);
});
test('failing checks on the current head are a PR status and a Needs me reason per head commit', () => {
  const open = { ...pullFixture, state: 'open' as const }, head = pullFixture.head.sha, checks = { head, failing: ['unit'] };
  const failing = pullStatus(open, [review(1, 'APPROVED')], [], [], { queued: false, position: null, checks });
  assert.equal(failing.state, 'checks-failing'); assert.equal(failing.approved, false);
  assert.deepEqual(failing.indicators[0], { id: 'review-state', label: 'Checks failing', tone: 'red', icon: 'x', stage: 'failing' });
  assert.equal(failing.attention, 'checks-failing'); assert.equal(failing.attentionEventId, `checks-failing:${head}`); assert.equal(failing.attentionNote, 'Checks failing');
  const next = pullStatus({ ...open, head: { ...open.head, sha: 'd'.repeat(40) } }, [], [], [], { queued: false, position: null, checks: { head: 'd'.repeat(40), failing: ['lint'] } });
  assert.notEqual(next.attentionEventId, failing.attentionEventId);
  const passing = pullStatus(open, [review(1, 'APPROVED')], [], [], { queued: false, position: null, checks: { head, failing: [] } });
  assert.equal(passing.state, 'approved'); assert.equal(passing.attention, 'approved'); assert.equal(passing.attentionEventId, undefined); assert.equal(passing.attentionNote, 'PR approved');
  assert.equal(pullStatus(open, [], [], [], { queued: false, position: null }).attention, null);
  assert.equal(pullStatus(open, [], [], [], { queued: false, position: null }).attentionNote, undefined);
  assert.equal(pullStatus(open, [], [], [], { queued: false, position: null, checks: { head: 'e'.repeat(40), failing: ['stale'] } }).state, 'open', 'checks of an older head are ignored');
  assert.equal(pullStatus({ ...open, draft: true }, [], [], [], { queued: false, position: null, checks }).state, 'draft');
  assert.equal(pullStatus(open, [], [], [], { queued: true, position: 1, checks }).state, 'queued');
  assert.equal(pullStatus({ ...open, state: 'closed', merged: true }, [], [], [], { queued: false, position: null, checks }).state, 'merged');
  assert.equal(pullStatus({ ...open, state: 'closed', merged: true }, [], [], []).indicators[0].stage, 'done');
  assert.equal(pullStatus(open, [review(1, 'APPROVED')], [], []).indicators[0].stage, 'ready');
});
test('merged PR rollouts include closed-PR runs on the head commit, never pre-merge CI', () => {
  const mergedAt = Date.parse('2026-09-30T07:00:00Z');
  const run = (extra: Partial<GitHubWorkflowRun> = {}): GitHubWorkflowRun => ({ id: 1, name: 'Deploy API', path: '.github/workflows/deploy-api.yml', event: 'pull_request', status: 'in_progress', head_sha: 'h'.repeat(40).replace(/h/g, 'a'), created_at: '2026-09-30T07:00:03Z', ...extra });
  assert.equal(isDeployRun(run(), mergedAt), true);
  assert.equal(isDeployRun(run({ name: 'Build & Deploy docs', path: '.github/workflows/docs-deploy.yaml', event: 'pull_request_target' }), mergedAt), true);
  assert.equal(isDeployRun(run({ created_at: '2026-09-30T06:40:00Z' }), mergedAt), false, 'pre-merge runs on the head are CI, not rollouts');
  assert.equal(isDeployRun(run({ created_at: undefined }), mergedAt), false);
  assert.equal(isDeployRun(run()), false, 'pull request events need a merge time');
  assert.equal(isDeployRun(run({ name: 'CI', path: '.github/workflows/ci.yml' }), mergedAt), false);
  assert.equal(isDeployRun(run({ event: 'push', created_at: undefined })), true);
});

test('merge when ready shows as Merge when ready with its method, behind the queue and failing checks, ahead of review outcomes', () => {
  const on = (method: 'SQUASH' | 'MERGE' | 'REBASE' | 'QUEUE' | null) => ({ queued: false, position: null, mergeWhenReady: { method, enabledAt: '2026-10-30T09:00:00Z' } });
  const status = pullStatus({ ...pullFixture, state: 'open' }, [review(1, 'APPROVED')], [], [], on('SQUASH'));
  assert.equal(status.state, 'merge-when-ready'); assert.equal(status.approved, false); assert.equal(status.attention, null);
  assert.deepEqual(status.indicators[0], { id: 'review-state', label: 'Merge when ready (squash)', tone: 'amber', icon: 'git-merge' });
  assert.equal(status.statusWithoutMergeWhenReady, 'approved');
  for (const [method, label] of [['MERGE', 'Merge when ready (merge commit)'], ['REBASE', 'Merge when ready (rebase)'], ['QUEUE', 'Merge when ready (merge queue)'], [null, 'Merge when ready']] as const)
    assert.equal(pullStatus({ ...pullFixture, state: 'open' }, [], [], [], on(method)).indicators[0].label, label);
  assert.equal(pullStatus({ ...pullFixture, state: 'open' }, [review(1, 'CHANGES_REQUESTED')], [], [], on('SQUASH')).state, 'merge-when-ready');
  assert.equal(pullStatus({ ...pullFixture, state: 'open' }, [], [], [], { ...on('QUEUE'), queued: true, position: 0 }).state, 'queued');
  const failing = { ...on('SQUASH'), checks: { head: pullFixture.head.sha, failing: ['test'] } };
  assert.equal(pullStatus({ ...pullFixture, state: 'open' }, [], [], [], failing).state, 'checks-failing');
  assert.equal(pullStatus({ ...pullFixture, state: 'closed', merged: true }, [], [], [], on('SQUASH')).state, 'merged');
  assert.equal(pullStatus({ ...pullFixture, state: 'open' }, [], [], [], null).statusWithoutMergeWhenReady, undefined);
});
