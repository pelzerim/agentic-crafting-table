import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { GitHubClient, GitHubError, pullKey } from './github.ts';
import { githubCommentTransport, githubCredentials, githubMergeTransport, githubTransport } from './github-transport.ts';

const identity = { owner: 'Acme', repo: 'example', number: 42 }, signal = () => new AbortController().signal;
const pull = { id: 124, number: 42, title: 'Fix billing plans', body: 'Safe **markdown** <script>untrusted</script>', state: 'open', draft: true, merged: false,
  user: { login: 'reviewer' }, head: { sha: 'a'.repeat(40), ref: 'billing', repo: { full_name: 'fork/example' } }, base: { sha: 'b'.repeat(40), ref: 'main', repo: { full_name: 'Acme/example' } }, created_at: '2026-09-25T10:00:00Z', updated_at: '2026-09-25T11:00:00Z', additions: 42, deletions: 8, changed_files: 2,
  assignees: [{ login: 'developer' }], requested_reviewers: [{ login: 'reviewer' }], labels: [{ name: 'billing', color: 'abcdef' }], ignored_field: 'DO_NOT_PERSIST' };
const file = (name: string) => ({ filename: name, status: 'modified', additions: 1, deletions: 0, changes: 1, patch: '@@ -1 +1 @@\n+change' });

async function httpFixture(run: (input: { client: GitHubClient; requests: { url: string; auth?: string; method?: string; version?: string }[]; reply: (handler: (url: string) => { status?: number; headers?: Record<string, string>; body?: unknown; raw?: string }) => void }) => Promise<void>) {
  const requests: { url: string; auth?: string; method?: string; version?: string }[] = [];
  let handler = (_url: string): { status?: number; headers?: Record<string, string>; body?: unknown; raw?: string } => ({ body: pull });
  const server = createServer((request, response) => {
    requests.push({ url: request.url!, auth: request.headers.authorization, method: request.method, version: request.headers['x-github-api-version'] as string });
    const reply = handler(request.url!); response.writeHead(reply.status ?? 200, reply.headers); response.end(reply.raw ?? JSON.stringify(reply.body ?? null));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  const fetcher: typeof fetch = (url, init) => {
    assert.ok(String(url).startsWith('https://api.github.com/')); assert.equal(init?.redirect, 'error');
    const parsed = new URL(String(url)); return fetch(`http://127.0.0.1:${address.port}${parsed.pathname}${parsed.search}`, init);
  };
  const credentials = { async token(login: string) { assert.equal(login, 'reviewer'); return 'fake-test-token'; }, async accounts() { return []; } };
  try { await run({ client: new GitHubClient(githubTransport('reviewer', credentials, fetcher), () => 1_000_000), requests, reply: fn => { handler = fn; } }); }
  finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}

test('authenticated GitHub reads validate/project PR data and retain exact comparison identity', () => httpFixture(async ({ client, requests, reply }) => {
  const result = await client.pull(identity, signal());
  assert.equal(result.title, pull.title); assert.equal(result.body, pull.body); assert.equal(result.head.sha, 'a'.repeat(40)); assert.equal(result.draft, true);
  assert.ok(!('ignored_field' in result)); assert.equal(pullKey(identity), 'acme/example/pull/42');
  assert.equal(pullKey({ ...identity, repo: '.github' }), 'acme/.github/pull/42');
  assert.deepEqual(requests, [{ url: '/repos/Acme/example/pulls/42', auth: 'Bearer fake-test-token', method: 'GET', version: '2026-03-10' }]);
  reply(() => ({ body: { ...pull, number: 43 } })); await assert.rejects(client.pull(identity, signal()), /different pull request/);
  reply(() => ({ body: { ...pull, head: { ...pull.head, sha: 'not-a-commit' } } })); await assert.rejects(client.pull(identity, signal()), /unsupported response/);
  reply(() => ({ body: { id: 99, login: 'reviewer', token: 'not-in-viewer-data' } })); assert.deepEqual(await client.viewer(signal()), { id: 99, login: 'reviewer' });
}));

test('file pagination remains on the configured endpoint and refuses partial/error results', () => httpFixture(async ({ client, requests, reply }) => {
  reply(url => url.endsWith('page=1') ? { headers: { Link: '<https://attacker.invalid/token-leak>; rel="next"' }, body: [file('one.ts')] } : { body: [file('two.ts')] });
  assert.deepEqual((await client.files(identity, signal())).map(file => file.filename), ['one.ts', 'two.ts']);
  assert.deepEqual(requests.map(request => request.url), ['/repos/Acme/example/pulls/42/files?per_page=100&page=1', '/repos/Acme/example/pulls/42/files?per_page=100&page=2']);
  reply(url => url.endsWith('page=1') ? { headers: { Link: '<https://api.github.com/next>; rel="next"' }, body: [file('one.ts')] } : { status: 503, body: { message: 'server error' } });
  await assert.rejects(client.files(identity, signal()), (error: unknown) => error instanceof GitHubError && error.code === 'GITHUB_UNAVAILABLE');
  reply(() => ({ headers: { Link: '<https://api.github.com/next>; rel="next"' }, body: [] }));
  await assert.rejects(client.files(identity, signal()), (error: unknown) => error instanceof GitHubError && error.code === 'GITHUB_CONTENT_LIMIT');
  assert.equal(requests.at(-1)?.url.endsWith('page=30'), true);
}));

test('authentication, permission, rate limit and invalid responses produce bounded actionable errors', () => httpFixture(async ({ client, reply }) => {
  for (const [status, code] of [[401, 'GITHUB_AUTH'], [403, 'GITHUB_FORBIDDEN'], [404, 'GITHUB_NOT_FOUND'], [502, 'GITHUB_UNAVAILABLE']] as const) {
    reply(() => ({ status, body: { message: 'Sensitive provider text must stay out of errors' } }));
    await assert.rejects(client.pull(identity, signal()), (error: unknown) => error instanceof GitHubError && error.code === code && !error.message.includes('Sensitive'));
  }
  reply(() => ({ status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1500' } }));
  await assert.rejects(client.pull(identity, signal()), (error: unknown) => error instanceof GitHubError && error.retryAt === 1_500_000);
  reply(() => ({ status: 429, headers: { 'retry-after': '10' } }));
  await assert.rejects(client.pull(identity, signal()), (error: unknown) => error instanceof GitHubError && error.retryAt === 1_010_000);
  reply(() => ({ raw: '{broken' })); await assert.rejects(client.pull(identity, signal()), /invalid content/);
  reply(() => ({ raw: 'x'.repeat(4 * 1024 * 1024 + 1) })); await assert.rejects(client.pull(identity, signal()), /too large/);
}));

test('cancellation and unsafe paths cannot dispatch or return provider content', async () => {
  let credentials = 0, requests = 0;
  const transport = githubTransport('reviewer', { async accounts() { return []; }, async token() { credentials++; return 'fake'; } }, async () => { requests++; return new Response('{}'); });
  for (const path of ['https://evil.invalid', '//evil.invalid', '/repos/../example/pulls/42', '/repos/owner/../pulls/42', '/repos/owner/repo/pulls/42#other', '/repos/%2E%2E/repo/pulls/42']) await assert.rejects(transport.get(path, signal()), /Unsupported/);
  assert.equal(credentials, 0); assert.equal(requests, 0);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(new GitHubClient(transport).pull(identity, controller.signal), { name: 'AbortError' }); assert.equal(requests, 0);
  const late = new AbortController();
  const client = new GitHubClient({ async get() { late.abort(); return { status: 200, headers: new Headers(), body: pull }; } });
  await assert.rejects(client.pull(identity, late.signal), { name: 'AbortError' });
});

test('GitHub CLI credentials use the chosen login without exposing tokens in account metadata', async () => {
  const calls: string[][] = [];
  const credentials = githubCredentials(async args => {
    calls.push(args);
    return args[1] === 'status' ? JSON.stringify([{ login: 'reviewer', active: true, state: 'success', tokenSource: 'keyring', token: 'must-be-omitted' }, { login: 'other', state: 'error' }, { login: '--inject', state: 'success' }]) : 'fixture-secret\n';
  });
  assert.deepEqual(await credentials.accounts(signal()), [{ login: 'reviewer', active: true, available: true, credentialSource: 'keyring' }, { login: 'other', active: false, available: false, credentialSource: 'GitHub CLI' }]);
  assert.equal(await credentials.token('reviewer', signal()), 'fixture-secret');
  assert.deepEqual(calls.at(-1), ['auth', 'token', '--hostname', 'github.com', '--user', 'reviewer']);
  await assert.rejects(credentials.token('--inject', signal())); assert.equal(calls.length, 2);
});

test('assigned PR discovery paginates completely, excludes issues and never trusts provider URLs', () => httpFixture(async ({ client, requests, reply }) => {
  const issue = { number: 42, title: 'Assigned work', state: 'open', assignees: [{ login: 'reviewer' }], repository: { full_name: 'Acme/example' } };
  reply(url => url.endsWith('page=1') ? { body: [issue], headers: { Link: '<https://attacker.invalid/page>; rel="next"' } }
    : { body: [{ ...issue, pull_request: { url: 'https://attacker.invalid/pr' } }] });
  assert.deepEqual(await client.assignedPulls(signal()), [{ owner: 'Acme', repo: 'example', number: 42, title: 'Assigned work', state: 'open', assignees: ['reviewer'] }]);
  assert.deepEqual(requests.map(request => request.url), [1, 2].map(page => `/issues?filter=assigned&state=open&sort=created&direction=asc&per_page=100&page=${page}`));
  reply(url => url.endsWith('page=1') ? { body: [{ ...issue, pull_request: {} }], headers: { Link: '<https://api.github.com/next>; rel="next"' } } : { status: 503 });
  await assert.rejects(client.assignedPulls(signal()), /could not load/);
  reply(() => ({ body: [{ ...issue, pull_request: {}, repository: { full_name: 'Acme/../secrets' } }] }));
  await assert.rejects(client.assignedPulls(signal()), /invalid repository/);
}));

test('merge queue state uses one fixed read-only GraphQL query with bounded errors', async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  let reply: () => Response = () => Response.json({ data: { repository: { pullRequest: { isInMergeQueue: true, mergeQueueEntry: { position: 2, state: 'QUEUED' } } } } });
  const transport = githubTransport('reviewer', { async accounts() { return []; }, async token() { return 'fake-test-token'; } }, async (url, init) => { calls.push({ url: String(url), init }); return reply(); });
  const client = new GitHubClient(transport, () => 1_000_000);
  assert.deepEqual(await client.mergeQueue(identity, signal()), { queued: true, position: 2 });
  assert.equal(calls[0].url, 'https://api.github.com/graphql'); assert.equal(calls[0].init?.method, 'POST'); assert.equal(calls[0].init?.redirect, 'error');
  const body = JSON.parse(String(calls[0].init?.body));
  assert.deepEqual(body.variables, { owner: 'Acme', repo: 'example', number: 42 });
  assert.match(body.query, /^query MergeQueueState\(/); assert.doesNotMatch(body.query, /mutation/i);
  reply = () => Response.json({ data: { repository: { pullRequest: { isInMergeQueue: false, mergeQueueEntry: null } } } });
  assert.deepEqual(await client.mergeQueue(identity, signal()), { queued: false, position: null });
  reply = () => Response.json({ data: { repository: null }, errors: [{ type: 'NOT_FOUND', message: 'Sensitive provider text' }] });
  await assert.rejects(client.mergeQueue(identity, signal()), (error: unknown) => error instanceof GitHubError && error.code === 'GITHUB_INVALID_RESPONSE' && !error.message.includes('Sensitive'));
  reply = () => new Response(null, { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1500' } });
  await assert.rejects(client.mergeQueue(identity, signal()), (error: unknown) => error instanceof GitHubError && error.retryAt === 1_500_000);
  reply = () => { throw new TypeError('socket closed'); };
  await assert.rejects(client.mergeQueue(identity, signal()), (error: unknown) => error instanceof GitHubError && error.code === 'GITHUB_NETWORK');
  const before = calls.length;
  await assert.rejects(client.mergeQueue({ ...identity, owner: '../x' }, signal()), /valid GitHub pull request/); assert.equal(calls.length, before);
  await assert.rejects(transport.get('/graphql', signal()), /Unsupported/);
  assert.equal(await new GitHubClient({ async get() { throw new Error('unused'); } }).mergeQueue(identity, signal()), null);
});
test('the merge queue read also returns failing head checks, preferring required checks', async () => {
  let reply: unknown;
  const client = new GitHubClient({ async get() { throw new Error('unused'); }, async mergeQueue() { return { status: 200, headers: new Headers(), body: reply }; } });
  const head = 'a'.repeat(40), run = (name: string, conclusion: string | null, isRequired = false, status = 'COMPLETED') => ({ __typename: 'CheckRun', name, status, conclusion, isRequired });
  const rollup = (nodes: unknown[], oid = head) => ({ data: { repository: { pullRequest: { isInMergeQueue: false, mergeQueueEntry: null, headRefOid: head, commits: { nodes: [{ commit: { oid, statusCheckRollup: { state: 'FAILURE', contexts: { totalCount: nodes.length, nodes } } } }] } } } } });
  reply = rollup([run('unit', 'FAILURE'), run('lint', 'SUCCESS'), run('flaky', 'CANCELLED'), run('pending', null, false, 'IN_PROGRESS'), { __typename: 'StatusContext', context: 'ci/legacy', state: 'ERROR', isRequired: false }, null]);
  assert.deepEqual(await client.mergeQueue(identity, signal()), { queued: false, position: null, checks: { head, failing: ['unit', 'ci/legacy'] } });
  reply = rollup([run('unit', 'SUCCESS', true), run('optional', 'FAILURE')]);
  assert.deepEqual((await client.mergeQueue(identity, signal()))?.checks, { head, failing: [] }, 'a failing optional check does not count when required checks exist');
  reply = rollup([run('unit', 'TIMED_OUT', true), run('optional', 'FAILURE')]);
  assert.deepEqual((await client.mergeQueue(identity, signal()))?.checks, { head, failing: ['unit'] });
  reply = rollup([run('unit', 'FAILURE')], 'f'.repeat(40));
  assert.equal((await client.mergeQueue(identity, signal()))?.checks, undefined, 'a rollup for another commit is ignored');
  reply = { data: { repository: { pullRequest: { isInMergeQueue: true, mergeQueueEntry: { position: 1 }, headRefOid: head, commits: { nodes: [{ commit: { oid: head, statusCheckRollup: null } }] } } } }, errors: [{ message: 'Resource not accessible' }] };
  assert.deepEqual(await client.mergeQueue(identity, signal()), { queued: true, position: 1, checks: { head, failing: [] } }, 'an unreadable rollup never breaks queue status');
  reply = { data: { repository: { pullRequest: { isInMergeQueue: false, mergeQueueEntry: null, headRefOid: head, commits: 'unexpected' } } } };
  assert.deepEqual(await client.mergeQueue(identity, signal()), { queued: false, position: null });
});

test('every pull-request transport reads the merge commit with one fixed read-only GraphQL query', async () => {
  const credentials = { async accounts() { return []; }, async token() { return 'fake-test-token'; } };
  for (const make of [githubTransport, githubCommentTransport, githubMergeTransport]) {
    const calls: { url: string; init?: RequestInit }[] = [];
    let reply: () => Response = () => Response.json({ data: { repository: { pullRequest: { mergeCommit: { oid: 'C'.repeat(40) } } } } });
    const client = new GitHubClient(make('reviewer', credentials, async (url, init) => { calls.push({ url: String(url), init }); return reply(); }), () => 1_000_000);
    assert.equal(await client.mergeCommit(identity, signal()), 'c'.repeat(40));
    assert.equal(calls[0].url, 'https://api.github.com/graphql'); assert.equal(calls[0].init?.method, 'POST');
    const body = JSON.parse(String(calls[0].init?.body));
    assert.deepEqual(body.variables, { owner: 'Acme', repo: 'example', number: 42 });
    assert.match(body.query, /^query PullRequestMergeCommit\(/); assert.doesNotMatch(body.query, /mutation/i);
    reply = () => Response.json({ data: { repository: { pullRequest: { mergeCommit: null } } } });
    assert.equal(await client.mergeCommit(identity, signal()), null);
    reply = () => Response.json({ data: { repository: { pullRequest: { mergeCommit: { oid: 'not-a-commit' } } } } });
    await assert.rejects(client.mergeCommit(identity, signal()), { code: 'GITHUB_INVALID_RESPONSE' });
  }
});
