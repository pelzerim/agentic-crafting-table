import type { GitHubComment, GitHubPullRequest, GitHubReview, MergeQueueState } from './github.ts';
import type { GitHubWorkflowRun } from './github.ts';
import type { ResourceIndicator } from '../../src/resource-plugins/indicators.ts';

const DEPLOY_WORDS = /(deploy|rollout|release|apply|(^|[^a-z])cd([^a-z]|$))/i;
/** Pull-request event runs created this long before the recorded merge still belong to it. */
const MERGE_CLOCK_SKEW_MS = 2 * 60_000;
/** Deployment-like runs started by a merge: named/filed as a deploy, rollout,
 * release, apply or CD workflow, or already waiting on a gate. Push and
 * workflow_run runs count; pull-request-event runs count only when created by
 * the merge itself (the closed event on the head commit). Plain CI never does. */
export function isDeployRun(run: GitHubWorkflowRun, mergedAt?: number) {
  const closedPull = ['pull_request', 'pull_request_target'].includes(run.event) && mergedAt !== undefined && Date.parse(run.created_at ?? '') >= mergedAt - MERGE_CLOCK_SKEW_MS;
  if (!['push', 'workflow_run'].includes(run.event) && !closedPull) return false;
  return run.status === 'waiting' || DEPLOY_WORDS.test(`${run.name ?? ''} ${(run.path ?? '').split('/').pop() ?? ''}`);
}
/** How a merged pull request names a deploy run it discovered. */
export const rolloutDiscoveryKey = (runId: number) => `rollout:${runId}`;
/** After merge, workflow_run chains can start well after the merge itself. */
export const MERGE_ROLLOUT_WINDOW_MS = 6 * 60 * 60_000;

export type PullStatus = 'merged' | 'queued' | 'closed' | 'checks-failing' | 'changes-requested' | 'approved' | 'draft' | 'open';
/** The map cue of each status; it leads a pull request's indicators as `review-state`. */
export const PULL_CUES: Record<PullStatus, Omit<ResourceIndicator, 'id'>> = {
  merged: { label: 'Merged', tone: 'violet', icon: 'git-merge', stage: 'done' }, queued: { label: 'Queued', tone: 'amber', icon: 'git-merge' }, closed: { label: 'Closed', tone: 'red', icon: 'x', stage: 'done' },
  'checks-failing': { label: 'Checks failing', tone: 'red', icon: 'x', stage: 'failing' },
  'changes-requested': { label: 'Changes requested', tone: 'amber', icon: 'alert-triangle' }, approved: { label: 'Approved', tone: 'green', icon: 'check', stage: 'ready' },
  draft: { label: 'Draft', tone: 'neutral', icon: 'clock' }, open: { label: 'Open', tone: 'green', icon: 'git-pull-request' },
};
/** GitHub returns reviews chronologically. Comment-only reviews do not revoke a
 * decisive review; a dismissal does. This is review approval, not mergeability.
 * An open PR in the merge queue reports Queued ahead of its review outcome; failing
 * checks on the current head of a ready PR report Checks failing ahead of reviews. */
export function pullStatus(pull: GitHubPullRequest, reviews: GitHubReview[], comments: GitHubComment[], inline: GitHubComment[], queue: MergeQueueState | null = null) {
  const latest = new Map<string, string>();
  for (const review of [...reviews].sort((a, b) => (a.submitted_at ?? '').localeCompare(b.submitted_at ?? '') || a.id - b.id)) {
    if (review.user && ['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(review.state)) latest.set(review.user.login.toLowerCase(), review.state);
  }
  const decisions = [...latest.values()], head = pull.head.sha.toLowerCase();
  const failing = !pull.draft && queue?.checks?.head === head && queue.checks.failing.length > 0;
  const state: PullStatus = pull.merged ? 'merged' : pull.state === 'closed' ? 'closed' : queue?.queued ? 'queued' : failing ? 'checks-failing' : decisions.includes('CHANGES_REQUESTED') ? 'changes-requested'
    : decisions.includes('APPROVED') ? 'approved' : pull.draft ? 'draft' : 'open';
  const count = comments.length + inline.length;
  const indicators: ResourceIndicator[] = [{ id: 'review-state', ...PULL_CUES[state] }, { id: 'comments', label: `${count} comment${count === 1 ? '' : 's'}`, icon: 'message-square', tone: count ? 'blue' : 'neutral' }];
  const attention = state === 'approved' ? 'approved' as const : state === 'checks-failing' ? 'checks-failing' as const : null;
  return { state, label: indicators.map(cue => cue.label).join(' · '), indicators, approved: state === 'approved', comments: count, attention,
    ...(attention ? { attentionNote: attention === 'approved' ? 'PR approved' : 'Checks failing' } : {}),
    ...(state === 'checks-failing' ? { attentionEventId: `checks-failing:${head}`, failingChecks: queue!.checks!.failing } : {}) };
}
