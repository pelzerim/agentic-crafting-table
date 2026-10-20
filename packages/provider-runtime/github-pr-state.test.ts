import test from 'node:test';
import assert from 'node:assert/strict';
import { GitHubClient, pullLifecycle, stateChanges } from './github.ts';
import { DRAFT_MUTATION, READY_MUTATION, githubCommentTransport, githubMergeTransport, githubTransport, mergeDocument, stateUpdate } from './github-transport.ts';
import { githubFixture } from '../../tests/fixtures/github.ts';

const signal = () => AbortSignal.timeout(10_000), key = { owner: 'fixture', repo: 'billing', number: 42 }, id = 'PR_kwDOfixture42';

test('lifecycle and allowed changes: open offers draft and close, drafts offer ready and close, closed offers reopen, merged nothing', () => {
  const pull = { state: 'OPEN' as const, isDraft: false, merged: false };
  assert.equal(pullLifecycle(pull), 'open'); assert.deepEqual(stateChanges('open'), ['draft', 'close']);
  assert.equal(pullLifecycle({ ...pull, isDraft: true }), 'draft'); assert.deepEqual(stateChanges('draft'), ['ready', 'close']);
  assert.equal(pullLifecycle({ ...pull, state: 'CLOSED' }), 'closed'); assert.deepEqual(stateChanges('closed'), ['reopen']);
  assert.equal(pullLifecycle({ ...pull, state: 'CLOSED', isDraft: true }), 'closed');
  assert.equal(pullLifecycle({ ...pull, state: 'MERGED', merged: true }), 'merged'); assert.deepEqual(stateChanges('merged'), []);
});

test('state transport sends exactly PATCH { state } and the fixed draft/ready mutations', async () => {
  const requests: { url: string; method: string; body: string }[] = []; let credentials = 0;
  const fetcher = (async (url: any, options: any) => { requests.push({ url: String(url), method: options.method, body: options.body }); return Response.json({}); }) as typeof fetch;
  const auth = { accounts: async () => [], token: async () => { credentials++; return 'fixture-token'; } };
  const transport = githubMergeTransport('fixture', auth, fetcher);
  await transport.setState!(key, 'closed', signal()); await transport.setState!(key, 'open', signal());
  await transport.setDraft!(id, true, signal()); await transport.setDraft!(id, false, signal());
  assert.deepEqual(requests.map(r => [r.url, r.method, JSON.parse(r.body)]), [
    ['https://api.github.com/repos/fixture/billing/pulls/42', 'PATCH', { state: 'closed' }],
    ['https://api.github.com/repos/fixture/billing/pulls/42', 'PATCH', { state: 'open' }],
    ['https://api.github.com/graphql', 'POST', { query: DRAFT_MUTATION, variables: { pullRequestId: id } }],
    ['https://api.github.com/graphql', 'POST', { query: READY_MUTATION, variables: { pullRequestId: id } }],
  ]);
  const before = credentials;
  await assert.rejects(transport.setState!(key, 'merged' as any, signal()), /Unsupported/);
  for (const bad of ['', 'PR x', 'x'.repeat(201)]) await assert.rejects(transport.setDraft!(bad, true, signal()), /Unsupported/);
  await assert.rejects(async () => transport.setState!({ owner: '../x', repo: 'billing', number: 42 }, 'closed', signal()), /valid GitHub/);
  assert.equal(credentials, before);
  for (const reader of [githubTransport('fixture', auth, fetcher), githubCommentTransport('fixture', auth, fetcher)]) { assert.equal(reader.setState, undefined); assert.equal(reader.setDraft, undefined); }
});

test('the allowlists accept only { state: open|closed } on a PR path and the draft mutations with one node ID', () => {
  assert.equal(stateUpdate('/repos/fixture/billing/pulls/42', { state: 'closed' }), true);
  assert.equal(stateUpdate('/repos/fixture/billing/pulls/42', { state: 'open' }), true);
  for (const [path, payload] of [['/repos/fixture/billing/pulls/42', { state: 'closed', title: 'x' }], ['/repos/fixture/billing/pulls/42', { state: 'merged' }], ['/repos/fixture/billing/pulls/42', { title: 'x' }],
    ['/repos/fixture/billing/issues/42', { state: 'closed' }], ['/repos/fixture/../pulls/42', { state: 'closed' }], ['/repos/fixture/billing/pulls/42/merge', { state: 'closed' }], ['/graphql', { state: 'closed' }]] as const)
    assert.equal(stateUpdate(path, payload), false, `${path} ${JSON.stringify(payload)}`);
  assert.equal(mergeDocument({ query: READY_MUTATION, variables: { pullRequestId: id } }), 'write');
  assert.equal(mergeDocument({ query: DRAFT_MUTATION, variables: { pullRequestId: id } }), 'write');
  assert.equal(mergeDocument({ query: DRAFT_MUTATION, variables: { pullRequestId: id, extra: 1 } }), undefined);
  assert.equal(mergeDocument({ query: DRAFT_MUTATION, variables: { pullRequestId: 'PR x' } }), undefined);
  assert.equal(mergeDocument({ query: DRAFT_MUTATION.replace('isDraft', 'isDraft title'), variables: { pullRequestId: id } }), undefined);
});

test('closing with a comment posts the comment first, then closes; an empty comment posts nothing', async () => {
  const f = githubFixture();
  await f.client.changeState(key, { pullRequestId: id, change: 'close', comment: 'Superseded by #43.' }, signal());
  assert.deepEqual(f.writes, ['comment', 'state:closed']);
  assert.deepEqual(f.posts, [{ path: '/repos/fixture/billing/issues/42/comments', body: 'Superseded by #43.' }]);
  assert.equal(f.pull.state, 'closed');
  await f.client.changeState(key, { pullRequestId: id, change: 'reopen' }, signal());
  assert.equal(f.pull.state, 'open');
  for (const comment of [undefined, '', '  \n ']) {
    const g = githubFixture();
    await g.client.changeState(key, { pullRequestId: id, change: 'close', ...(comment === undefined ? {} : { comment }) }, signal());
    assert.deepEqual(g.writes, ['state:closed']); assert.equal(g.posts.length, 0);
  }
});

test('draft toggles send one mutation each and follow the PR', async () => {
  const f = githubFixture();
  await f.client.changeState(key, { pullRequestId: id, change: 'draft' }, signal());
  assert.equal(f.pull.draft, true);
  await f.client.changeState(key, { pullRequestId: id, change: 'ready' }, signal());
  assert.equal(f.pull.draft, false);
  assert.deepEqual(f.writes, ['draft:true', 'draft:false']);
  assert.deepEqual(f.drafts, [{ pullRequestId: id, draft: true }, { pullRequestId: id, draft: false }]);
});

test('state changes send without judging GitHub state first; GitHub declines what it refuses', async () => {
  const f = githubFixture();
  await assert.rejects(f.client.changeState(key, { pullRequestId: id, change: 'close', comment: 'x'.repeat(60_001) }, signal()), /60,000/);
  assert.deepEqual(f.writes, []);
  f.delay(async () => { throw new Error('a state change must not read first'); });
  await f.client.changeState(key, { pullRequestId: id, change: 'ready' }, signal());
  await f.client.changeState(key, { pullRequestId: id, change: 'reopen' }, signal());
  assert.deepEqual(f.writes, ['draft:false', 'state:open']);
  f.pull = { ...f.pull, state: 'closed', merged: true };
  await assert.rejects(f.client.changeState(key, { pullRequestId: id, change: 'reopen' }, signal()), (error: any) => error.code === 'GITHUB_REJECTED' && error.message === 'GitHub declined to reopen the pull request.');
  assert.deepEqual(f.writes, ['draft:false', 'state:open', 'state:open']);
  await assert.rejects(new GitHubClient({ get: async () => { throw new Error('unused'); } }).changeState(key, { pullRequestId: id, change: 'close' }, signal()), /unavailable for this connection/);
});

test('permission errors are readable and a failed close after a posted comment says the comment went out', async () => {
  const f = githubFixture();
  f.replyToState(() => ({ status: 403, body: { message: 'Must have admin rights to Repository.' }, headers: new Headers() }));
  await assert.rejects(f.client.changeState(key, { pullRequestId: id, change: 'close' }, signal()),
    (error: any) => error.code === 'GITHUB_FORBIDDEN' && /permission to change this pull request/.test(error.message));
  await assert.rejects(f.client.changeState(key, { pullRequestId: id, change: 'close', comment: 'Closing.' }, signal()),
    (error: any) => /^Your comment was posted, but GitHub did not close the pull request\. .*permission/.test(error.message));
  assert.deepEqual(f.writes, ['state:closed', 'comment', 'state:closed']);
  f.replyToState(() => ({ status: 422, body: { message: 'Validation Failed' }, headers: new Headers() }));
  await assert.rejects(f.client.changeState(key, { pullRequestId: id, change: 'close' }, signal()), (error: any) => error.code === 'GITHUB_REJECTED' && !error.outcomeUnknown);
  for (const [status, body] of [[502, null], [200, { unexpected: true }]] as const) {
    f.replyToState(() => ({ status, body, headers: new Headers() }));
    await assert.rejects(f.client.changeState(key, { pullRequestId: id, change: 'close' }, signal()), (error: any) => error.outcomeUnknown === true && /Check the PR before trying again/.test(error.message));
  }
  f.replyToDraft(() => ({ status: 200, body: { data: { convertPullRequestToDraft: null }, errors: [{ type: 'FORBIDDEN', message: 'Resource not accessible by integration' }] }, headers: new Headers() }));
  await assert.rejects(f.client.changeState(key, { pullRequestId: id, change: 'draft' }, signal()),
    (error: any) => error.code === 'GITHUB_REJECTED' && error.message === 'GitHub declined to convert it to a draft: Resource not accessible by integration');
  f.replyToDraft(() => ({ status: 200, body: { data: { convertPullRequestToDraft: { pullRequest: { id, isDraft: false } } } }, headers: new Headers() }));
  await assert.rejects(f.client.changeState(key, { pullRequestId: id, change: 'draft' }, signal()), (error: any) => error.outcomeUnknown === true);
  f.replyToDraft(() => { throw Object.assign(new Error('interrupted'), { code: 'GITHUB_POST_UNCERTAIN' }); });
  await assert.rejects(f.client.changeState(key, { pullRequestId: id, change: 'draft' }, signal()), (error: any) => error.outcomeUnknown === true);
  assert.equal(f.pull.state, 'open'); assert.equal(f.pull.draft, false);
});
