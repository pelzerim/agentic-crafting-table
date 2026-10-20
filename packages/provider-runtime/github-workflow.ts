import * as z from 'zod/v4';
import { load, JSON_SCHEMA } from 'js-yaml';
import { GitHubClient, GitHubError, checkedGitHubResponse, pullKey } from './github.ts';
import type { GitHubTransport, GitHubResponse, PullIdentity } from './github.ts';
import { correlateWorkflowRun, correlateWorkflowRunByTime, reconcileUncertainWorkflowTrigger, timedWindow } from '../../src/pull-requests/workflow-correlation.ts';
import { observeWorkflowReview } from '../../src/pull-requests/reviews.ts';
import { DEFAULT_WORKFLOW_REVIEW_CONTRACT, workflowFileName } from '../../src/pull-requests/workflow-contract.ts';
import type { WorkflowReviewContract } from '../../src/pull-requests/workflow-contract.ts';

export const WORKFLOW_RUN_NAME = "${{ github.event_name == 'issue_comment' && format('ACT review comment {0}', github.event.comment.id) || 'Claude Code' }}";
export interface WorkflowTransport extends GitHubTransport {
  /** Exactly one request. Only the coordinator may invoke this after journalling intent. */
  postReview(identity: PullIdentity, signal: AbortSignal): Promise<GitHubResponse>;
}
const id = z.number().int().positive().safe(), short = z.string().max(1000);
const comment = z.object({ id, body: z.string().max(200_000), user: z.object({ login: short }).nullable(), created_at: short });
const run = z.object({ id, workflow_id: id, path: short, event: short, display_title: short, created_at: short, run_attempt: id,
  status: short, conclusion: short.nullable(), repository: z.object({ full_name: short }) });
const job = z.object({ id, run_id: id, name: short, status: z.enum(['queued', 'in_progress', 'completed', 'waiting', 'pending', 'requested']), conclusion: short.nullable() });
/** `exact` correlates through the trigger-comment run-name; `timed` by the run start time around the trigger comment. */
export type WorkflowTracking = 'exact' | 'timed';
export type WorkflowContract = { tracking: WorkflowTracking; reason?: undefined } | { tracking?: undefined; reason: string };
export type WorkflowCapability = { supported: boolean; tracking?: WorkflowTracking; reason?: string; workflowSha?: string; workflowId?: number };
export interface WorkflowCandidate { id: number; author: string; createdAt: string; body: string }
export interface WorkflowPreflight { author: string; knownCommentIds: number[]; workflowSha: string; workflowId: number; tracking: WorkflowTracking }
export interface WorkflowProgress {
  status: 'not-observed' | 'ambiguous' | 'queued' | 'running' | 'awaiting-result' | 'complete' | 'failed' | 'cancelled' | 'timed-out';
  runId?: number; jobId?: number; resultCommentId?: number; runUrl?: string; runsUrl?: string; resultUrl?: string; report?: string; reason?: string;
}

function commentTrigger(on: unknown) {
  if (on === 'issue_comment') return true;
  if (Array.isArray(on)) return on.includes('issue_comment');
  if (!on || typeof on !== 'object' || !Object.hasOwn(on, 'issue_comment')) return false;
  const event = (on as Record<string, unknown>).issue_comment;
  if (event === null) return true;
  if (typeof event !== 'object' || Array.isArray(event)) return false;
  const types = (event as Record<string, unknown>).types;
  return types === undefined || types === 'created' || (Array.isArray(types) && types.includes('created'));
}
/** The jobs API reports a job by its `name`, or by its key when unnamed. */
function reviewJobs(jobs: unknown, jobName: string) {
  if (!jobs || typeof jobs !== 'object' || Array.isArray(jobs)) return 0;
  return Object.entries(jobs as Record<string, any>).filter(([key, job]) => !!job && typeof job === 'object'
    && (job.name === jobName || (key === jobName && job.name === undefined))
    && Array.isArray(job.steps) && job.steps.length > 0).length;
}
/** Parse actual YAML; comments, strings, duplicate keys and lookalike expressions
 * must not accidentally enable a write. This is a correlation capability, not
 * evidence that the external workflow has passed its supervised live test. */
export function workflowContract(source: string, contract: WorkflowReviewContract = DEFAULT_WORKFLOW_REVIEW_CONTRACT): WorkflowContract {
  const named = `The review workflow ${contract.workflowPath}`;
  if (Buffer.byteLength(source) > 256 * 1024) return { reason: `${named} is too large to verify.` };
  let value: unknown;
  try { value = load(source, { schema: JSON_SCHEMA }); } catch { return { reason: `${named} is not valid YAML.` }; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { reason: `${named} is not a workflow definition.` };
  const workflow = value as Record<string, unknown>;
  if (!commentTrigger(workflow.on)) return { reason: `${named} must run on new pull request comments (on.issue_comment with type created) before /review can be tracked.` };
  if (reviewJobs(workflow.jobs, contract.jobName) !== 1) return { reason: `${named} needs exactly one ${contract.jobName} job with steps before /review can be tracked.` };
  const runName = typeof workflow['run-name'] === 'string' ? workflow['run-name'].replace(/\s+/g, ' ').trim() : undefined;
  return { tracking: runName === WORKFLOW_RUN_NAME ? 'exact' : 'timed' };
}
type Pinned = { runId?: number; jobId?: number; resultCommentId?: number };
/** Between polls a pinned watch keeps its last known progress, but the deadline always wins. */
const unobserved = (pinned: Pinned | undefined, deadlineReached: boolean): WorkflowProgress => deadlineReached ? { ...pinned, status: 'timed-out' } : { status: 'not-observed', ...pinned };
export class GitHubWorkflowClient {
  private reader: GitHubClient;
  private transport: WorkflowTransport;
  private now: () => number;
  private contract: WorkflowReviewContract;
  constructor(transport: WorkflowTransport, now = Date.now, contract: WorkflowReviewContract = DEFAULT_WORKFLOW_REVIEW_CONTRACT) { this.transport = transport; this.now = now; this.contract = contract; this.reader = new GitHubClient(transport, now); }
  private async get<T>(path: string, schema: z.ZodType<T>, signal: AbortSignal) {
    signal.throwIfAborted(); const response = await this.transport.get(path, signal); signal.throwIfAborted();
    const result = schema.safeParse(checkedGitHubResponse(response, this.now()));
    if (!result.success) throw new GitHubError('GITHUB_INVALID_RESPONSE', 'GitHub returned unsupported workflow metadata.');
    return { value: result.data, headers: response.headers };
  }
  private path(identity: PullIdentity) { pullKey(identity); return `/repos/${identity.owner}/${identity.repo}`; }
  async capability(identity: PullIdentity, signal: AbortSignal): Promise<WorkflowCapability> {
    const path = this.path(identity);
    try {
      const [{ value: contents }, { value: workflow }] = await Promise.all([
        this.get(`${path}/contents/${this.contract.workflowPath}`, z.object({ type: z.literal('file'), encoding: z.literal('base64'), sha: z.string().regex(/^[a-f\d]{40,64}$/i), content: z.string().max(400_000) }), signal),
        this.get(`${path}/actions/workflows/${workflowFileName(this.contract)}`, z.object({ id, path: short, state: short }), signal),
      ]);
      if (workflow.state !== 'active' || workflow.path !== this.contract.workflowPath) return { supported: false, reason: `The review workflow ${this.contract.workflowPath} is not active.` };
      const contract = workflowContract(Buffer.from(contents.content, 'base64').toString('utf8'), this.contract);
      return contract.tracking ? { supported: true, tracking: contract.tracking, workflowSha: contents.sha, workflowId: workflow.id }
        : { supported: false, reason: contract.reason, workflowSha: contents.sha, workflowId: workflow.id };
    } catch (error) {
      if (error instanceof GitHubError && error.code === 'GITHUB_NOT_FOUND') return { supported: false, reason: `The review workflow ${this.contract.workflowPath} is unavailable in this repository.` };
      throw error;
    }
  }
  async preflight(identity: PullIdentity, signal: AbortSignal): Promise<WorkflowPreflight> {
    const capability = await this.capability(identity, signal);
    if (!capability.supported) throw new GitHubError('WORKFLOW_UNSUPPORTED', capability.reason!);
    const [viewer, comments, pull] = await Promise.all([this.reader.viewer(signal), this.comments(identity, signal), this.reader.pull(identity, signal)]);
    if (pull.state !== 'open') throw new GitHubError('WORKFLOW_UNSUPPORTED', 'Open a current pull request before requesting a workflow review.');
    return { author: viewer.login, knownCommentIds: comments.map(comment => comment.id), workflowSha: capability.workflowSha!, workflowId: capability.workflowId!, tracking: capability.tracking! };
  }
  async post(identity: PullIdentity, author: string, signal: AbortSignal) {
    this.path(identity); signal.throwIfAborted();
    const response = await this.transport.postReview(identity, signal);
    // A malformed/5xx reply can follow an accepted write. Never turn it into a
    // safe retry. A definite 4xx rejection still surfaces as an explicit failure.
    if (response.status >= 400 && response.status < 500) checkedGitHubResponse(response, this.now());
    const value = comment.safeParse(response.body);
    if (response.status !== 201 || !value.success || value.data.body !== '/review' || value.data.user?.login !== author) {
      throw new GitHubError('GITHUB_POST_UNCERTAIN', 'GitHub may have accepted the /review comment. Reconcile its identity before continuing; do not post again.');
    }
    return value.data.id;
  }
  async comments(identity: PullIdentity, signal: AbortSignal) { return this.reader.comments(identity, signal); }
  async candidates(identity: PullIdentity, preflight: WorkflowPreflight, attemptedAt: string, signal: AbortSignal) {
    return (await this.candidateDetails(identity, preflight, attemptedAt, signal)).map(candidate => candidate.id);
  }
  async candidateDetails(identity: PullIdentity, preflight: WorkflowPreflight, attemptedAt: string, signal: AbortSignal): Promise<WorkflowCandidate[]> {
    const repository = `${identity.owner}/${identity.repo}`;
    const comments = (await this.comments(identity, signal)).map(c => ({ id: c.id, body: c.body, author: c.user?.login ?? '', createdAt: c.created_at, repository, prNumber: identity.number }));
    const eligible = new Set(reconcileUncertainWorkflowTrigger({ repository, prNumber: identity.number, ...preflight, attemptedAt }, comments).commentIds);
    return comments.filter(c => eligible.has(c.id)).map(({ id, author, createdAt, body }) => ({ id, author, createdAt, body }));
  }
  private async pages<T>(path: string, key: string, schema: z.ZodType<T>, signal: AbortSignal) {
    const values: T[] = []; let bytes = 0;
    for (let page = 1; page <= 10; page++) {
      const response = await this.get(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`, z.object({ [key]: z.array(schema).max(100) }), signal);
      bytes += Buffer.byteLength(JSON.stringify(response.value));
      if (bytes > 3 * 1024 * 1024) throw new GitHubError('GITHUB_CONTENT_LIMIT', 'Workflow history exceeds the bounded read limit.');
      values.push(...response.value[key]);
      if (!/(?:^|,)\s*<[^>]+>;\s*rel="next"/.test(response.headers.get('link') ?? '')) return values;
    }
    throw new GitHubError('GITHUB_CONTENT_LIMIT', 'Workflow history is incomplete. Narrow the request before retrying.');
  }
  async observe(identity: PullIdentity, triggerId: number, attemptedAt: string, signal: AbortSignal, pinned?: Pinned, deadlineReached = false, workflowId?: number, tracking: WorkflowTracking = 'exact'): Promise<WorkflowProgress> {
    if (tracking === 'timed') return this.observeTimed(identity, triggerId, signal, pinned, deadlineReached, workflowId);
    const path = this.path(identity), repository = `${identity.owner}/${identity.repo}`;
    const since = new Date(Math.floor(Date.parse(attemptedAt) / 1000) * 1000).toISOString();
    const runs = await this.pages(`${path}/actions/workflows/${workflowId ?? workflowFileName(this.contract)}/runs?event=issue_comment&created=${encodeURIComponent(`>=${since}`)}`, 'workflow_runs', run, signal);
    const match = correlateWorkflowRun(repository.toLowerCase(), triggerId, runs.map(r => ({ id: r.id, repository: r.repository.full_name.toLowerCase(), path: r.path.split('@')[0], event: r.event, displayTitle: r.display_title })), this.contract.workflowPath);
    if (match.status === 'ambiguous') return { status: 'ambiguous', reason: 'More than one workflow run matches the trigger. No result was adopted.' };
    if (match.status === 'not-observed') return unobserved(pinned, deadlineReached);
    const current = runs.find(r => r.id === match.run.id)!;
    if ((workflowId && current.workflow_id !== workflowId) || (pinned?.runId && pinned.runId !== current.id) || current.run_attempt !== 1) return { status: 'ambiguous', reason: 'The workflow was replaced or rerun. Its report cannot be attributed to this original request safely.' };
    const jobs = await this.pages(`${path}/actions/runs/${current.id}/attempts/1/jobs`, 'jobs', job, signal);
    return this.track(identity, current, jobs, triggerId, signal, pinned, deadlineReached);
  }
  private async observeTimed(identity: PullIdentity, triggerId: number, signal: AbortSignal, pinned: Pinned | undefined, deadlineReached: boolean, workflowId?: number): Promise<WorkflowProgress> {
    const path = this.path(identity), repository = `${identity.owner}/${identity.repo}`, runsUrl = `https://github.com/${repository}/actions/workflows/${workflowFileName(this.contract)}`;
    const comments = await this.comments(identity, signal), trigger = comments.find(c => c.id === triggerId);
    if (!trigger) return unobserved(pinned, deadlineReached);
    const window = timedWindow(trigger.created_at), second = (at: number, round: (value: number) => number) => new Date(round(at / 1000) * 1000).toISOString();
    const range = `${second(window.start, Math.floor)}..${second(window.end, Math.ceil)}`;
    const runs = await this.pages(`${path}/actions/workflows/${workflowId ?? workflowFileName(this.contract)}/runs?event=issue_comment&created=${encodeURIComponent(range)}`, 'workflow_runs', run, signal);
    const nearby = [...new Map(runs.filter(r => r.repository.full_name.toLowerCase() === repository.toLowerCase() && r.path.split('@')[0] === this.contract.workflowPath && r.event === 'issue_comment'
      && Date.parse(r.created_at) >= window.start && Date.parse(r.created_at) <= window.end).map(r => [r.id, r])).values()];
    if (nearby.length > 20) return { status: 'ambiguous', runsUrl, reason: 'Too many workflow runs started close to this request to attribute one safely. No result was adopted.' };
    const jobsByRun = new Map(await Promise.all(nearby.map(async r => [r.id, (await this.pages(`${path}/actions/runs/${r.id}/attempts/1/jobs`, 'jobs', job, signal)).filter(j => j.run_id === r.id)] as const)));
    const review = (candidate: z.infer<typeof run>) => {
      const own = jobsByRun.get(candidate.id)!.filter(j => j.name === this.contract.jobName);
      if (own.some(j => j.status === 'in_progress' || (j.status === 'completed' && j.conclusion !== 'skipped'))) return 'started' as const;
      return (own.length ? own.every(j => j.status === 'completed') : candidate.status === 'completed') ? 'skipped' as const : 'pending' as const;
    };
    const match = correlateWorkflowRunByTime(repository.toLowerCase(), { id: trigger.id, body: trigger.body, createdAt: trigger.created_at },
      comments.map(c => ({ id: c.id, body: c.body, createdAt: c.created_at })),
      nearby.map(r => ({ id: r.id, repository: r.repository.full_name.toLowerCase(), path: r.path.split('@')[0], event: r.event, createdAt: r.created_at, review: review(r) })), this.contract.workflowPath);
    if (match.status === 'ambiguous') return { status: 'ambiguous', runsUrl, reason: match.reason };
    if (match.status !== 'matched') return unobserved(pinned, deadlineReached);
    const current = nearby.find(r => r.id === match.run.id)!;
    if ((workflowId && current.workflow_id !== workflowId) || (pinned?.runId && pinned.runId !== current.id) || current.run_attempt !== 1) return { status: 'ambiguous', runsUrl, reason: 'The workflow was replaced or rerun. Its report cannot be attributed to this original request safely.' };
    const after = Date.parse(trigger.created_at);
    const progress = await this.track(identity, current, jobsByRun.get(current.id)!, triggerId, signal, pinned, deadlineReached, comments.filter(c => Date.parse(c.created_at) >= after));
    return progress.status === 'complete' && this.now() < window.end ? { ...progress, status: 'awaiting-result', report: undefined } : progress;
  }
  private async track(identity: PullIdentity, current: z.infer<typeof run>, jobs: z.infer<typeof job>[], triggerId: number, signal: AbortSignal, pinned: Pinned | undefined, deadlineReached: boolean, comments?: Awaited<ReturnType<GitHubWorkflowClient['comments']>>): Promise<WorkflowProgress> {
    const repository = `${identity.owner}/${identity.repo}`, runUrl = `https://github.com/${repository}/actions/runs/${current.id}`;
    const matches = [...new Map(jobs.filter(j => j.run_id === current.id && j.name === this.contract.jobName).map(j => [j.id, j])).values()];
    if (matches.length > 1 || (matches[0] && pinned?.jobId && pinned.jobId !== matches[0].id)) return { status: 'ambiguous', runId: current.id, runUrl, reason: 'Multiple or changed review jobs were observed.' };
    const reviewJob = matches[0];
    if (!reviewJob) return { status: current.status === 'completed' ? current.conclusion === 'cancelled' ? 'cancelled' : 'failed' : deadlineReached ? 'timed-out' : 'queued', runId: current.id, runUrl, reason: current.status === 'completed' ? 'The workflow finished without a review job.' : undefined };
    const reports = (comments ?? await this.comments(identity, signal)).filter(c => c.user?.login === 'github-actions[bot]' && c.body.includes(`](${runUrl})`));
    const unique = [...new Map(reports.map(c => [c.id, c])).values()];
    if (unique.length > 1 || (unique[0] && pinned?.resultCommentId && pinned.resultCommentId !== unique[0].id)) return { status: 'ambiguous', runId: current.id, jobId: reviewJob.id, runUrl, reason: 'Multiple or changed result comments were observed.' };
    const result = unique[0];
    const observed = observeWorkflowReview({ repository, prNumber: identity.number, triggerCommentId: triggerId, runId: current.id, resultCommentId: result?.id ?? pinned?.resultCommentId ?? 0 }, {
      runId: current.id, repository, workflowPath: this.contract.workflowPath, event: 'issue_comment', jobName: this.contract.jobName,
      jobStatus: reviewJob.status === 'completed' ? 'completed' : reviewJob.status === 'in_progress' ? 'in_progress' : 'queued', jobConclusion: reviewJob.conclusion,
      comment: result ? { id: result.id, prNumber: identity.number, author: result.user!.login, body: result.body } : undefined,
    }, deadlineReached, this.contract);
    return { ...observed, runId: current.id, jobId: reviewJob.id, resultCommentId: result?.id ?? pinned?.resultCommentId };
  }
}
