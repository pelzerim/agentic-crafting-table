import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { sessionPath } from '../session-runtime/shell-path.ts';
import { GitHubError, INBOX_PATHS, isActivityPath } from './github.ts';
import { pullKey } from './github.ts';
import type { WorkflowTransport } from './github-workflow.ts';
import { requestBudget, validators } from './request-budget.ts';
import type { RequestBudget } from './request-budget.ts';
import type { GitHubTransport, PullIdentity, PullMergeRequest } from './github.ts';

/** REST pull requests no longer carry `merge_commit_sha` from API version 2026-03-10; GraphQL still reports it. */
const MERGE_COMMIT_QUERY = 'query PullRequestMergeCommit($owner: String!, $repo: String!, $number: Int!) { repository(owner: $owner, name: $repo) { pullRequest(number: $number) { mergeCommit { oid } } } }';
const MERGE_QUEUE_QUERY = 'query MergeQueueState($owner: String!, $repo: String!, $number: Int!) { repository(owner: $owner, name: $repo) { pullRequest(number: $number) { isInMergeQueue mergeQueueEntry { position } headRefOid commits(last: 1) { nodes { commit { oid statusCheckRollup { contexts(first: 100) { nodes { __typename ... on CheckRun { name status conclusion isRequired(pullRequestNumber: $number) } ... on StatusContext { context state isRequired(pullRequestNumber: $number) } } } } } } } } } }';
export const MERGE_OPTIONS_QUERY = 'query PullRequestMergeOptions($owner: String!, $repo: String!, $number: Int!) { repository(owner: $owner, name: $repo) { mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed viewerDefaultMergeMethod pullRequest(number: $number) { id number title state isDraft merged headRefOid baseRefName mergeStateStatus isMergeQueueEnabled isInMergeQueue reviewDecision commits(last: 1) { nodes { commit { oid statusCheckRollup { state } } } } } } }';
export const MERGE_MUTATION = 'mutation MergePullRequest($pullRequestId: ID!, $mergeMethod: PullRequestMergeMethod!, $expectedHeadOid: GitObjectID!) { mergePullRequest(input: { pullRequestId: $pullRequestId, mergeMethod: $mergeMethod, expectedHeadOid: $expectedHeadOid }) { pullRequest { id merged } } }';
export const ENQUEUE_MUTATION = 'mutation EnqueuePullRequest($pullRequestId: ID!, $expectedHeadOid: GitObjectID!) { enqueuePullRequest(input: { pullRequestId: $pullRequestId, expectedHeadOid: $expectedHeadOid }) { mergeQueueEntry { position pullRequest { id } } } }';
export const READY_MUTATION = 'mutation MarkPullRequestReady($pullRequestId: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $pullRequestId }) { pullRequest { id isDraft } } }';
export const DRAFT_MUTATION = 'mutation ConvertPullRequestToDraft($pullRequestId: ID!) { convertPullRequestToDraft(input: { pullRequestId: $pullRequestId }) { pullRequest { id isDraft } } }';
const NODE_ID = /^[A-Za-z0-9_=-]{1,200}$/, OID = /^[a-f0-9]{40,64}$/i;
/** Exactly the merge and draft/ready GraphQL documents this app sends, with their variables' shapes. */
export function mergeDocument(payload: object): 'read' | 'write' | undefined {
  const { query, variables, ...extra } = payload as { query?: unknown; variables?: Record<string, unknown> };
  if (Object.keys(extra).length || !variables || typeof variables !== 'object' || Array.isArray(variables)) return;
  const keys = Object.keys(variables).sort().join();
  if (query === MERGE_OPTIONS_QUERY && keys === 'number,owner,repo') {
    try { pullKey({ owner: String(variables.owner), repo: String(variables.repo), number: variables.number as number }); } catch { return; }
    return typeof variables.owner === 'string' && typeof variables.repo === 'string' ? 'read' : undefined;
  }
  const ids = typeof variables.pullRequestId === 'string' && NODE_ID.test(variables.pullRequestId) && typeof variables.expectedHeadOid === 'string' && OID.test(variables.expectedHeadOid);
  if (query === MERGE_MUTATION && keys === 'expectedHeadOid,mergeMethod,pullRequestId' && ids && ['MERGE', 'SQUASH', 'REBASE'].includes(variables.mergeMethod as string)) return 'write';
  if (query === ENQUEUE_MUTATION && keys === 'expectedHeadOid,pullRequestId' && ids) return 'write';
  if ((query === READY_MUTATION || query === DRAFT_MUTATION) && keys === 'pullRequestId' && typeof variables.pullRequestId === 'string' && NODE_ID.test(variables.pullRequestId)) return 'write';
}
/** The only PATCH: one pull request's title, with exactly { title } within GitHub's 256-character limit. */
export function titleUpdate(path: string, payload: object) {
  const { title, ...extra } = payload as { title?: unknown };
  return /^\/repos\/[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9_.-]+\/pulls\/[1-9]\d*$/.test(path) && !path.split('/').some(part => part === '.' || part === '..') && !Object.keys(extra).length
    && typeof title === 'string' && Boolean(title.trim()) && title.length <= 256;
}
/** The other PATCH: one pull request's state, with exactly { state: "open" | "closed" }. */
export function stateUpdate(path: string, payload: object) {
  const { state, ...extra } = payload as { state?: unknown };
  return /^\/repos\/[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9_.-]+\/pulls\/[1-9]\d*$/.test(path) && !path.split('/').some(part => part === '.' || part === '..') && !Object.keys(extra).length
    && (state === 'open' || state === 'closed');
}
const LOGIN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
/** GitHub can take a while, above all on merges into busy repositories; a slow reply is waited for, not abandoned. */
export const GITHUB_TIMEOUTS = { read: 60_000, write: 120_000, cli: 60_000 } as const;
const SLOW = 'GitHub took too long to answer. Try again.';
/** A caller that gave up on time hears that GitHub was slow, not a bare abort. */
function stopIfAborted(signal: AbortSignal) {
  if (signal.aborted && (signal.reason as Error | undefined)?.name === 'TimeoutError') throw new GitHubError('GITHUB_TIMEOUT', SLOW);
  signal.throwIfAborted();
}
export interface GitHubAccount { login: string; active: boolean; available: boolean; credentialSource: string }
export interface GitHubCredentials { accounts(signal: AbortSignal): Promise<GitHubAccount[]>; token(login: string, signal: AbortSignal): Promise<string> }
type Command = (args: string[], signal: AbortSignal) => Promise<string>;
const nativeCommand: Command = async (args, signal) => {
  const env = { ...process.env, PATH: await sessionPath(), GH_PROMPT_DISABLED: '1' };
  try { return (await promisify(execFile)('gh', args, { env, timeout: GITHUB_TIMEOUTS.cli, maxBuffer: 256 * 1024, signal })).stdout; }
  catch { signal.throwIfAborted(); throw new GitHubError('GITHUB_AUTH', 'GitHub CLI is unavailable or not signed in. Run gh auth login, then reconnect.'); }
};
/** Tokens stay in the GitHub CLI's credential store and backend memory. The app
 * persists only the selected login/connection ID; it never logs command errors. */
export function githubCredentials(command: Command = nativeCommand): GitHubCredentials {
  return {
    async accounts(signal) {
      const raw = await command(['auth', 'status', '--hostname', 'github.com', '--json', 'hosts', '--jq', '.hosts["github.com"] | map({login,active,state,tokenSource})'], signal);
      let records: unknown; try { records = JSON.parse(raw); } catch { throw new GitHubError('GITHUB_AUTH', 'GitHub CLI returned invalid account metadata.'); }
      if (!Array.isArray(records)) return [];
      return records.filter(value => typeof value?.login === 'string' && LOGIN.test(value.login)).map(value => ({ login: value.login, active: value.active === true, available: value.state === 'success', credentialSource: typeof value.tokenSource === 'string' ? value.tokenSource.slice(0, 100) : 'GitHub CLI' }));
    },
    async token(login, signal) {
      if (!LOGIN.test(login)) throw new GitHubError('GITHUB_AUTH', 'Select a valid GitHub account.');
      const token = (await command(['auth', 'token', '--hostname', 'github.com', '--user', login], signal)).trim();
      signal.throwIfAborted();
      if (!token || token.length > 4096 || /\s/.test(token)) throw new GitHubError('GITHUB_AUTH', 'GitHub credentials are unavailable. Sign in again with GitHub CLI.');
      return token;
    },
  };
}
/** GitHub's x-ratelimit-* window and any hard backoff (429, or 403 at zero remaining). */
function observeLimits(budget: RequestBudget, resource: string, response: Response) {
  const header = (name: string) => { const value = response.headers.get(name); return value === null || value === '' ? undefined : Number(value); };
  const reset = header('x-ratelimit-reset'), retry = header('retry-after'), remaining = header('x-ratelimit-remaining');
  const limited = response.status === 429 || response.status === 403 && (remaining === 0 || retry !== undefined);
  budget.observe(response.headers.get('x-ratelimit-resource') ?? resource, { status: response.status, limit: header('x-ratelimit-limit'), remaining, resetAt: reset === undefined ? undefined : reset * 1000,
    ...(limited ? { retryAt: retry !== undefined && retry >= 0 ? Date.now() + retry * 1000 : reset ? reset * 1000 : Date.now() + 60_000 } : {}) });
}
function transport(login: string, credentials: GitHubCredentials = githubCredentials(), fetcher: typeof fetch = fetch, workflows = false, rollouts = false, comments = false, approvals = false, merges = false, titles = false) {
  if (!LOGIN.test(login)) throw new GitHubError('GITHUB_AUTH', 'Select a valid GitHub account.');
  return { async request(path: string, signal: AbortSignal, method: 'GET' | 'POST' | 'PATCH' = 'GET', payload: object = { body: '/review' }) {
    // Only relative REST paths, with no encoded traversal, fragments or authority.
    const resourcePath = /^\/(?:user|repos\/[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9_.-]+\/(?:pulls|issues)\/[1-9]\d*(?:\/(?:files|comments|reviews|commits))?)(?:\?per_page=100&page=[1-9]\d*)?$/.test(path);
    const commitRunsPath = /^\/repos\/[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9_.-]+\/actions\/runs\?head_sha=[a-f0-9]{40,64}&per_page=100$/i.test(path);
    const inboxPath = INBOX_PATHS.has(path) || isActivityPath(path);
    const assignedPath = /^\/issues\?filter=assigned&state=open&sort=created&direction=asc&per_page=100&page=[1-9]\d*$/.test(path);
    const workflowPath = workflows && /^\/repos\/[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9_.-]+\/(?:contents\/\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml|actions\/workflows\/[A-Za-z0-9_.-]+\.ya?ml|actions\/workflows\/(?:[A-Za-z0-9_.-]+\.ya?ml|[1-9]\d*)\/runs\?event=issue_comment&created=(?:%3E%3D\d{4}-\d{2}-\d{2}T\d{2}%3A\d{2}%3A\d{2}\.\d{3}Z|\d{4}-\d{2}-\d{2}T\d{2}%3A\d{2}%3A\d{2}\.\d{3}Z\.\.\d{4}-\d{2}-\d{2}T\d{2}%3A\d{2}%3A\d{2}\.\d{3}Z)&per_page=100&page=[1-9]\d*|actions\/runs\/[1-9]\d*\/attempts\/1\/jobs\?per_page=100&page=[1-9]\d*)$/.test(path);
    const rolloutPath = rollouts && /^\/repos\/[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*\/actions\/(?:runs\/[1-9]\d*(?:\/pending_deployments|\/attempts\/[1-9]\d*\/jobs\?per_page=100&page=[1-9]\d*)?|workflows\/[A-Za-z0-9_][A-Za-z0-9_.-]*(?:\/runs\?per_page=1(?:&branch=[A-Za-z0-9_.!~*'()%+-]+)?)?|workflows\/[1-9]\d*\/runs\?status=(?:in_progress|waiting|queued|pending|success)&per_page=10(?:&branch=[A-Za-z0-9_.!~*'()%+-]+)?)$/.test(path)
      || rollouts && /^\/repos\/[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*\/commits\/[a-f0-9]{40,64}\/pulls$/i.test(path)
      || rollouts && /^\/repos\/[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*\/compare\/[a-f0-9]{40,64}\.\.\.[a-f0-9]{40,64}\?per_page=100&page=1$/i.test(path);
    const writePath = workflows && method === 'POST' && /^\/repos\/[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9_.-]+\/issues\/[1-9]\d*\/comments$/.test(path);
    const commentPath = comments && method === 'POST' && /^\/repos\/[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9_.-]+\/(?:issues\/[1-9]\d*\/comments|pulls\/[1-9]\d*\/comments\/[1-9]\d*\/replies)$/.test(path);
    const approvalPath = approvals && method === 'POST' && /^\/repos\/[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*\/actions\/runs\/[1-9]\d*\/pending_deployments$/.test(path)
      && (payload as { state?: unknown }).state === 'approved' && Object.keys(payload).sort().join() === 'comment,environment_ids,state';
    const editPath = titles && method === 'PATCH' && (titleUpdate(path, payload) || stateUpdate(path, payload));
    // GraphQL is limited to the fixed merge-queue/head-checks read and, for merge-capable transports, the fixed merge documents.
    const merge = merges && method === 'POST' && path === '/graphql' ? mergeDocument(payload) : undefined;
    const queryPath = method === 'POST' && path === '/graphql' && ([MERGE_QUEUE_QUERY, MERGE_COMMIT_QUERY].includes((payload as { query?: string }).query ?? '') || merge === 'read');
    const read = method === 'GET' || queryPath;
    if ((method === 'PATCH' ? !editPath : method === 'POST' ? !writePath && !commentPath && !queryPath && !approvalPath && merge !== 'write' : !resourcePath && !commitRunsPath && !inboxPath && !assignedPath && !workflowPath && !rolloutPath) || path.split(/[/?]/).some(part => part === '.' || part === '..')) throw new GitHubError('GITHUB_INVALID_PATH', 'Unsupported GitHub API path.');
    // Every caller of this account shares one budget; writes are counted, never throttled.
    const budget = requestBudget('github', login), limited = path === '/graphql' ? 'graphql' : inboxPath ? 'search' : 'core';
    const release = await budget.acquire(limited, signal, !read);
    try {
      const token = await credentials.token(login, signal); signal.throwIfAborted();
      // Validators are per exact path, so each page of a collection is revalidated on
      // its own; a 304 restores that page's body and Link header, never later pages.
      const cached = method === 'GET' ? validators.get('github', login, path, Date.now()) : undefined;
      const conditional: Record<string, string> = cached?.etag ? { 'If-None-Match': cached.etag } : cached?.lastModified ? { 'If-Modified-Since': cached.lastModified } : {};
      const timeout = AbortSignal.timeout(read ? GITHUB_TIMEOUTS.read : GITHUB_TIMEOUTS.write), combined = AbortSignal.any([signal, timeout]);
      let response: Response;
      try { response = await fetcher(`https://api.github.com${path}`, { method, ...(method !== 'GET' ? { body: JSON.stringify(payload) } : {}), redirect: 'error', signal: combined, headers: { ...(method !== 'GET' ? { 'Content-Type': 'application/json' } : {}), ...conditional, Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10', 'User-Agent': 'Agentic-Crafting-Table' } }); }
      catch { if (!read) throw new GitHubError('GITHUB_POST_UNCERTAIN', 'The comment request was interrupted. Reconcile it before continuing.'); stopIfAborted(signal); throw new GitHubError('GITHUB_NETWORK', timeout.aborted ? SLOW : 'Could not reach GitHub. Check the connection and try again.'); }
      observeLimits(budget, limited, response);
      let size = 0; const chunks: Uint8Array[] = [], reader = response.body?.getReader();
      try {
        if (reader) while (true) {
          const chunk = await reader.read(); if (chunk.done) break;
          size += chunk.value.byteLength; if (size > 4 * 1024 * 1024) throw new GitHubError('GITHUB_CONTENT_LIMIT', 'GitHub response is too large to load safely.');
          chunks.push(chunk.value);
        }
        combined.throwIfAborted();
        if (response.status === 304 && cached) {
          const headers = new Headers(response.headers); headers.delete('link'); if (cached.link) headers.set('link', cached.link);
          return { status: 200, headers, body: structuredClone(cached.body) };
        }
        let body: unknown;
        try { body = size ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null; }
        catch { throw new GitHubError('GITHUB_INVALID_RESPONSE', 'GitHub returned invalid content.'); }
        if (method === 'GET' && response.status === 200) validators.set('github', login, path, { etag: response.headers.get('etag') ?? undefined, lastModified: response.headers.get('last-modified') ?? undefined, link: response.headers.get('link') ?? undefined, body }, Date.now());
        return { status: response.status, headers: response.headers, body };
      } catch (error) {
        if (!read) throw new GitHubError('GITHUB_POST_UNCERTAIN', 'The comment response was interrupted. Reconcile it before continuing.');
        stopIfAborted(signal);
        if (error instanceof GitHubError) throw error;
        throw new GitHubError('GITHUB_NETWORK', timeout.aborted ? SLOW : 'The GitHub response was interrupted. Try again.');
      } finally { await reader?.cancel().catch(() => {}); }
    } finally { release(); }
  }, mergeCommit(identity: PullIdentity, signal: AbortSignal) {
    pullKey(identity);
    return this.request('/graphql', signal, 'POST', { query: MERGE_COMMIT_QUERY, variables: { owner: identity.owner, repo: identity.repo, number: identity.number } });
  }, mergeQueue(identity: PullIdentity, signal: AbortSignal) {
    pullKey(identity);
    return this.request('/graphql', signal, 'POST', { query: MERGE_QUEUE_QUERY, variables: { owner: identity.owner, repo: identity.repo, number: identity.number } });
  }, mergeOptions(identity: PullIdentity, signal: AbortSignal) {
    pullKey(identity);
    return this.request('/graphql', signal, 'POST', { query: MERGE_OPTIONS_QUERY, variables: { owner: identity.owner, repo: identity.repo, number: identity.number } });
  }, merge(request: PullMergeRequest, signal: AbortSignal) {
    const variables = { pullRequestId: request.pullRequestId, expectedHeadOid: request.expectedHeadOid };
    return this.request('/graphql', signal, 'POST', request.method === 'QUEUE' ? { query: ENQUEUE_MUTATION, variables } : { query: MERGE_MUTATION, variables: { ...variables, mergeMethod: request.method } });
  }, setTitle(identity: PullIdentity, title: string, signal: AbortSignal) {
    pullKey(identity);
    return this.request(`/repos/${identity.owner}/${identity.repo}/pulls/${identity.number}`, signal, 'PATCH', { title });
  }, setState(identity: PullIdentity, state: 'open' | 'closed', signal: AbortSignal) {
    pullKey(identity);
    return this.request(`/repos/${identity.owner}/${identity.repo}/pulls/${identity.number}`, signal, 'PATCH', { state });
  }, setDraft(pullRequestId: string, draft: boolean, signal: AbortSignal) {
    return this.request('/graphql', signal, 'POST', { query: draft ? DRAFT_MUTATION : READY_MUTATION, variables: { pullRequestId } });
  } };
}

/** Ordinary readers have no write method and cannot access workflow endpoints. */
export function githubTransport(login: string, credentials: GitHubCredentials = githubCredentials(), fetcher: typeof fetch = fetch): GitHubTransport {
  const api = transport(login, credentials, fetcher); return { get: (path, signal) => api.request(path, signal), mergeCommit: (identity, signal) => api.mergeCommit(identity, signal), mergeQueue: (identity, signal) => api.mergeQueue(identity, signal) };
}
export function githubWorkflowTransport(login: string, credentials: GitHubCredentials = githubCredentials(), fetcher: typeof fetch = fetch): WorkflowTransport {
  const api = transport(login, credentials, fetcher, true);
  return { get: (path, signal) => api.request(path, signal), postReview: (identity, signal) => {
    pullKey(identity); return api.request(`/repos/${identity.owner}/${identity.repo}/issues/${identity.number}/comments`, signal, 'POST');
  } };
}

/** Rollout observers cannot post, approve, cancel or rerun anything. */
export function githubRolloutTransport(login: string, credentials: GitHubCredentials = githubCredentials(), fetcher: typeof fetch = fetch): GitHubTransport {
  const api = transport(login, credentials, fetcher, false, true);
  return { get: (path, signal) => api.request(path, signal) };
}

/** Rollout reader that can approve only this run's pending deployment gates:
 * no reject, rerun, cancel, dispatch or other mutation endpoint. */
export function githubRolloutApprovalTransport(login: string, credentials: GitHubCredentials = githubCredentials(), fetcher: typeof fetch = fetch): GitHubTransport {
  const api = transport(login, credentials, fetcher, false, true, false, true);
  return { get: (path, signal) => api.request(path, signal), approveDeployments: (run, environmentIds, signal) => {
    pullKey({ owner: run.owner, repo: run.repo, number: run.runId });
    if (!environmentIds.length || environmentIds.length > 100 || environmentIds.some(id => !Number.isSafeInteger(id) || id < 1)) throw new GitHubError('GITHUB_INVALID_PATH', 'Select valid deployment environments.');
    return api.request(`/repos/${run.owner}/${run.repo}/actions/runs/${run.runId}/pending_deployments`, signal, 'POST', { environment_ids: environmentIds, state: 'approved', comment: 'Approved in Agentic Crafting Table' });
  } };
}

/** Narrow comment writer: no workflow dispatch, merge or other mutation endpoint. */
export function githubCommentTransport(login: string, credentials: GitHubCredentials = githubCredentials(), fetcher: typeof fetch = fetch): GitHubTransport {
  const api = transport(login, credentials, fetcher, false, false, true);
  return { get: (path, signal) => api.request(path, signal), mergeCommit: (identity, signal) => api.mergeCommit(identity, signal), mergeQueue: (identity, signal) => api.mergeQueue(identity, signal), postComment: (path, body, signal) => api.request(path, signal, 'POST', { body }) };
}

/** Pull request reader with comment replies, one merge capability (the fixed
 * merge-options read plus the fixed merge or enqueue mutation), the PR title and
 * state updates (PATCH of exactly { title } or { state }) and the fixed draft/ready
 * mutations, nothing else. */
export function githubMergeTransport(login: string, credentials: GitHubCredentials = githubCredentials(), fetcher: typeof fetch = fetch): GitHubTransport {
  const api = transport(login, credentials, fetcher, false, false, true, false, true, true);
  return { get: (path, signal) => api.request(path, signal), mergeCommit: (identity, signal) => api.mergeCommit(identity, signal), mergeQueue: (identity, signal) => api.mergeQueue(identity, signal), postComment: (path, body, signal) => api.request(path, signal, 'POST', { body }),
    mergeOptions: (identity, signal) => api.mergeOptions(identity, signal), merge: (request, signal) => api.merge(request, signal), setTitle: (identity, title, signal) => api.setTitle(identity, title, signal),
    setState: (identity, state, signal) => api.setState(identity, state, signal), setDraft: (pullRequestId, draft, signal) => api.setDraft(pullRequestId, draft, signal) };
}
