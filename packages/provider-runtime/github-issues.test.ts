import test from 'node:test';
import assert from 'node:assert/strict';
import { GitHubClient, issueKey, issueLifecycle } from './github.ts';
import type { GitHubResponse, GitHubTransport } from './github.ts';
import { ISSUE_PULLS_QUERY, githubCommentTransport, githubIssueTransport, githubMergeTransport, githubTransport, issueStateUpdate } from './github-transport.ts';

const signal = () => AbortSignal.timeout(10_000), key = { owner: 'acme', repo: 'web', number: 7 };
const issueFixture = { id: 70, number: 7, title: 'Search ignores accents', body: 'Searching **café** finds nothing.', state: 'open', state_reason: null, user: { login: 'alice' },
  assignees: [{ login: 'alice' }], labels: [{ name: 'bug', color: 'd73a4a' }], comments: 1, created_at: '2026-10-01T09:00:00Z', updated_at: '2026-10-02T09:00:00Z', closed_at: null };
const reply = (body: unknown, status = 200): GitHubResponse => ({ status, headers: new Headers(), body });
const client = (transport: Partial<GitHubTransport>) => new GitHubClient({ get: async () => reply(issueFixture), ...transport });
const auth = { accounts: async () => [], token: async () => 'fixture-token' };

test('the issue transport sends exactly PATCH { state, state_reason } and the fixed linked pull request query, nothing else', async () => {
  const requests: { url: string; method: string; body?: string }[] = [];
  const fetcher = (async (url: any, options: any) => { requests.push({ url: String(url), method: options.method, body: options.body }); return Response.json({}); }) as typeof fetch;
  const transport = githubIssueTransport('alice', auth, fetcher);
  await transport.setIssueState!(key, { state: 'closed', state_reason: 'completed' }, signal());
  await transport.setIssueState!(key, { state: 'closed', state_reason: 'not_planned' }, signal());
  await transport.setIssueState!(key, { state: 'open', state_reason: 'reopened' }, signal());
  await transport.issuePulls!(key, signal());
  await transport.get('/repos/acme/web/issues/7', signal()); await transport.get('/repos/acme/web/issues/7/comments?per_page=100&page=1', signal());
  assert.deepEqual(requests.map(r => [r.url, r.method, r.body && JSON.parse(r.body)]), [
    ['https://api.github.com/repos/acme/web/issues/7', 'PATCH', { state: 'closed', state_reason: 'completed' }],
    ['https://api.github.com/repos/acme/web/issues/7', 'PATCH', { state: 'closed', state_reason: 'not_planned' }],
    ['https://api.github.com/repos/acme/web/issues/7', 'PATCH', { state: 'open', state_reason: 'reopened' }],
    ['https://api.github.com/graphql', 'POST', { query: ISSUE_PULLS_QUERY, variables: { owner: 'acme', repo: 'web', number: 7 } }],
    ['https://api.github.com/repos/acme/web/issues/7', 'GET', undefined],
    ['https://api.github.com/repos/acme/web/issues/7/comments?per_page=100&page=1', 'GET', undefined],
  ]);
  await assert.rejects(transport.setIssueState!(key, { state: 'open', state_reason: 'completed' } as never, signal()), /Unsupported/);
  await assert.rejects(async () => transport.setIssueState!({ ...key, repo: '..' }, { state: 'closed', state_reason: 'completed' }, signal()), /valid GitHub/);
  assert.equal(transport.postComment, undefined); assert.equal(transport.setState, undefined); assert.equal(transport.setTitle, undefined); assert.equal(transport.merge, undefined);
  for (const other of [githubTransport('alice', auth, fetcher), githubCommentTransport('alice', auth, fetcher), githubMergeTransport('alice', auth, fetcher)]) assert.equal(other.setIssueState, undefined);
});

test('the issue PATCH allowlist accepts only an issue path with a closing reason, or reopened with open', () => {
  assert.equal(issueStateUpdate('/repos/acme/web/issues/7', { state: 'closed', state_reason: 'completed' }), true);
  assert.equal(issueStateUpdate('/repos/acme/web/issues/7', { state: 'open', state_reason: 'reopened' }), true);
  for (const [path, payload] of [['/repos/acme/web/pulls/7', { state: 'closed', state_reason: 'completed' }], ['/repos/acme/web/issues/7', { state: 'closed' }],
    ['/repos/acme/web/issues/7', { state: 'closed', state_reason: 'duplicate' }], ['/repos/acme/web/issues/7', { state: 'closed', state_reason: 'completed', title: 'x' }],
    ['/repos/acme/../issues/7', { state: 'open', state_reason: 'reopened' }], ['/repos/acme/web/issues/7/comments', { state: 'open', state_reason: 'reopened' }]] as const)
    assert.equal(issueStateUpdate(path, payload), false, `${path} ${JSON.stringify(payload)}`);
});

test('an issue read keeps the listed fields, refuses a pull request or another number, and names the issue when it is missing', async () => {
  const issue = await client({ get: async path => { assert.equal(path, '/repos/acme/web/issues/7'); return reply({ ...issueFixture, token: 'not-kept' }); } }).issue(key, signal());
  assert.equal(issue.title, 'Search ignores accents'); assert.equal(issueLifecycle(issue), 'open'); assert.ok(!('token' in issue));
  assert.equal(issueKey({ owner: 'Acme', repo: 'Web', number: 7 }), 'acme/web/issues/7');
  assert.throws(() => issueKey({ owner: '../x', repo: 'web', number: 7 }), /valid GitHub issue/);
  await assert.rejects(client({ get: async () => reply({ ...issueFixture, pull_request: { url: 'x' } }) }).issue(key, signal()), /pull request/);
  await assert.rejects(client({ get: async () => reply({ ...issueFixture, number: 8 }) }).issue(key, signal()), /different issue/);
  await assert.rejects(client({ get: async () => reply({ message: 'Not Found' }, 404) }).issue(key, signal()), /Issue unavailable/);
  assert.equal(issueLifecycle({ state: 'closed', state_reason: 'not_planned' }), 'not_planned');
  assert.equal(issueLifecycle({ state: 'closed', state_reason: null }), 'completed');
  assert.equal(issueLifecycle({ state: 'closed', state_reason: 'duplicate' }), 'duplicate');
});

test('a state change is confirmed by the issue GitHub returns; a refusal says so and an unconfirmed reply is outcome-unknown', async () => {
  const sent: unknown[] = [];
  const closed = await client({ setIssueState: async (_key, change) => { sent.push(change); return reply({ ...issueFixture, state: 'closed', state_reason: 'not_planned' }); } }).setIssueState(key, 'not_planned', signal());
  assert.equal(issueLifecycle(closed), 'not_planned');
  await client({ setIssueState: async (_key, change) => { sent.push(change); return reply({ ...issueFixture, state_reason: 'reopened' }); } }).setIssueState(key, 'open', signal());
  assert.deepEqual(sent, [{ state: 'closed', state_reason: 'not_planned' }, { state: 'open', state_reason: 'reopened' }]);
  await assert.rejects(client({ setIssueState: async () => reply({ message: 'Validation Failed' }, 422) }).setIssueState(key, 'completed', signal()), /declined/);
  await assert.rejects(client({ setIssueState: async () => reply({ message: 'Forbidden' }, 403) }).setIssueState(key, 'completed', signal()), /permission to change this issue/);
  await assert.rejects(client({ setIssueState: async () => reply(issueFixture) }).setIssueState(key, 'completed', signal()), (error: Error & { outcomeUnknown?: boolean }) => error.outcomeUnknown === true);
  await assert.rejects(client({ setIssueState: async () => { throw Object.assign(new Error('cut'), { code: 'GITHUB_POST_UNCERTAIN' }); } }).setIssueState(key, 'completed', signal()), /may have changed/);
  await assert.rejects(client({}).setIssueState(key, 'completed', signal()), /unavailable for this connection/);
  await assert.rejects(client({ setIssueState: async () => reply(issueFixture) }).setIssueState(key, 'duplicate' as never, signal()), /Choose open/);
});

test('linked pull requests list the ones that close the issue first, then those that mention it, each once, never an issue', async () => {
  const pr = (owner: string, name: string, number: number) => ({ number, repository: { name, owner: { login: owner } } });
  const body = { data: { repository: { issue: {
    closedByPullRequestsReferences: { nodes: [pr('acme', 'web', 12), null] },
    timelineItems: { nodes: [{ __typename: 'CrossReferencedEvent', source: { __typename: 'PullRequest', ...pr('acme', 'api', 3) } }, { __typename: 'CrossReferencedEvent', source: { __typename: 'Issue', ...pr('acme', 'web', 9) } },
      { __typename: 'ConnectedEvent', subject: { __typename: 'PullRequest', ...pr('Acme', 'Web', 12) } }, null] } } } } };
  const pulls = await client({ issuePulls: async () => reply(body) }).issuePulls(key, signal());
  assert.deepEqual(pulls, [{ owner: 'acme', repo: 'web', number: 12 }, { owner: 'acme', repo: 'api', number: 3 }]);
  await assert.rejects(client({ issuePulls: async () => reply({ data: { repository: { issue: null } }, errors: [{ message: 'Could not resolve' }] }) }).issuePulls(key, signal()), /Issue unavailable/);
  await assert.rejects(client({ issuePulls: async () => reply({ data: { repository: { issue: { closedByPullRequestsReferences: {} } } } }) }).issuePulls(key, signal()), /unsupported response/);
  await assert.rejects(client({}).issuePulls(key, signal()), /unavailable for this connection/);
});

test('assigned issues come from the assigned list without its pull requests, most recently updated first, capped', async () => {
  const entry = (number: number, updated: string, extra: object = {}) => ({ number, title: `Issue ${number}`, state: 'open', assignees: [{ login: 'alice' }], repository: { full_name: 'acme/web' }, updated_at: updated, labels: [{ name: 'bug' }], ...extra });
  const paths: string[] = [];
  const reader = client({ get: async path => { paths.push(path); return reply([entry(1, '2026-10-01'), entry(2, '2026-10-03'), entry(3, '2026-10-05', { pull_request: {} }), entry(4, '2026-10-02'), entry(5, '2026-10-04', { state: 'closed' })]); } });
  const { issues, truncated } = await reader.assignedIssues(signal());
  assert.deepEqual(paths, ['/issues?filter=assigned&state=open&sort=created&direction=asc&per_page=100&page=1'], 'the very read assigned pull requests use, so its validator is shared');
  assert.deepEqual(issues.map(issue => issue.number), [2, 4, 1]); assert.equal(truncated, false);
  assert.deepEqual(issues[0], { owner: 'acme', repo: 'web', number: 2, title: 'Issue 2', url: 'https://github.com/acme/web/issues/2', updatedAt: '2026-10-03', labels: ['bug'] });
  const capped = await reader.assignedIssues(signal(), 2);
  assert.deepEqual(capped.issues.map(issue => issue.number), [2, 4]); assert.equal(capped.truncated, true);
  await assert.rejects(client({ get: async () => reply([entry(1, '2026-10-01', { repository: { full_name: 'acme' } })]) }).assignedIssues(signal()), /invalid repository/);
});
