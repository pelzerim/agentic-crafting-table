import * as z from 'zod/v4';

/** Provider DTOs deliberately exclude tokens, arbitrary URL hosts and unknown API
 * fields. Markdown/patches are untrusted display content, never executable HTML. */
const text = z.string().max(200_000), short = z.string().max(1000);
const user = z.object({ login: short, type: short.optional() });
const ref = z.object({ ref: short, sha: z.string().regex(/^[a-f0-9]{40,64}$/i), repo: z.object({ full_name: short }).nullable() });
const pull = z.object({
  id: z.number().int().positive(), number: z.number().int().positive(), title: z.string().min(1).max(500), body: text.nullable(),
  state: z.enum(['open', 'closed']), draft: z.boolean().default(false), merged: z.boolean(),
  merge_commit_sha: z.string().regex(/^[a-f0-9]{40,64}$/i).nullable().optional(), merged_at: short.nullable().optional(), merged_by: user.nullable().optional(),
  user, head: ref, base: ref, updated_at: short, created_at: short,
  additions: z.number().int().nonnegative(), deletions: z.number().int().nonnegative(), changed_files: z.number().int().nonnegative(),
  assignees: z.array(user).default([]), requested_reviewers: z.array(user).default([]),
  labels: z.array(z.object({ name: short, color: z.string().regex(/^[a-f0-9]{6}$/i) })).default([]),
});
const file = z.object({ filename: short, previous_filename: short.optional(), status: short,
  additions: z.number().int().nonnegative(), deletions: z.number().int().nonnegative(), changes: z.number().int().nonnegative(), patch: text.optional() });
const comment = z.object({ id: z.number().int().positive(), body: text, user: user.nullable(), created_at: short, updated_at: short, path: short.optional(), line: z.number().int().positive().nullable().optional(), original_line: z.number().int().positive().nullable().optional(), in_reply_to_id: z.number().int().positive().optional() });
const review = z.object({ id: z.number().int().positive(), body: text.nullable(), user: user.nullable(), state: short, submitted_at: short.nullable(), commit_id: short.nullable() });
const mergeCommit = z.object({ data: z.object({ repository: z.object({ pullRequest: z.object({ mergeCommit: z.object({ oid: z.string().regex(/^[a-f0-9]{40,64}$/i) }).nullable() }) }) }) });
const mergeQueue = z.object({ data: z.object({ repository: z.object({ pullRequest: z.object({ isInMergeQueue: z.boolean(),
  mergeQueueEntry: z.object({ position: z.number().int().nonnegative() }).nullable(), headRefOid: z.unknown().optional(), commits: z.unknown().optional() }) }) }) });
const checkContext = z.union([z.object({ __typename: z.literal('CheckRun'), name: short, status: short, conclusion: short.nullable(), isRequired: z.boolean() }),
  z.object({ __typename: z.literal('StatusContext'), context: short, state: short, isRequired: z.boolean() })]).nullable();
const headChecks = z.object({ headRefOid: z.string().regex(/^[a-f0-9]{40,64}$/i), commits: z.object({ nodes: z.array(z.object({ commit: z.object({ oid: z.string(),
  statusCheckRollup: z.object({ contexts: z.object({ nodes: z.array(z.unknown()).max(100) }) }).nullable() }) }).nullable()).max(1) }) });
const FAILED_RUN = ['FAILURE', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE'], FAILED_STATUS = ['FAILURE', 'ERROR'];
/** Failing checks of the head commit. Required checks decide when the branch has any;
 * otherwise every check counts. Cancelled, skipped and pending checks never fail. */
function failingChecks(pullRequest: unknown): PullChecks | undefined {
  const parsed = headChecks.safeParse(pullRequest), commit = parsed.data?.commits.nodes[0]?.commit;
  if (!parsed.success || !commit || commit.oid.toLowerCase() !== parsed.data.headRefOid.toLowerCase()) return undefined;
  const contexts = (commit.statusCheckRollup?.contexts.nodes ?? []).flatMap(node => { const context = checkContext.safeParse(node); return context.success && context.data ? [context.data] : []; });
  const required = contexts.some(context => context.isRequired);
  const failing = contexts.filter(context => (!required || context.isRequired) && (context.__typename === 'CheckRun' ? context.status === 'COMPLETED' && FAILED_RUN.includes(context.conclusion ?? '') : FAILED_STATUS.includes(context.state)));
  return { head: parsed.data.headRefOid.toLowerCase(), failing: failing.map(context => context.__typename === 'CheckRun' ? context.name : context.context) };
}
const oid = z.string().regex(/^[a-f0-9]{40,64}$/i), nodeId = z.string().regex(/^[A-Za-z0-9_=-]{1,200}$/), mergeMethod = z.enum(['MERGE', 'SQUASH', 'REBASE']);
const mergeState = z.object({ data: z.object({ repository: z.object({ mergeCommitAllowed: z.boolean(), squashMergeAllowed: z.boolean(), rebaseMergeAllowed: z.boolean(), viewerDefaultMergeMethod: mergeMethod,
  pullRequest: z.object({ id: nodeId, number: z.number().int().positive(), title: z.string().min(1).max(500), state: z.enum(['OPEN', 'CLOSED', 'MERGED']), isDraft: z.boolean(), merged: z.boolean(), headRefOid: oid, baseRefName: short,
    mergeStateStatus: z.enum(['BEHIND', 'BLOCKED', 'CLEAN', 'DIRTY', 'DRAFT', 'HAS_HOOKS', 'UNKNOWN', 'UNSTABLE']), isMergeQueueEnabled: z.boolean(), isInMergeQueue: z.boolean(),
    reviewDecision: z.enum(['APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED']).nullable().optional(),
    commits: z.object({ nodes: z.array(z.object({ commit: z.object({ oid, statusCheckRollup: z.object({ state: short }).nullable() }) }).nullable()).max(1) }).optional() }) }) }) });
const mergeResult = z.object({ data: z.object({ mergePullRequest: z.object({ pullRequest: z.object({ id: nodeId, merged: z.boolean() }) }) }) });
const enqueueResult = z.object({ data: z.object({ enqueuePullRequest: z.object({ mergeQueueEntry: z.object({ position: z.number().int().nonnegative(), pullRequest: z.object({ id: nodeId }).nullable() }) }) }) });
const graphError = z.object({ errors: z.array(z.object({ message: z.string().max(10_000).optional(), type: z.string().max(100).optional() })).min(1).max(100) });
export type PullMergeState = z.infer<typeof mergeState>['data']['repository'];
export type PullMergeMethod = z.infer<typeof mergeMethod> | 'QUEUE';
export interface PullMergeRequest { pullRequestId: string; expectedHeadOid: string; method: PullMergeMethod }
export type PullLifecycle = 'open' | 'draft' | 'closed' | 'merged';
export type PullStateChange = 'ready' | 'draft' | 'close' | 'reopen';
/** `comment` is posted before a close. */
export interface PullStateRequest { pullRequestId: string; change: PullStateChange; comment?: string }
export function pullLifecycle(pull: Pick<PullMergeState['pullRequest'], 'state' | 'isDraft' | 'merged'>): PullLifecycle {
  return pull.merged || pull.state === 'MERGED' ? 'merged' : pull.state === 'CLOSED' ? 'closed' : pull.isDraft ? 'draft' : 'open';
}
/** What GitHub lets a PR in this lifecycle become; merged PRs cannot change. */
export function stateChanges(lifecycle: PullLifecycle): PullStateChange[] {
  return lifecycle === 'open' ? ['draft', 'close'] : lifecycle === 'draft' ? ['ready', 'close'] : lifecycle === 'closed' ? ['reopen'] : [];
}
const draftResult = (field: string) => z.object({ data: z.object({ [field]: z.object({ pullRequest: z.object({ id: nodeId, isDraft: z.boolean() }) }) }) });
const COMMENT_LIMIT = 60_000;
const workflowRun = z.object({ id: z.number().int().positive().safe(), name: short.nullable(), path: short.optional(), event: short, status: short, head_sha: z.string().regex(/^[a-f0-9]{40,64}$/i), created_at: short.optional() });
export type GitHubWorkflowRun = z.infer<typeof workflowRun>;
/** The PR inbox (like github.com/pulls/inbox): open PRs that involve you, by reason. */
export const INBOX_QUERIES = {
  review: 'is:open is:pr archived:false review-requested:@me',
  assigned: 'is:open is:pr archived:false assignee:@me',
  authored: 'is:open is:pr archived:false author:@me',
  mentioned: 'is:open is:pr archived:false mentions:@me',
} as const;
export type InboxReason = keyof typeof INBOX_QUERIES;
export const inboxPath = (reason: InboxReason) => `/search/issues?q=${encodeURIComponent(INBOX_QUERIES[reason])}&sort=updated&order=desc&per_page=50`;
export const INBOX_PATHS = new Set((Object.keys(INBOX_QUERIES) as InboxReason[]).map(inboxPath));
const searchItem = z.object({ number: z.number().int().positive(), title: z.string().min(1).max(500), html_url: z.string().url().max(2000),
  repository_url: z.string().regex(/^https:\/\/api\.github\.com\/repos\/[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9_.-]+$/), user: user.nullable(),
  updated_at: short, draft: z.boolean().default(false), comments: z.number().int().nonnegative().default(0), pull_request: z.object({}).passthrough().optional() });
export interface InboxPull { key: string; owner: string; repo: string; number: number; title: string; url: string; author: string; updatedAt: string; draft: boolean; comments: number; reasons: InboxReason[] }
/** PRs I authored or reviewed that changed between two local dates (STANDUP-01). Read only. */
export const ACTIVITY_REASONS = { author: 'authored', 'reviewed-by': 'reviewed' } as const;
export type ActivityQualifier = keyof typeof ACTIVITY_REASONS;
export function activityPath(qualifier: ActivityQualifier, from: string, to: string) {
  if (![from, to].every(date => /^\d{4}-\d{2}-\d{2}$/.test(date)) || !Object.hasOwn(ACTIVITY_REASONS, qualifier)) throw new GitHubError('GITHUB_INVALID_PATH', 'Use a valid date range for GitHub activity.');
  return `/search/issues?q=${encodeURIComponent(`is:pr ${qualifier}:@me updated:${from}..${to}`)}&sort=updated&order=desc&per_page=50`;
}
export const isActivityPath = (path: string) => /^\/search\/issues\?q=is%3Apr%20(?:author|reviewed-by)%3A%40me%20updated%3A\d{4}-\d{2}-\d{2}\.\.\d{4}-\d{2}-\d{2}&sort=updated&order=desc&per_page=50$/.test(path);
export interface ActivityPull extends Omit<InboxPull, 'reasons'> { reasons: (typeof ACTIVITY_REASONS)[ActivityQualifier][] }
const commit = z.object({ sha: z.string().regex(/^[a-f0-9]{40,64}$/i), commit: z.object({ message: text, author: z.object({ date: short }).nullable().optional(), committer: z.object({ date: short }).nullable().optional() }) });
const assignedIssue = z.object({ number: z.number().int().positive(), title: z.string().min(1).max(500), state: z.enum(['open', 'closed']),
  assignees: z.array(user), repository: z.object({ full_name: short }), pull_request: z.object({}).optional() });
export type GitHubPullRequest = z.infer<typeof pull>;
export type GitHubFile = z.infer<typeof file>;
export type GitHubComment = z.infer<typeof comment>;
export type GitHubReview = z.infer<typeof review>;
export interface PullIdentity { owner: string; repo: string; number: number }
export interface AssignedGitHubPull extends PullIdentity { title: string; assignees: string[]; state: 'open' | 'closed' }
export interface GitHubResponse { status: number; headers: Headers; body: unknown }
export interface PullChecks { head: string; failing: string[] }
/** The fixed queue read also carries the head commit's check rollup, when readable. */
export interface MergeQueueState { queued: boolean; position: number | null; checks?: PullChecks }
export interface GitHubTransport { postComment?(path: string, body: string, signal: AbortSignal): Promise<GitHubResponse>; get(path: string, signal: AbortSignal): Promise<GitHubResponse>; mergeCommit?(identity: PullIdentity, signal: AbortSignal): Promise<GitHubResponse>; mergeQueue?(identity: PullIdentity, signal: AbortSignal): Promise<GitHubResponse>;
  mergeOptions?(identity: PullIdentity, signal: AbortSignal): Promise<GitHubResponse>; merge?(request: PullMergeRequest, signal: AbortSignal): Promise<GitHubResponse>;
  setTitle?(identity: PullIdentity, title: string, signal: AbortSignal): Promise<GitHubResponse>;
  setState?(identity: PullIdentity, state: 'open' | 'closed', signal: AbortSignal): Promise<GitHubResponse>;
  setDraft?(pullRequestId: string, draft: boolean, signal: AbortSignal): Promise<GitHubResponse>;
  approveDeployments?(run: { owner: string; repo: string; runId: number }, environmentIds: number[], signal: AbortSignal): Promise<GitHubResponse> }
const METHOD_LABELS = { SQUASH: 'Squash and merge', MERGE: 'Create a merge commit', REBASE: 'Rebase and merge' } as const;
/** What a person may try for this PR: the prompt, warning about what GitHub reports,
 * and the methods it allows (a merge queue takes the place of direct merging).
 * GitHub decides; only an already merged PR is refused. */
export function mergeChoices(state: PullMergeState): { refusal: string } | { prompt: string; options: { id: PullMergeMethod; label: string }[] } {
  const pull = state.pullRequest, status = pull.mergeStateStatus;
  if (pull.merged || pull.state === 'MERGED') return { refusal: 'This pull request is already merged.' };
  const title = pull.title.length > 120 ? `${pull.title.slice(0, 119)}…` : pull.title, head = pull.headRefOid.slice(0, 7), base = pull.baseRefName.length > 100 ? `${pull.baseRefName.slice(0, 99)}…` : pull.baseRefName;
  const warnings = [pull.state === 'CLOSED' ? 'GitHub reports it is closed.' : pull.isDraft || status === 'DRAFT' ? 'GitHub reports it is a draft.' : '',
    pull.isInMergeQueue ? 'GitHub reports it is already in the merge queue.' : '',
    ({ DIRTY: 'GitHub reports merge conflicts.', BLOCKED: 'Required reviews or checks are not satisfied.', UNKNOWN: 'GitHub is still checking whether it can merge.', UNSTABLE: 'Some non-required checks are failing.',
      BEHIND: pull.isMergeQueueEnabled ? '' : `The branch is out of date with ${base}.` } as Partial<Record<typeof status, string>>)[status] ?? ''].filter(Boolean).map(warning => ` ${warning}`).join('');
  if (pull.isMergeQueueEnabled) return { prompt: `Add #${pull.number} “${title}” to the ${base} merge queue at ${head}?${warnings}`, options: [{ id: 'QUEUE', label: 'Add to merge queue' }] };
  const allowed = { SQUASH: state.squashMergeAllowed, MERGE: state.mergeCommitAllowed, REBASE: state.rebaseMergeAllowed }, any = !Object.values(allowed).some(Boolean);
  const methods = (['SQUASH', 'MERGE', 'REBASE'] as const).filter(method => any || allowed[method]).sort((a, b) => Number(b === state.viewerDefaultMergeMethod) - Number(a === state.viewerDefaultMergeMethod));
  return { prompt: `Merge #${pull.number} “${title}” into ${base} at ${head}?${warnings}`, options: methods.map(id => ({ id, label: METHOD_LABELS[id] })) };
}
export type HeadChecks = 'passing' | 'pending' | 'failing' | 'none';
export interface PullMergeReadiness { pullRequestId: string; number: number; title: string; lifecycle: PullLifecycle; head: string; base: string; mergeStateStatus: PullMergeState['pullRequest']['mergeStateStatus'];
  reviewDecision: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null; checks: HeadChecks; queued: boolean; queueEnabled: boolean; method: PullMergeMethod | null }
const ROLLUP: Record<string, HeadChecks> = { SUCCESS: 'passing', PENDING: 'pending', EXPECTED: 'pending', FAILURE: 'failing', ERROR: 'failing' };
/** What decides a merge nobody watches: GitHub's merge state, the review decision and the head commit's check rollup
 * (a rollup of another commit counts as pending), with the method a person's one-click merge would use. */
export function mergeReadiness(state: PullMergeState): PullMergeReadiness {
  const pull = state.pullRequest, commit = pull.commits?.nodes[0]?.commit, choices = mergeChoices(state);
  const checks: HeadChecks = !commit ? 'none' : commit.oid.toLowerCase() !== pull.headRefOid.toLowerCase() ? 'pending' : commit.statusCheckRollup ? ROLLUP[commit.statusCheckRollup.state] ?? 'pending' : 'none';
  return { pullRequestId: pull.id, number: pull.number, title: pull.title, lifecycle: pullLifecycle(pull), head: pull.headRefOid.toLowerCase(), base: pull.baseRefName, mergeStateStatus: pull.mergeStateStatus,
    reviewDecision: pull.reviewDecision ?? null, checks, queued: pull.isInMergeQueue, queueEnabled: pull.isMergeQueueEnabled, method: 'options' in choices ? choices.options[0]?.id ?? null : null };
}
/** A GraphQL reply whose every field is null with errors: GitHub refused, with its first error sanitized. */
function graphRejection(body: unknown): string | undefined {
  const value = body as { data?: unknown } | null, rejected = graphError.safeParse(value);
  if (!rejected.success || !(value?.data === null || value?.data === undefined || Object.values(value.data as object).every(field => field === null))) return undefined;
  return (rejected.data.errors[0].message ?? '').replace(/[^\x20-\x7E]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
}
const PERMISSION = 'This GitHub account doesn’t have permission to change this pull request. Check its repository access.';
/** Write replies: a 403 that is not a rate limit is a missing permission, not missing content. */
function checkedWrite(response: GitHubResponse, now: number) {
  if (response.status === 403 && !response.headers.get('retry-after') && response.headers.get('x-ratelimit-remaining') !== '0') throw new GitHubError('GITHUB_FORBIDDEN', PERMISSION);
  if (response.status >= 400 && response.status < 500) checkedGitHubResponse(response, now);
}
export class GitHubError extends Error {
  readonly code: string;
  readonly retryAt?: number;
  constructor(code: string, message: string, retryAt?: number) { super(message); this.code = code; this.retryAt = retryAt; }
}
export function pullKey(identity: PullIdentity) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(identity.owner) || !/^[A-Za-z0-9_.-]{1,100}$/.test(identity.repo) || ['.', '..'].includes(identity.repo) || !Number.isSafeInteger(identity.number) || identity.number < 1) throw new GitHubError('INVALID_PULL_REQUEST', 'Use a valid GitHub pull request URL.');
  return `${identity.owner.toLowerCase()}/${identity.repo.toLowerCase()}/pull/${identity.number}`;
}
export function checkedGitHubResponse(response: GitHubResponse, now: number) {
  if (response.status >= 200 && response.status < 300) return response.body;
  const remaining = response.headers.get('x-ratelimit-remaining'), retry = response.headers.get('retry-after');
  if (response.status === 429 || (response.status === 403 && (remaining === '0' || retry))) {
    const seconds = retry === null ? NaN : Number(retry), reset = Number(response.headers.get('x-ratelimit-reset'));
    const retryAt = Number.isFinite(seconds) && seconds >= 0 ? now + seconds * 1000 : reset > 0 ? reset * 1000 : now + 60_000;
    throw new GitHubError('GITHUB_RATE_LIMIT', 'GitHub rate limit reached. Try again after the limit resets.', retryAt);
  }
  if (response.status === 401) throw new GitHubError('GITHUB_AUTH', 'GitHub sign-in expired. Sign in again with GitHub CLI.');
  if (response.status === 403) throw new GitHubError('GITHUB_FORBIDDEN', 'This GitHub account cannot access the requested content. Check repository permissions and organization SSO.');
  if (response.status === 404) throw new GitHubError('GITHUB_NOT_FOUND', 'Pull request unavailable. Check its URL and this account’s repository access.');
  throw new GitHubError('GITHUB_UNAVAILABLE', 'GitHub could not load the requested content. Try again later.');
}
export class GitHubClient {
  private transport: GitHubTransport;
  private now: () => number;
  constructor(transport: GitHubTransport, now = Date.now) { this.transport = transport; this.now = now; }
  private async get<T>(path: string, schema: z.ZodType<T>, signal: AbortSignal) {
    signal.throwIfAborted();
    const response = await this.transport.get(path, signal); signal.throwIfAborted();
    const parsed = schema.safeParse(checkedGitHubResponse(response, this.now()));
    if (!parsed.success) throw new GitHubError('GITHUB_INVALID_RESPONSE', 'GitHub returned an unsupported response. No saved content was replaced.');
    return { value: parsed.data, headers: response.headers };
  }
  async viewer(signal: AbortSignal) { return (await this.get('/user', user.extend({ id: z.number().int().positive() }), signal)).value; }
  async pull(identity: PullIdentity, signal: AbortSignal): Promise<GitHubPullRequest> {
    pullKey(identity);
    const value = (await this.get(`/repos/${identity.owner}/${identity.repo}/pulls/${identity.number}`, pull, signal)).value;
    if (value.number !== identity.number) throw new GitHubError('GITHUB_INVALID_RESPONSE', 'GitHub returned a different pull request.');
    return value;
  }
  /** The commit a merged PR landed as, lower-cased; null when unmerged or the transport cannot read it. */
  async mergeCommit(identity: PullIdentity, signal: AbortSignal): Promise<string | null> {
    pullKey(identity);
    if (!this.transport.mergeCommit) return null;
    signal.throwIfAborted();
    const response = await this.transport.mergeCommit(identity, signal); signal.throwIfAborted();
    const parsed = mergeCommit.safeParse(checkedGitHubResponse(response, this.now()));
    if (!parsed.success) throw new GitHubError('GITHUB_INVALID_RESPONSE', 'GitHub returned an unsupported merge commit response.');
    return parsed.data.data.repository.pullRequest.mergeCommit?.oid.toLowerCase() ?? null;
  }
  /** Merge queue membership and head checks are GraphQL-only; null when the transport cannot read them. */
  async mergeQueue(identity: PullIdentity, signal: AbortSignal): Promise<MergeQueueState | null> {
    pullKey(identity);
    if (!this.transport.mergeQueue) return null;
    signal.throwIfAborted();
    const response = await this.transport.mergeQueue(identity, signal); signal.throwIfAborted();
    const parsed = mergeQueue.safeParse(checkedGitHubResponse(response, this.now()));
    if (!parsed.success) throw new GitHubError('GITHUB_INVALID_RESPONSE', 'GitHub returned an unsupported merge queue response. No saved content was replaced.');
    const { isInMergeQueue, mergeQueueEntry } = parsed.data.data.repository.pullRequest, checks = failingChecks(parsed.data.data.repository.pullRequest);
    return { queued: isInMergeQueue, position: isInMergeQueue ? mergeQueueEntry?.position ?? null : null, ...(checks ? { checks } : {}) };
  }
  /** Fixed GraphQL read of the merge facts GitHub enforces: state, head, queue and allowed methods. */
  async mergeState(identity: PullIdentity, signal: AbortSignal): Promise<PullMergeState> {
    pullKey(identity);
    if (!this.transport.mergeOptions) throw new GitHubError('GITHUB_FORBIDDEN', 'Merging is unavailable for this connection.');
    signal.throwIfAborted();
    const response = await this.transport.mergeOptions(identity, signal); signal.throwIfAborted();
    const parsed = mergeState.safeParse(checkedGitHubResponse(response, this.now()));
    if (!parsed.success || parsed.data.data.repository.pullRequest.number !== identity.number) throw new GitHubError('GITHUB_INVALID_RESPONSE', 'GitHub returned unsupported merge options. Try again later.');
    return parsed.data.data.repository;
  }
  /** Sends the single write and lets GitHub decide; `expectedHeadOid` makes GitHub
   * refuse a moved head. Never retried; a lost reply is outcome-unknown. */
  async merge(identity: PullIdentity, request: PullMergeRequest, signal: AbortSignal) {
    pullKey(identity);
    if (!this.transport.merge) throw new GitHubError('GITHUB_FORBIDDEN', 'Merging is unavailable for this connection.');
    signal.throwIfAborted();
    const queue = request.method === 'QUEUE', uncertain = () => Object.assign(new Error(`GitHub may have ${queue ? 'queued' : 'merged'} it. Check the PR before trying again.`), { outcomeUnknown: true });
    let response: GitHubResponse;
    try { response = await this.transport.merge({ pullRequestId: request.pullRequestId, expectedHeadOid: request.expectedHeadOid, method: request.method }, signal); }
    catch (error) { if ((error as GitHubError).code === 'GITHUB_POST_UNCERTAIN') throw uncertain(); throw error; }
    if (response.status >= 400 && response.status < 500) checkedGitHubResponse(response, this.now());
    if (response.status !== 200) throw uncertain();
    const body = response.body, detail = graphRejection(body);
    if (detail !== undefined) throw new GitHubError('GITHUB_REJECTED', `GitHub declined the ${queue ? 'merge queue request' : 'merge'}${detail ? `: ${detail}` : '.'}`);
    const merged = mergeResult.safeParse(body).data?.data.mergePullRequest.pullRequest, queued = enqueueResult.safeParse(body).data?.data.enqueuePullRequest.mergeQueueEntry;
    if (queue ? queued?.pullRequest?.id !== request.pullRequestId : merged?.id !== request.pullRequestId || !merged.merged) throw uncertain();
  }
  /** Sends one title PATCH and lets GitHub decide, never retried. A reply that does
   * not echo the new title is outcome-unknown. */
  async retitle(identity: PullIdentity, title: string, signal: AbortSignal) {
    pullKey(identity);
    if (!this.transport.setTitle) throw new GitHubError('GITHUB_FORBIDDEN', 'Renaming is unavailable for this connection.');
    if (!title.trim() || title.length > 256) throw new GitHubError('GITHUB_INVALID_TITLE', 'Pull request titles must be 1–256 characters.');
    signal.throwIfAborted();
    const uncertain = () => Object.assign(new Error('GitHub may have renamed it. Check the PR before trying again.'), { outcomeUnknown: true });
    let response: GitHubResponse;
    try { response = await this.transport.setTitle(identity, title, signal); }
    catch (error) { if ((error as GitHubError).code === 'GITHUB_POST_UNCERTAIN') throw uncertain(); throw error; }
    if (response.status === 422) throw new GitHubError('GITHUB_REJECTED', 'GitHub declined the new title.');
    if (response.status >= 400 && response.status < 500) checkedGitHubResponse(response, this.now());
    const renamed = response.status === 200 ? pull.safeParse(response.body).data : undefined;
    if (renamed?.number !== identity.number || renamed.title !== title) throw uncertain();
  }
  /** One new top-level comment on the PR's conversation, never retried. */
  async comment(identity: PullIdentity, body: string, signal: AbortSignal) {
    pullKey(identity);
    if (!body.trim() || body.length > COMMENT_LIMIT) throw new GitHubError('GITHUB_INVALID_COMMENT', 'Enter a comment of at most 60,000 characters.');
    if (!this.transport.postComment) throw new GitHubError('GITHUB_FORBIDDEN', 'Commenting is unavailable for this connection.');
    const uncertain = () => Object.assign(new Error('GitHub may have posted the comment. Check the PR before trying again.'), { outcomeUnknown: true });
    let response: GitHubResponse;
    try { response = await this.transport.postComment(`/repos/${identity.owner}/${identity.repo}/issues/${identity.number}/comments`, body, signal); }
    catch (error) { if ((error as GitHubError).code === 'GITHUB_POST_UNCERTAIN') throw uncertain(); throw error; }
    checkedWrite(response, this.now());
    const posted = comment.safeParse(response.body);
    if (response.status !== 201 || !posted.success || posted.data.body !== body) throw uncertain();
    return posted.data;
  }
  /** Close/reopen (REST) or draft/ready (GraphQL), sent without re-reading so GitHub
   * decides; a close posts its comment first. Never retried. */
  async changeState(identity: PullIdentity, request: PullStateRequest, signal: AbortSignal) {
    pullKey(identity);
    const rest = request.change === 'close' || request.change === 'reopen';
    if (rest ? !this.transport.setState : !this.transport.setDraft) throw new GitHubError('GITHUB_FORBIDDEN', 'Changing the pull request state is unavailable for this connection.');
    const text = request.change === 'close' && request.comment?.trim() ? request.comment : undefined;
    if (text !== undefined && text.length > COMMENT_LIMIT) throw new GitHubError('GITHUB_INVALID_COMMENT', 'Enter a comment of at most 60,000 characters.');
    signal.throwIfAborted();
    const verb = { close: 'close the pull request', reopen: 'reopen the pull request', ready: 'mark it ready for review', draft: 'convert it to a draft' }[request.change];
    const uncertain = () => Object.assign(new Error('GitHub may have changed it. Check the PR before trying again.'), { outcomeUnknown: true });
    if (text !== undefined) await this.comment(identity, text, signal);
    try {
      let response: GitHubResponse;
      try { response = rest ? await this.transport.setState!(identity, request.change === 'close' ? 'closed' : 'open', signal) : await this.transport.setDraft!(request.pullRequestId, request.change === 'draft', signal); }
      catch (error) { if ((error as GitHubError).code === 'GITHUB_POST_UNCERTAIN') throw uncertain(); throw error; }
      if (response.status === 422) throw new GitHubError('GITHUB_REJECTED', `GitHub declined to ${verb}.`);
      checkedWrite(response, this.now());
      if (response.status !== 200) throw uncertain();
      if (rest) {
        const changed = z.object({ number: z.number(), state: z.enum(['open', 'closed']) }).safeParse(response.body).data;
        if (changed?.number !== identity.number || changed.state !== (request.change === 'close' ? 'closed' : 'open')) throw uncertain();
        return;
      }
      const detail = graphRejection(response.body);
      if (detail !== undefined) throw new GitHubError('GITHUB_REJECTED', `GitHub declined to ${verb}${detail ? `: ${detail}` : '.'}`);
      const field = request.change === 'draft' ? 'convertPullRequestToDraft' : 'markPullRequestReadyForReview';
      const result = (draftResult(field).safeParse(response.body).data?.data as Record<string, { pullRequest: { id: string; isDraft: boolean } }> | undefined)?.[field]?.pullRequest;
      if (result?.id !== request.pullRequestId || result.isDraft !== (request.change === 'draft')) throw uncertain();
    } catch (error) {
      if (text === undefined) throw error;
      throw Object.assign(new Error(`Your comment was posted, but GitHub did not close the pull request. ${(error as Error).message}`), { code: (error as GitHubError).code, ...((error as { outcomeUnknown?: boolean }).outcomeUnknown ? { outcomeUnknown: true } : {}) });
    }
  }
  /** Workflow runs started for one commit (the first 100; a merge rarely starts more). */
  async commitRuns(identity: PullIdentity, sha: string, signal: AbortSignal) {
    pullKey(identity);
    if (!/^[a-f0-9]{40,64}$/i.test(sha)) throw new GitHubError('GITHUB_INVALID_PATH', 'Invalid commit.');
    const runs = (await this.get(`/repos/${identity.owner}/${identity.repo}/actions/runs?head_sha=${sha}&per_page=100`, z.object({ workflow_runs: z.array(workflowRun).max(100) }), signal)).value.workflow_runs;
    return runs.filter(run => run.head_sha.toLowerCase() === sha.toLowerCase());
  }
  private async pages<T>(path: string, schema: z.ZodType<T>, signal: AbortSignal, maxPages: number) {
    const values: T[] = []; let bytes = 0;
    for (let page = 1; page <= maxPages; page++) {
      const response = await this.get(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`, z.array(schema).max(100), signal);
      bytes += Buffer.byteLength(JSON.stringify(response.value));
      if (bytes > 3 * 1024 * 1024) throw new GitHubError('GITHUB_CONTENT_LIMIT', 'This pull request exceeds the content limit. The response is incomplete and was not saved.');
      values.push(...response.value);
      // Never follow a provider-supplied URL: it could redirect authentication to
      // another host/path. The next page always belongs to this exact endpoint.
      if (!/(?:^|,)\s*<[^>]+>;\s*rel="next"/.test(response.headers.get('link') ?? '')) return values;
    }
    throw new GitHubError('GITHUB_CONTENT_LIMIT', 'This pull request exceeds the content limit. The response is incomplete and was not saved.');
  }
  async files(identity: PullIdentity, signal: AbortSignal) { pullKey(identity); return this.pages(`/repos/${identity.owner}/${identity.repo}/pulls/${identity.number}/files`, file, signal, 30); }
  async comments(identity: PullIdentity, signal: AbortSignal) { pullKey(identity); return this.pages(`/repos/${identity.owner}/${identity.repo}/issues/${identity.number}/comments`, comment, signal, 20); }
  async reviewComments(identity: PullIdentity, signal: AbortSignal) { pullKey(identity); return this.pages(`/repos/${identity.owner}/${identity.repo}/pulls/${identity.number}/comments`, comment, signal, 20); }
  async reviews(identity: PullIdentity, signal: AbortSignal) { pullKey(identity); return this.pages(`/repos/${identity.owner}/${identity.repo}/pulls/${identity.number}/reviews`, review, signal, 20); }
  async reply(identity: PullIdentity, kind: 'discussion' | 'inline' | 'review', id: number, body: string, signal: AbortSignal) {
    pullKey(identity);
    if (!Number.isSafeInteger(id) || id < 1 || !body.trim() || body.length > 60_000) throw new Error('Enter a reply of at most 60,000 characters.');
    if (!this.transport.postComment) throw new Error('Comment replies are unavailable for this connection.');
    const source = kind === 'inline' ? await this.reviewComments(identity, signal) : kind === 'review' ? await this.reviews(identity, signal) : await this.comments(identity, signal);
    const original = source.find(c => c.id === id);
    if (!original) throw new Error('This comment is no longer available on this pull request.');
    const rootId = 'in_reply_to_id' in original ? original.in_reply_to_id ?? id : id;
    const path = kind === 'inline' ? `/repos/${identity.owner}/${identity.repo}/pulls/${identity.number}/comments/${rootId}/replies` : `/repos/${identity.owner}/${identity.repo}/issues/${identity.number}/comments`;
    const content = kind === 'inline' ? body : `In reply to https://github.com/${identity.owner}/${identity.repo}/pull/${identity.number}#${kind === 'review' ? 'pullrequestreview-' : 'issuecomment-'}${id}\n\n${body}`;
    try {
      const response = await this.transport.postComment(path, content, signal);
      if (response.status >= 400 && response.status < 500) checkedGitHubResponse(response, this.now());
      const parsed = comment.safeParse(response.body);
      if (response.status !== 201 || !parsed.success || parsed.data.body !== content) throw Object.assign(new Error('GitHub may have accepted the reply. Check the PR before sending again.'), { outcomeUnknown: true });
      return parsed.data;
    } catch (error) {
      if ((error as GitHubError).code === 'GITHUB_POST_UNCERTAIN') Object.assign(error as Error, { outcomeUnknown: true });
      throw error;
    }
  }
  /** One page per reason, merged per PR; a failed reason fails the whole read. */
  async inbox(signal: AbortSignal): Promise<InboxPull[]> {
    const merged = new Map<string, InboxPull>();
    for (const reason of Object.keys(INBOX_QUERIES) as InboxReason[]) {
      const { value } = await this.get(inboxPath(reason), z.object({ items: z.array(searchItem).max(50) }), signal);
      for (const item of value.items) {
        if (!item.pull_request) continue;
        const [owner, repo] = item.repository_url.split('/').slice(-2), key = pullKey({ owner, repo, number: item.number });
        const entry = merged.get(key) ?? { key, owner, repo, number: item.number, title: item.title, url: `https://github.com/${owner}/${repo}/pull/${item.number}`, author: item.user?.login ?? 'ghost', updatedAt: item.updated_at, draft: item.draft, comments: item.comments, reasons: [] };
        if (!entry.reasons.includes(reason)) entry.reasons.push(reason);
        merged.set(key, entry);
      }
    }
    return [...merged.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  /** One search page per qualifier, merged per PR; a failed search fails the whole read. */
  async activity(from: string, to: string, signal: AbortSignal): Promise<ActivityPull[]> {
    const merged = new Map<string, ActivityPull>();
    for (const qualifier of Object.keys(ACTIVITY_REASONS) as ActivityQualifier[]) {
      const { value } = await this.get(activityPath(qualifier, from, to), z.object({ items: z.array(searchItem).max(50) }), signal);
      for (const item of value.items) {
        if (!item.pull_request) continue;
        const [owner, repo] = item.repository_url.split('/').slice(-2), key = pullKey({ owner, repo, number: item.number });
        const entry = merged.get(key) ?? { key, owner, repo, number: item.number, title: item.title, url: `https://github.com/${owner}/${repo}/pull/${item.number}`, author: item.user?.login ?? 'ghost', updatedAt: item.updated_at, draft: item.draft, comments: item.comments, reasons: [] };
        if (!entry.reasons.includes(ACTIVITY_REASONS[qualifier])) entry.reasons.push(ACTIVITY_REASONS[qualifier]);
        merged.set(key, entry);
      }
    }
    return [...merged.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  async commits(identity: PullIdentity, signal: AbortSignal) {
    pullKey(identity);
    return (await this.pages(`/repos/${identity.owner}/${identity.repo}/pulls/${identity.number}/commits`, commit, signal, 3))
      .map(entry => ({ sha: entry.sha, message: entry.commit.message, date: entry.commit.committer?.date ?? entry.commit.author?.date ?? '' }));
  }
  async assignedPulls(signal: AbortSignal): Promise<AssignedGitHubPull[]> {
    const issues = await this.pages('/issues?filter=assigned&state=open&sort=created&direction=asc', assignedIssue, signal, 20);
    return issues.filter(issue => issue.pull_request !== undefined).map(issue => {
      const parts = issue.repository.full_name.split('/');
      if (parts.length !== 2) throw new GitHubError('GITHUB_INVALID_RESPONSE', 'GitHub returned an invalid repository identity.');
      const identity = { owner: parts[0], repo: parts[1], number: issue.number }; pullKey(identity);
      return { ...identity, title: issue.title, state: issue.state, assignees: issue.assignees.map(user => user.login) };
    });
  }
}
