import assert from 'node:assert/strict';
import test from 'node:test';
import { markPullRequestViewed, reconcileAssignments } from './assigned.ts';
import type { PullRequestSnapshot } from './assigned.ts';
import { buildArchitectureLaunch } from './architecture.ts';

const account = { id: 'github-account', login: 'me' };
const pr: PullRequestSnapshot = { id: 'PR_1', repository: 'org/repo', number: 42, title: 'Plan changes', url: 'https://github.com/org/repo/pull/42', headSha: 'head-one', assignees: ['Me'], state: 'open' };
const projects = [{ id: 'billing', repository: 'org/repo' }];

test('assigned PRs auto-attach once; unmatched or ambiguous repositories stay in the inbox', () => {
  const first = reconcileAssignments([], account, [pr, pr], projects, 't1');
  assert.equal(first.length, 1);
  assert.equal(first[0].projectId, 'billing');
  assert.equal(first[0].needsMe, true);
  assert.equal(reconcileAssignments([], account, [pr], [], 't1')[0].projectId, undefined);
  assert.equal(reconcileAssignments([], account, [pr], [...projects, { id: 'other', repository: 'org/repo' }], 't1')[0].projectId, undefined);
});

test('opening clears needs-me without review state; repeated sync and commit updates do not unread it', () => {
  const first = reconcileAssignments([], account, [pr], projects, 't1');
  const viewed = markPullRequestViewed(first, account.id, pr.id, 't2');
  const synced = reconcileAssignments(viewed, account, [{ ...pr, headSha: 'head-two' }], projects, 't3');
  assert.equal(first[0].needsMe, true);
  assert.equal(synced[0].needsMe, false);
  assert.equal(synced[0].viewedAt, 't2');
  assert.equal(synced[0].pr.state, 'open');
});

test('unassignment or closure clears attention; reassignment is a new unseen assignment', () => {
  const first = reconcileAssignments([], account, [pr], projects, 't1');
  const gone = reconcileAssignments(first, account, [], projects, 't2');
  assert.equal(gone[0].assigned, false);
  assert.equal(gone[0].needsMe, false);
  const again = reconcileAssignments(gone, account, [pr], projects, 't3');
  assert.equal(again[0].needsMe, true);
  assert.equal(again[0].assignedAt, 't3');
  assert.equal(reconcileAssignments(again, account, [{ ...pr, state: 'merged' }], projects, 't4')[0].needsMe, false);
});

test('one account viewing a PR never clears another account’s attention', () => {
  const first = reconcileAssignments([], account, [pr], projects, 't1');
  const both = reconcileAssignments(first, { id: 'other-account', login: 'me' }, [pr], projects, 't1');
  const viewed = markPullRequestViewed(both, account.id, pr.id, 't2');
  assert.equal(viewed.find(e => e.accountId === 'other-account')!.needsMe, true);
});

test('architecture action pins context and diff to a revision and asks Claude for both outputs', () => {
  const changes = { pr, baseSha: 'base-one', diff: '+ renderPlanPreview();', changedFiles: ['src/billing.ts'], description: 'Preview the price.' };
  const run = buildArchitectureLaunch({ id: 'billing', name: 'Billing', goal: 'Clear plan changes' }, changes, { agentNodeId: 'architecture-1' });
  assert.equal(run.request.provider, 'claude');
  assert.equal(run.request.systemPrompt, run.request.toolContext.prompt);
  assert.ok(!run.request.systemPrompt.includes(changes.diff));
  assert.match(run.request.toolContext.prompt, /"agentNodeId":"architecture-1"/);
  assert.match(run.request.initialPrompt, /Analyze only: do not modify code/);
  for (const expected of ['Clear plan changes', 'head-one', 'base-one', changes.diff, 'src/billing.ts', 'architecture overview', 'flow diagram', 'private Claude artifact', 'Artifact tool']) assert.ok(run.request.initialPrompt.includes(expected), expected);
  assert.equal(run.output, 'claude.artifact');
  assert.notEqual(run.deduplicationKey, buildArchitectureLaunch({ id: 'billing', name: 'Billing', goal: '' }, { ...changes, pr: { ...pr, headSha: 'head-two' } }).deduplicationKey);
  assert.equal(run.sourceBaseSha, changes.baseSha);
  assert.notEqual(run.deduplicationKey, buildArchitectureLaunch({ id: 'billing', name: 'Billing', goal: '' }, { ...changes, baseSha: 'base-two' }).deduplicationKey);
  assert.notEqual(run.deduplicationKey, buildArchitectureLaunch({ id: 'billing', name: 'Billing', goal: '' }, { ...changes, baseTipSha: 'base-tip-two' }).deduplicationKey);
  assert.throws(() => buildArchitectureLaunch({ id: 'billing', name: 'Billing', goal: '' }, { ...changes, diff: '' }), /Load the PR changes/);
});
