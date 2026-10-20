import { DEFAULT_WORKFLOW_REVIEW_CONTRACT } from './workflow-contract.ts';
/** A run must carry the immutable trigger identity. Time, actor, PR title and
 * head SHA cannot distinguish two /review comments on the same pull request. */
export function workflowReviewRunName(triggerCommentId: number) {
  if (!Number.isSafeInteger(triggerCommentId) || triggerCommentId <= 0) throw new Error('A GitHub trigger comment ID is required');
  return `ACT review comment ${triggerCommentId}`;
}

export interface WorkflowRunCandidate {
  id: number;
  repository: string;
  path: string;
  event: string;
  displayTitle: string;
}

export function correlateWorkflowRun(repository: string, triggerCommentId: number, candidates: WorkflowRunCandidate[], workflowPath = DEFAULT_WORKFLOW_REVIEW_CONTRACT.workflowPath) {
  const name = workflowReviewRunName(triggerCommentId);
  const matches = candidates.filter(run => run.repository === repository && run.path === workflowPath
    && run.event === 'issue_comment' && run.displayTitle === name && Number.isSafeInteger(run.id) && run.id > 0);
  const unique = [...new Map(matches.map(run => [run.id, run])).values()];
  if (unique.length > 1) return { status: 'ambiguous' as const, runIds: unique.map(run => run.id) };
  return unique.length ? { status: 'matched' as const, run: unique[0] } : { status: 'not-observed' as const };
}

export const TIMED_SKEW_MS = 10_000;
export const TIMED_WINDOW_MS = 3 * 60_000;
export function timedWindow(triggerCreatedAt: string) {
  const at = Date.parse(triggerCreatedAt);
  if (!Number.isFinite(at)) throw new Error('The trigger comment time is required');
  return { start: at - TIMED_SKEW_MS, end: at + TIMED_WINDOW_MS };
}
export interface PullRequestComment { id: number; body: string; createdAt: string }
export interface TimedRunCandidate {
  id: number; repository: string; path: string; event: string; createdAt: string;
  /** `pending` until the run's review job has started or been skipped. */
  review: 'started' | 'skipped' | 'pending';
}

/** Without a run-name, a run is attributed only when it is the sole review run
 * started near the trigger and no other /review on the pull request competes. */
export function correlateWorkflowRunByTime(repository: string, trigger: PullRequestComment, comments: PullRequestComment[], runs: TimedRunCandidate[], workflowPath = DEFAULT_WORKFLOW_REVIEW_CONTRACT.workflowPath) {
  const { start, end } = timedWindow(trigger.createdAt), within = (value: string) => { const at = Date.parse(value); return at >= start && at <= end; };
  const commentIds = [...new Set(comments.filter(comment => comment.id !== trigger.id && comment.body.startsWith('/review') && within(comment.createdAt)).map(comment => comment.id))];
  if (commentIds.length) return { status: 'ambiguous' as const, commentIds, reason: 'Another /review comment on this pull request was posted close to this request, so its workflow run cannot be told apart. No result was adopted.' };
  const candidates = [...new Map(runs.filter(run => run.repository === repository && run.path === workflowPath && run.event === 'issue_comment'
    && Number.isSafeInteger(run.id) && run.id > 0 && within(run.createdAt) && run.review !== 'skipped').map(run => [run.id, run])).values()];
  const started = candidates.filter(run => run.review === 'started'), pending = candidates.filter(run => run.review === 'pending');
  if (started.length > 1) return { status: 'ambiguous' as const, runIds: started.map(run => run.id), reason: 'More than one review run started close to this request. No result was adopted.' };
  if (pending.length) return { status: 'pending' as const, runIds: pending.map(run => run.id) };
  return started.length ? { status: 'matched' as const, run: started[0] } : { status: 'not-observed' as const };
}

export interface TriggerCommentCandidate {
  id: number; repository: string; prNumber: number; author: string; body: string; createdAt: string;
}

/** A timed-out POST is not safe to repeat, even when a subsequent read returns
 * no comment. Listing can lag; another client may have posted identical text.
 * Candidates aid explicit reconciliation, never automatic adoption or repost. */
export function reconcileUncertainWorkflowTrigger(request: {
  repository: string; prNumber: number; author: string; attemptedAt: string; knownCommentIds: number[];
}, comments: TriggerCommentCandidate[]) {
  const attempted = Date.parse(request.attemptedAt);
  if (!Number.isFinite(attempted)) throw new Error('The persisted attempt time is required');
  const known = new Set(request.knownCommentIds);
  // Provider timestamps have second precision; retain candidates from that second.
  const floor = Math.floor(attempted / 1000) * 1000;
  const candidates = comments.filter(comment => comment.repository === request.repository && comment.prNumber === request.prNumber
    && comment.author === request.author && comment.body === '/review' && !known.has(comment.id)
    && Number.isSafeInteger(comment.id) && comment.id > 0 && Date.parse(comment.createdAt) >= floor);
  return { status: 'needs-confirmation' as const, safeToRepost: false as const, commentIds: [...new Set(candidates.map(comment => comment.id))] };
}
