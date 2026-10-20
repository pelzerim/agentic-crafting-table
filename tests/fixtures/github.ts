import type { GitHubComment, GitHubResponse, GitHubReview, GitHubWorkflowRun, PullMergeRequest } from '../../packages/provider-runtime/github.ts';
import { GitHubClient } from '../../packages/provider-runtime/github.ts';
import { ProviderConnections } from '../../packages/provider-runtime/connections.ts';
import { ResourcePluginHost } from '../../src/resource-plugins/host.ts';
import { githubPullRequestConnector } from '../../src/resource-plugins/items/github-pull-request/connector.ts';
import type { ResourcePluginRegistry } from '../../src/resource-plugins/registry.ts';
import { pullRequestPresentation } from '../../src/resource-plugins/items/github-pull-request/presentation.ts';
import type { SqliteStore } from '../../packages/workspace-service/sqlite-store.ts';

export const pullFixture = { id: 124, number: 42, title: 'Make billing plan changes predictable', body: 'Preserve the current plan until the next billing cycle.\n\n<script>window.providerScriptExecuted=true</script>', state: 'open', draft: false, merged: false,
  user: { login: 'fixture-developer' }, head: { sha: 'a'.repeat(40), ref: 'billing/plan-changes', repo: { full_name: 'fixture/billing' } }, base: { sha: 'b'.repeat(40), ref: 'main', repo: { full_name: 'fixture/billing' } }, created_at: '2026-09-25T10:00:00Z', updated_at: '2026-09-25T11:00:00Z', additions: 24, deletions: 6, changed_files: 1,
  assignees: [{ login: 'fixture-developer' }], requested_reviewers: [], labels: [] };
/** Switches on the opt-in Show/Ship title tags, as in a workspace that already used them. */
export function enableShowShip(store: Pick<SqliteStore, 'readSettings' | 'writeSettings'>) {
  const current = store.readSettings();
  return store.writeSettings({ expectedRevision: current.revision, value: { ...current.value, plugins: { ...current.value.plugins, 'github.pull-request': { ...current.value.plugins['github.pull-request'], showShip: true } } } });
}

export function githubFixture(additionalPulls: typeof pullFixture[] = []) {
  let pull = structuredClone(pullFixture), status = 200, requests = 0;
  let comments: GitHubComment[] = [{ id: 5, body: 'Please keep the current cycle unchanged.', user: { login: 'fixture-reviewer' }, created_at: '2026-09-25', updated_at: '2026-09-25' }], inline: GitHubComment[] = [];
  let reviews: GitHubReview[] = [{ id: 7, body: 'The new schedule looks good.', state: 'COMMENTED', user: { login: 'fixture-reviewer' }, commit_id: pull.head.sha, submitted_at: '2026-09-25' }];
  let runs: GitHubWorkflowRun[] = [];
  let headers: Record<string, string> = {}, queue = { queued: false, position: null as number | null };
  /** Completed head-commit check runs; null leaves the rollup out of the queue read. */
  let checks: { name: string; conclusion: string; required?: boolean }[] | null = null;
  let before: ((signal: AbortSignal) => Promise<void>) | undefined;
  /** Awaited before each merge, title, state and draft write, so a test can keep GitHub answering slowly. */
  let beforeWrite: (() => Promise<void>) | undefined;
  const accounts = [{ id: 'github-fixture', providerId: 'github', account: 'fixture-developer', enabled: true, isDefault: true }];
  const connections = new ProviderConnections(() => accounts, [{ id: 'github', name: 'GitHub', setupHint: 'Fixture account', accounts: async () => [{ id: 'fixture-developer', label: 'fixture-developer', active: true, available: true, credentialSource: 'test fixture' }] }]);
  const posts: { path: string; body: string }[] = [], merges: PullMergeRequest[] = [];
  /** `review` is GitHub's review decision; `rollup` the head commit's check rollup state, absent without checks. */
  let mergeSettings: { status: string; queueEnabled: boolean; squash: boolean; merge: boolean; rebase: boolean; defaultMethod: string; review?: string | null; rollup?: string } = { status: 'CLEAN', queueEnabled: false, squash: true, merge: true, rebase: true, defaultMethod: 'SQUASH' };
  let mergeReply: ((request: PullMergeRequest) => GitHubResponse | Promise<GitHubResponse>) | undefined;
  const titles: string[] = []; let titleReply: ((title: string) => GitHubResponse | Promise<GitHubResponse>) | undefined;
  /** Every comment/state/draft write in order, e.g. ['comment', 'state:closed', 'draft:true']. */
  const writes: string[] = [], states: ('open' | 'closed')[] = [], drafts: { pullRequestId: string; draft: boolean }[] = [];
  let stateReply: ((state: 'open' | 'closed') => GitHubResponse | Promise<GitHubResponse>) | undefined, draftReply: ((draft: boolean) => GitHubResponse | Promise<GitHubResponse>) | undefined;
  const nodeId = () => `PR_kwDOfixture${pull.number}`;
  /** What the fixed GraphQL merge-commit read returns; REST omits `merge_commit_sha` from API version 2026-03-10. */
  let mergeCommit: string | null = null, mergeCommitReads = 0;
  const client = new GitHubClient({ async mergeCommit(_identity, signal) {
    requests++; mergeCommitReads++; await before?.(signal); signal.throwIfAborted();
    return { status, headers: new Headers(headers), body: { data: { repository: { pullRequest: { mergeCommit: mergeCommit ? { oid: mergeCommit } : null } } } } };
  }, async mergeQueue(_identity, signal) {
    requests++; await before?.(signal); signal.throwIfAborted();
    const rollup = checks && { headRefOid: pull.head.sha, commits: { nodes: [{ commit: { oid: pull.head.sha, statusCheckRollup: { contexts: { nodes: checks.map(check => ({ __typename: 'CheckRun', name: check.name, status: 'COMPLETED', conclusion: check.conclusion, isRequired: check.required === true })) } } } }] } };
    return { status, headers: new Headers(headers), body: { data: { repository: { pullRequest: { isInMergeQueue: queue.queued, mergeQueueEntry: queue.queued ? { position: queue.position ?? 0 } : null, ...rollup } } } } };
  }, async mergeOptions(_identity, signal) {
    requests++; await before?.(signal); signal.throwIfAborted();
    return { status, headers: new Headers(headers), body: { data: { repository: { mergeCommitAllowed: mergeSettings.merge, squashMergeAllowed: mergeSettings.squash, rebaseMergeAllowed: mergeSettings.rebase, viewerDefaultMergeMethod: mergeSettings.defaultMethod,
      pullRequest: { id: nodeId(), number: pull.number, title: pull.title, state: pull.merged ? 'MERGED' : pull.state === 'closed' ? 'CLOSED' : 'OPEN', isDraft: pull.draft, merged: pull.merged, headRefOid: pull.head.sha, baseRefName: pull.base.ref,
        mergeStateStatus: pull.draft ? 'DRAFT' : mergeSettings.status, isMergeQueueEnabled: mergeSettings.queueEnabled, isInMergeQueue: queue.queued, reviewDecision: mergeSettings.review ?? null,
        commits: { nodes: [{ commit: { oid: pull.head.sha, statusCheckRollup: mergeSettings.rollup ? { state: mergeSettings.rollup } : null } }] } } } } } };
  }, async merge(request, signal) {
    signal.throwIfAborted(); await beforeWrite?.(); signal.throwIfAborted(); merges.push(request);
    if (mergeReply) return mergeReply(request);
    const decline = (message: string) => ({ status: 200, headers: new Headers(), body: { data: { [request.method === 'QUEUE' ? 'enqueuePullRequest' : 'mergePullRequest']: null }, errors: [{ type: 'UNPROCESSABLE', message }] } });
    if (request.expectedHeadOid !== pull.head.sha) return decline('Head branch was modified. Review and try the merge again.');
    if (pull.merged || pull.state === 'closed' || pull.draft || queue.queued || ['DIRTY', 'BLOCKED', 'UNKNOWN'].includes(mergeSettings.status) || mergeSettings.status === 'BEHIND' && request.method !== 'QUEUE') return decline('Pull Request is not mergeable');
    if (request.method === 'QUEUE' ? !mergeSettings.queueEnabled : mergeSettings.queueEnabled || !mergeSettings[request.method.toLowerCase() as 'squash' | 'merge' | 'rebase']) return decline('Merge method is not allowed for this repository');
    if (request.method === 'QUEUE') { queue = { queued: true, position: 0 }; return { status: 200, headers: new Headers(), body: { data: { enqueuePullRequest: { mergeQueueEntry: { position: 0, pullRequest: { id: nodeId() } } } } } }; }
    pull = { ...pull, state: 'closed', merged: true, merged_at: new Date().toISOString(), merge_commit_sha: 'c'.repeat(40) } as typeof pull;
    return { status: 200, headers: new Headers(), body: { data: { mergePullRequest: { pullRequest: { id: nodeId(), merged: true } } } } };
  }, async setTitle(_identity, title, signal) {
    signal.throwIfAborted(); await beforeWrite?.(); signal.throwIfAborted(); titles.push(title);
    if (titleReply) return titleReply(title);
    pull = { ...pull, title, updated_at: new Date().toISOString() };
    return { status: 200, headers: new Headers(), body: structuredClone(pull) };
  }, async setState(_identity, state, signal) {
    signal.throwIfAborted(); await beforeWrite?.(); signal.throwIfAborted(); writes.push(`state:${state}`); states.push(state);
    if (stateReply) return stateReply(state);
    if (pull.merged) return { status: 422, headers: new Headers(), body: { message: 'Validation Failed' } };
    pull = { ...pull, state, updated_at: new Date().toISOString() };
    return { status: 200, headers: new Headers(), body: structuredClone(pull) };
  }, async setDraft(pullRequestId, draft, signal) {
    signal.throwIfAborted(); await beforeWrite?.(); signal.throwIfAborted(); writes.push(`draft:${draft}`); drafts.push({ pullRequestId, draft });
    if (draftReply) return draftReply(draft);
    pull = { ...pull, draft, updated_at: new Date().toISOString() };
    const field = draft ? 'convertPullRequestToDraft' : 'markPullRequestReadyForReview';
    return { status: 200, headers: new Headers(), body: { data: { [field]: { pullRequest: { id: nodeId(), isDraft: draft } } } } };
  }, async postComment(path, body) {
    posts.push({ path, body }); writes.push('comment');
    const entry = { id: 1000 + posts.length, body, user: { login: 'fixture-developer' }, created_at: '2026-09-28', updated_at: '2026-09-28' };
    if (path.includes('/replies')) inline.push(entry); else comments.push(entry);
    return { status: 201, body: entry, headers: new Headers() };
  }, async get(path, signal) {
    requests++; await before?.(signal); signal.throwIfAborted();
    const body = path.includes('/actions/runs?head_sha=') ? { workflow_runs: structuredClone(runs) } : path.includes('/files?') ? [{ filename: 'src/billing/plans.ts', status: 'modified', additions: 24, deletions: 6, changes: 30, patch: '@@ -12,1 +12,1 @@\n-applyNow(plan)\n+scheduleNextCycle(plan)' }]
      : /\/pulls\/\d+\/comments\?/.test(path) ? structuredClone(inline) : path.includes('/comments?') ? structuredClone(comments)
        : path.includes('/reviews?') ? structuredClone(reviews) : structuredClone(additionalPulls.find(candidate => path.endsWith(`/pulls/${candidate.number}`)) ?? pull);
    return { status, body, headers: new Headers(headers) };
  } });
  return { connections, accounts, client, posts, merges, get mergeCommit() { return mergeCommit; }, set mergeCommit(value) { mergeCommit = value; }, get mergeCommitReads() { return mergeCommitReads; }, get mergeSettings() { return mergeSettings; }, set mergeSettings(value) { mergeSettings = value; }, replyToMerge(reply: typeof mergeReply) { mergeReply = reply; }, titles, replyToTitle(reply: typeof titleReply) { titleReply = reply; }, writes, states, drafts, replyToState(reply: typeof stateReply) { stateReply = reply; }, replyToDraft(reply: typeof draftReply) { draftReply = reply; }, get comments() { return comments; }, set comments(value) { comments = value; }, get inline() { return inline; }, set inline(value) { inline = value; }, get reviewEntries() { return reviews; }, set reviewEntries(value) { reviews = value; }, get requests() { return requests; }, get pull() { return pull; }, set pull(value) { pull = value; }, get runs() { return runs; }, set runs(value) { runs = value; }, get queue() { return queue; }, set queue(value) { queue = value; }, get checks() { return checks; }, set checks(value) { checks = value; },
    fail(code: number, extra: Record<string, string> = {}) { status = code; headers = extra; }, delay(callback: typeof before) { before = callback; }, holdWrites(gate: typeof beforeWrite) { beforeWrite = gate; },
    host(registry: ResourcePluginRegistry) { const host = new ResourcePluginHost(registry); host.register('github.pull-request', githubPullRequestConnector(resource => { connections.resolve('github', resource.connectionId); return client; }, { viewer: resource => resource.connectionId ? connections.resolve('github', resource.connectionId).account : undefined })); host.present('github.pull-request', pullRequestPresentation); return host; },
  };
}
