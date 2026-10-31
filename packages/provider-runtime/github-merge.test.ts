import test from 'node:test';
import assert from 'node:assert/strict';
import { GitHubClient, mergeChoices, mergeReadiness } from './github.ts';
import type { PullMergeState } from './github.ts';
import { DISABLE_AUTO_MERGE_MUTATION, ENABLE_AUTO_MERGE_MUTATION, ENABLE_AUTO_MERGE_QUEUE_MUTATION, ENQUEUE_MUTATION, MERGE_MUTATION, MERGE_OPTIONS_QUERY, MERGE_QUEUE_QUERY, mergeDocument, githubCommentTransport, githubMergeTransport, githubTransport } from './github-transport.ts';
import { githubFixture } from '../../tests/fixtures/github.ts';
import { githubPullRequestConnector } from '../../src/resource-plugins/items/github-pull-request/connector.ts';

const signal = () => AbortSignal.timeout(10_000), key = { owner: 'fixture', repo: 'billing', number: 42 }, head = 'a'.repeat(40);
const state = (pull: Partial<PullMergeState['pullRequest']> = {}, repository: Partial<Omit<PullMergeState, 'pullRequest'>> = {}): PullMergeState => ({
  mergeCommitAllowed: true, squashMergeAllowed: true, rebaseMergeAllowed: true, viewerDefaultMergeMethod: 'MERGE', ...repository,
  pullRequest: { id: 'PR_kwDOfixture42', number: 42, title: 'Make billing plan changes predictable', state: 'OPEN', isDraft: false, merged: false, headRefOid: head, baseRefName: 'main',
    mergeStateStatus: 'CLEAN', isMergeQueueEnabled: false, isInMergeQueue: false, ...pull } });

test('merge options refuse only a merged PR, warn about what GitHub reports and order the allowed methods with the viewer default first', () => {
  assert.match((mergeChoices(state({ state: 'MERGED', merged: true })) as { refusal: string }).refusal, /already merged/);
  const prompt = (value: PullMergeState) => (mergeChoices(value) as { prompt: string }).prompt, ids = (value: PullMergeState) => (mergeChoices(value) as { options: { id: string }[] }).options.map(option => option.id);
  const base = 'Merge #42 “Make billing plan changes predictable” into main at aaaaaaa?';
  for (const [value, warning] of [[state({ state: 'CLOSED' }), 'GitHub reports it is closed.'], [state({ isDraft: true }), 'GitHub reports it is a draft.'], [state({ mergeStateStatus: 'DRAFT' }), 'GitHub reports it is a draft.'],
    [state({ mergeStateStatus: 'DIRTY' }), 'GitHub reports merge conflicts.'], [state({ mergeStateStatus: 'BLOCKED' }), 'Required reviews or checks are not satisfied.'],
    [state({ mergeStateStatus: 'BEHIND' }), 'The branch is out of date with main.'], [state({ mergeStateStatus: 'UNKNOWN' }), 'GitHub is still checking whether it can merge.'],
    [state({ isDraft: true, mergeStateStatus: 'DRAFT' }), 'GitHub reports it is a draft.']] as const) {
    assert.equal(prompt(value), `${base} ${warning}`); assert.deepEqual(ids(value), ['MERGE', 'SQUASH', 'REBASE']);
  }
  assert.equal(prompt(state({ isMergeQueueEnabled: true, isInMergeQueue: true })), 'Add #42 “Make billing plan changes predictable” to the main merge queue at aaaaaaa? GitHub reports it is already in the merge queue.');
  assert.deepEqual(ids(state({}, { mergeCommitAllowed: false, squashMergeAllowed: false, rebaseMergeAllowed: false })), ['MERGE', 'SQUASH', 'REBASE']);
  const clean = mergeChoices(state()) as { prompt: string; options: { id: string; label: string }[] };
  assert.equal(clean.prompt, 'Merge #42 “Make billing plan changes predictable” into main at aaaaaaa?');
  assert.deepEqual(clean.options, [{ id: 'MERGE', label: 'Create a merge commit' }, { id: 'SQUASH', label: 'Squash and merge' }, { id: 'REBASE', label: 'Rebase and merge' }]);
  assert.deepEqual((mergeChoices(state({}, { viewerDefaultMergeMethod: 'REBASE', mergeCommitAllowed: false })) as { options: { id: string }[] }).options.map(o => o.id), ['REBASE', 'SQUASH']);
  assert.deepEqual((mergeChoices(state({}, { viewerDefaultMergeMethod: 'MERGE', mergeCommitAllowed: false })) as { options: { id: string }[] }).options.map(o => o.id), ['SQUASH', 'REBASE']);
  for (const status of ['HAS_HOOKS', 'UNSTABLE'] as const) assert.ok('options' in mergeChoices(state({ mergeStateStatus: status })));
  assert.match((mergeChoices(state({ mergeStateStatus: 'UNSTABLE' })) as { prompt: string }).prompt, /non-required checks are failing/);
  const queued = mergeChoices(state({ isMergeQueueEnabled: true, mergeStateStatus: 'BEHIND' })) as { prompt: string; options: { id: string; label: string }[] };
  assert.deepEqual(queued, { prompt: 'Add #42 “Make billing plan changes predictable” to the main merge queue at aaaaaaa?', options: [{ id: 'QUEUE', label: 'Add to merge queue' }] });
  for (const pull of [{ title: 'x'.repeat(500), baseRefName: 'b'.repeat(300) }, { title: 'x'.repeat(500), baseRefName: 'b'.repeat(300), state: 'CLOSED' as const, isDraft: true, isInMergeQueue: true, mergeStateStatus: 'BEHIND' as const }])
    assert.ok((mergeChoices(state(pull)) as { prompt: string }).prompt.length <= 500);
});

test('merge transport sends only the fixed options query and merge/enqueue mutations with validated variables', async () => {
  const requests: { url: string; method: string; body: string }[] = []; let credentials = 0;
  const fetcher = (async (url: any, options: any) => { requests.push({ url: String(url), method: options.method, body: options.body }); return Response.json({ data: null }); }) as typeof fetch;
  const auth = { accounts: async () => [], token: async () => { credentials++; return 'fixture-token'; } };
  const transport = githubMergeTransport('fixture', auth, fetcher);
  await transport.mergeOptions!(key, signal());
  await transport.merge!({ pullRequestId: 'PR_kwDOfixture42', expectedHeadOid: head, method: 'SQUASH' }, signal());
  await transport.merge!({ pullRequestId: 'PR_kwDOfixture42', expectedHeadOid: head, method: 'QUEUE' }, signal());
  assert.deepEqual(requests.map(r => [r.url, r.method, JSON.parse(r.body)]), [
    ['https://api.github.com/graphql', 'POST', { query: MERGE_OPTIONS_QUERY, variables: { owner: 'fixture', repo: 'billing', number: 42 } }],
    ['https://api.github.com/graphql', 'POST', { query: MERGE_MUTATION, variables: { pullRequestId: 'PR_kwDOfixture42', expectedHeadOid: head, mergeMethod: 'SQUASH' } }],
    ['https://api.github.com/graphql', 'POST', { query: ENQUEUE_MUTATION, variables: { pullRequestId: 'PR_kwDOfixture42', expectedHeadOid: head } }],
  ]);
  const before = credentials;
  for (const request of [{ pullRequestId: 'PR_x', expectedHeadOid: head, method: 'FAST_FORWARD' }, { pullRequestId: 'PR x', expectedHeadOid: head, method: 'MERGE' }, { pullRequestId: 'PR_x', expectedHeadOid: 'abc', method: 'MERGE' }, { pullRequestId: '', expectedHeadOid: head, method: 'QUEUE' }])
    await assert.rejects(transport.merge!(request as any, signal()), /Unsupported/);
  await assert.rejects(async () => transport.mergeOptions!({ owner: '../x', repo: 'billing', number: 42 }, signal()), /valid GitHub/);
  for (const path of ['/graphql', '/repos/fixture/billing/pulls/42/merge']) await assert.rejects(transport.postComment!(path, 'x', signal()), /Unsupported/);
  await assert.rejects(transport.get('/repos/fixture/billing/pulls/42/merge', signal()), /Unsupported/);
  assert.equal(credentials, before);
  for (const reader of [githubTransport('fixture', auth, fetcher), githubCommentTransport('fixture', auth, fetcher)]) { assert.equal(reader.merge, undefined); assert.equal(reader.mergeOptions, undefined); }
  let sent = 0; const interrupted = githubMergeTransport('fixture', auth, (async () => { sent++; throw new TypeError('socket closed'); }) as typeof fetch);
  await assert.rejects(interrupted.merge!({ pullRequestId: 'PR_kwDOfixture42', expectedHeadOid: head, method: 'MERGE' }, signal()), (error: any) => error.code === 'GITHUB_POST_UNCERTAIN');
  assert.equal(sent, 1);
});

test('only the exact merge documents and variable shapes are recognized', () => {
  const variables = { pullRequestId: 'PR_kwDOfixture42', expectedHeadOid: head, mergeMethod: 'MERGE' }, enqueue = { pullRequestId: 'PR_kwDOfixture42', expectedHeadOid: head };
  assert.equal(mergeDocument({ query: MERGE_OPTIONS_QUERY, variables: { owner: 'fixture', repo: 'billing', number: 42 } }), 'read');
  assert.equal(mergeDocument({ query: MERGE_MUTATION, variables }), 'write');
  assert.equal(mergeDocument({ query: ENQUEUE_MUTATION, variables: enqueue }), 'write');
  for (const payload of [
    { query: MERGE_MUTATION.replace('merged', 'merged author { login }'), variables }, { query: `${MERGE_MUTATION} `, variables },
    { query: MERGE_MUTATION, variables: { ...variables, commitHeadline: 'x' } }, { query: MERGE_MUTATION, variables, operationName: 'MergePullRequest' },
    { query: MERGE_MUTATION, variables: { ...variables, mergeMethod: 'merge' } }, { query: MERGE_MUTATION, variables: { ...variables, expectedHeadOid: undefined } },
    { query: ENQUEUE_MUTATION, variables: { ...enqueue, jump: true } }, { query: ENQUEUE_MUTATION, variables }, { query: ENQUEUE_MUTATION, variables: { ...enqueue, pullRequestId: 'PR"x' } },
    { query: MERGE_OPTIONS_QUERY, variables: { owner: 'fixture', repo: 'billing', number: '42' } }, { query: MERGE_OPTIONS_QUERY, variables: { owner: 'fixture', repo: 'billing', number: 42, extra: 1 } },
    { query: MERGE_OPTIONS_QUERY, variables: { owner: '..', repo: 'billing', number: 42 } }, { query: MERGE_OPTIONS_QUERY },
    { query: 'mutation { closePullRequest(input: { pullRequestId: "PR_kwDOfixture42" }) { clientMutationId } }', variables: {} },
  ]) assert.equal(mergeDocument(payload), undefined, JSON.stringify(payload));
});

test('merge sends the write without judging GitHub state first, writes once and never reports an uncertain write as success', async () => {
  const f = githubFixture(), request = { pullRequestId: 'PR_kwDOfixture42', expectedHeadOid: head, method: 'SQUASH' as const };
  f.delay(async () => { throw new Error('a merge must not read first'); });
  for (const settings of [{ squash: false }, { status: 'BLOCKED' }, { status: 'DIRTY' }, { queueEnabled: true }]) {
    f.mergeSettings = { ...f.mergeSettings, ...settings }; f.replyToMerge(() => ({ status: 200, headers: new Headers(), body: { data: { mergePullRequest: null }, errors: [{ type: 'UNPROCESSABLE', message: 'Pull Request is not mergeable' }] } }));
    await assert.rejects(f.client.merge(key, request, signal()), (error: any) => error.code === 'GITHUB_REJECTED' && error.message === 'GitHub declined the merge: Pull Request is not mergeable');
  }
  f.mergeSettings = { ...f.mergeSettings, squash: true, status: 'CLEAN', queueEnabled: false }; f.delay(undefined);
  assert.deepEqual(f.merges, Array(4).fill(request)); f.merges.length = 0;
  const reply = (status: number, body: unknown, headers: Record<string, string> = {}) => f.replyToMerge(() => ({ status, body, headers: new Headers(headers) }));
  reply(200, { data: { mergePullRequest: null }, errors: [{ type: 'UNPROCESSABLE', message: 'Head branch was modified.\u001b[31m Review and try the merge again.\n' + 'x'.repeat(400) }] });
  await assert.rejects(f.client.merge(key, request, signal()), (error: any) => error.code === 'GITHUB_REJECTED' && !error.outcomeUnknown && /^GitHub declined the merge: Head branch was modified\. \[31m Review/.test(error.message) && error.message.length < 220 && !/[\u0000-\u001f]/.test(error.message));
  reply(403, {}, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1' }); await assert.rejects(f.client.merge(key, request, signal()), (error: any) => error.code === 'GITHUB_RATE_LIMIT');
  for (const [status, body] of [[502, null], [200, { data: { mergePullRequest: { pullRequest: { id: 'PR_kwDOfixture42', merged: false } } } }], [200, { data: { mergePullRequest: { pullRequest: { id: 'PR_other', merged: true } } } }], [200, { unexpected: true }]] as const) {
    reply(status, body); await assert.rejects(f.client.merge(key, request, signal()), (error: any) => error.outcomeUnknown === true && error.message === 'GitHub may have merged it. Check the PR before trying again.');
  }
  f.replyToMerge(() => { throw Object.assign(new Error('interrupted'), { code: 'GITHUB_POST_UNCERTAIN' }); });
  await assert.rejects(f.client.merge(key, { ...request, method: 'MERGE' }, signal()), (error: any) => error.outcomeUnknown === true);
  const writes = f.merges.length; assert.equal(writes, 7);
  f.replyToMerge(undefined); await f.client.merge(key, request, signal());
  assert.deepEqual(f.merges.at(-1), request); assert.equal(f.merges.length, writes + 1);
  await assert.rejects(f.client.merge(key, request, signal()), (error: any) => error.code === 'GITHUB_REJECTED' && /^GitHub declined the merge: /.test(error.message)); assert.equal(f.merges.length, writes + 2);
  const moved = githubFixture(); moved.pull = { ...moved.pull, head: { ...moved.pull.head, sha: 'd'.repeat(40) } };
  await assert.rejects(moved.client.merge(key, request, signal()), (error: any) => error.code === 'GITHUB_REJECTED' && /Head branch was modified/.test(error.message));
  assert.deepEqual(moved.merges, [request]);
  const queue = githubFixture(); queue.mergeSettings = { ...queue.mergeSettings, queueEnabled: true };
  queue.replyToMerge(() => ({ status: 200, headers: new Headers(), body: { data: { enqueuePullRequest: null } } }));
  await assert.rejects(queue.client.merge(key, { ...request, method: 'QUEUE' }, signal()), (error: any) => error.outcomeUnknown === true && /may have queued/.test(error.message));
  await assert.rejects(new GitHubClient({ get: async () => { throw new Error('unused'); } }).merge(key, request, signal()), /unavailable for this connection/);
});

test('connector binds options to this PR and head, and returns the merged or queued snapshot', async () => {
  const f = githubFixture(), connector = githubPullRequestConnector(() => f.client);
  const resource = { id: 'pr', pluginId: 'github.pull-request', schemaVersion: 1, title: 'PR', data: key } as any;
  const choices = await connector.execute!(resource, 'pr.merge.options', signal()) as any;
  assert.deepEqual(choices, { current: '', prompt: 'Merge #42 “Make billing plan changes predictable” into main at aaaaaaa?', context: { sourceResourceId: 'pr', pullRequestId: 'PR_kwDOfixture42', expectedHeadOid: head },
    options: [{ id: 'SQUASH', label: 'Squash and merge' }, { id: 'MERGE', label: 'Create a merge commit' }, { id: 'REBASE', label: 'Rebase and merge' }] });
  const action = connector.actions!(resource).find(action => action.id === 'pr.merge')!;
  assert.equal(action.humanOnly, true); assert.equal(action.updatesSnapshot, true);
  assert.equal(connector.actions!(resource).find(action => action.id === 'pr.merge.options')?.readOnly, true);
  await assert.rejects(connector.execute!(resource, 'pr.merge', signal(), { ...choices.context, value: 'SQUASH', sourceResourceId: 'other', requestId: 'x' }), /another item/);
  await assert.rejects(connector.execute!(resource, 'pr.merge', signal(), { ...choices.context, value: 'FAST_FORWARD', requestId: 'x' }), /incomplete/);
  await assert.rejects(connector.execute!(resource, 'pr.merge', signal(), { ...choices.context, expectedHeadOid: 'nope', value: 'SQUASH', requestId: 'x' }), /incomplete/);
  f.pull = { ...f.pull, head: { ...f.pull.head, sha: 'e'.repeat(40) } };
  await assert.rejects(connector.execute!(resource, 'pr.merge', signal(), { ...choices.context, value: 'SQUASH', requestId: 'x' }), /GitHub declined the merge: Head branch was modified/);
  assert.equal(f.merges.length, 1);
  f.pull = { ...f.pull, head: { ...f.pull.head, sha: head }, draft: true };
  const draft = await connector.execute!(resource, 'pr.merge.options', signal()) as any;
  assert.equal(draft.prompt, 'Merge #42 “Make billing plan changes predictable” into main at aaaaaaa? GitHub reports it is a draft.');
  await assert.rejects(connector.execute!(resource, 'pr.merge', signal(), { ...draft.context, value: 'SQUASH', requestId: 'x' }), /GitHub declined the merge: /);
  f.pull = { ...f.pull, draft: false };
  const result = await connector.execute!(resource, 'pr.merge', signal(), { ...choices.context, value: 'SQUASH', requestId: 'x' }) as any;
  assert.equal(f.merges.length, 3); assert.equal(result.snapshot.detail.status, 'merged'); assert.equal(result.snapshot.indicators[0].label, 'Merged');
  await assert.rejects(connector.execute!(resource, 'pr.merge.options', signal()), /already merged/);

  const q = githubFixture(), queued = githubPullRequestConnector(() => q.client); q.mergeSettings = { ...q.mergeSettings, queueEnabled: true, status: 'BEHIND' };
  const queueChoices = await queued.execute!(resource, 'pr.merge.options', signal()) as any;
  assert.deepEqual(queueChoices.options, [{ id: 'QUEUE', label: 'Add to merge queue' }]);
  const queueResult = await queued.execute!(resource, 'pr.merge', signal(), { ...queueChoices.context, value: 'QUEUE', requestId: 'x' }) as any;
  assert.equal(queueResult.snapshot.detail.status, 'queued'); assert.equal(queueResult.snapshot.indicators[0].label, 'Queued');
  assert.match((await queued.execute!(resource, 'pr.merge.options', signal()) as any).prompt, /GitHub reports it is already in the merge queue\.$/);

  const r = githubFixture(), refreshing = githubPullRequestConnector(() => r.client), context = (await refreshing.execute!(resource, 'pr.merge.options', signal()) as any).context;
  r.delay(async () => { if (r.merges.length) throw new Error('offline'); });
  await assert.rejects(refreshing.execute!(resource, 'pr.merge', signal(), { ...context, value: 'MERGE', requestId: 'x' }), (error: any) => error.outcomeUnknown === true && /Merged, but refresh failed/.test(error.message));
  assert.equal(r.merges.length, 1);
});

test('merge readiness reads what decides an unattended merge from the same fixed query: review decision and the head commit check rollup', () => {
  const rollup = (oid: string, value: string | null) => ({ nodes: [{ commit: { oid, statusCheckRollup: value === null ? null : { state: value } } }] });
  const ready = (pull: Partial<PullMergeState['pullRequest']> = {}, repository: Partial<Omit<PullMergeState, 'pullRequest'>> = {}) => mergeReadiness(state(pull, repository));
  assert.deepEqual(ready({ reviewDecision: 'APPROVED', commits: rollup(head, 'SUCCESS') }), { pullRequestId: 'PR_kwDOfixture42', number: 42, title: 'Make billing plan changes predictable', lifecycle: 'open', head, base: 'main',
    mergeStateStatus: 'CLEAN', reviewDecision: 'APPROVED', checks: 'passing', queued: false, queueEnabled: false, mergeWhenReady: false, method: 'MERGE' });
  for (const [value, checks] of [['SUCCESS', 'passing'], ['PENDING', 'pending'], ['EXPECTED', 'pending'], ['FAILURE', 'failing'], ['ERROR', 'failing'], [null, 'none']] as const)
    assert.equal(ready({ commits: rollup(head, value) }).checks, checks, String(value));
  assert.equal(ready({ commits: rollup('b'.repeat(40), 'SUCCESS') }).checks, 'pending', 'a rollup of an older commit says nothing about the head');
  assert.equal(ready().checks, 'none'); assert.equal(ready().reviewDecision, null);
  assert.equal(ready({ isMergeQueueEnabled: true, mergeStateStatus: 'BEHIND' }).method, 'QUEUE');
  assert.equal(ready({}, { viewerDefaultMergeMethod: 'SQUASH' }).method, 'SQUASH');
  assert.deepEqual([ready({ state: 'MERGED', merged: true }).lifecycle, ready({ state: 'MERGED', merged: true }).method], ['merged', null]);
  assert.equal(ready({ isDraft: true }).lifecycle, 'draft'); assert.equal(ready({ state: 'CLOSED' }).lifecycle, 'closed');
  assert.equal(ready({ isInMergeQueue: true, isMergeQueueEnabled: true }).queued, true);
  assert.match(MERGE_OPTIONS_QUERY, / reviewDecision commits\(last: 1\) \{ nodes \{ commit \{ oid statusCheckRollup \{ state \} \} \} \} /);
});

test('connector offers merge readiness as a read-only action of this PR', async () => {
  const f = githubFixture(), connector = githubPullRequestConnector(() => f.client), resource = { id: 'pr', pluginId: 'github.pull-request', schemaVersion: 1, title: 'PR', data: key } as any;
  const action = connector.actions!(resource).find(entry => entry.id === 'pr.mergeReadiness')!;
  assert.equal(action.readOnly, true); assert.equal(action.humanOnly, undefined);
  f.mergeSettings = { ...f.mergeSettings, review: 'REVIEW_REQUIRED', rollup: 'PENDING' };
  const readiness = await connector.execute!(resource, 'pr.mergeReadiness', signal()) as any;
  assert.deepEqual([readiness.reviewDecision, readiness.checks, readiness.mergeStateStatus, readiness.method, readiness.head], ['REVIEW_REQUIRED', 'pending', 'CLEAN', 'SQUASH', f.pull.head.sha]);
  assert.equal(f.merges.length, 0); assert.equal(f.titles.length, 0);
});

test('the merge state and queue reads carry whether auto-merge is allowed and already on', async () => {
  assert.match(MERGE_OPTIONS_QUERY, / viewerDefaultMergeMethod autoMergeAllowed pullRequest\(number: \$number\) \{/);
  assert.match(MERGE_OPTIONS_QUERY, / \} \} \} \} autoMergeRequest \{ enabledAt mergeMethod \} \} \} \}$/);
  assert.match(MERGE_QUEUE_QUERY, /\{ isMergeQueueEnabled isInMergeQueue mergeQueueEntry \{ position \} autoMergeRequest \{ enabledAt mergeMethod \} headRefOid /);
  const f = githubFixture(), enabledAt = '2026-10-30T09:00:00Z';
  let read = await f.client.mergeState(key, signal());
  assert.equal(read.autoMergeAllowed, false); assert.equal(read.pullRequest.autoMergeRequest, null);
  assert.deepEqual(await f.client.mergeQueue(key, signal()), { queued: false, position: null });
  f.mergeSettings = { ...f.mergeSettings, autoMergeAllowed: true }; f.autoMerge = { method: 'SQUASH', enabledAt };
  read = await f.client.mergeState(key, signal());
  assert.equal(read.autoMergeAllowed, true); assert.deepEqual(read.pullRequest.autoMergeRequest, { enabledAt, mergeMethod: 'SQUASH' });
  assert.deepEqual(await f.client.mergeQueue(key, signal()), { queued: false, position: null, mergeWhenReady: { method: 'SQUASH', enabledAt } });
  f.mergeSettings = { ...f.mergeSettings, queueEnabled: true }; f.autoMerge = { method: null, enabledAt };
  assert.deepEqual((await f.client.mergeQueue(key, signal()))?.mergeWhenReady, { method: 'QUEUE', enabledAt });
  const older = new GitHubClient({ get: async () => { throw new Error('unused'); }, mergeQueue: async () => ({ status: 200, headers: new Headers(), body: { data: { repository: { pullRequest: { isInMergeQueue: false, mergeQueueEntry: null } } } } }) });
  assert.deepEqual(await older.mergeQueue(key, signal()), { queued: false, position: null }, 'a reply without the auto-merge fields still reads');
});

test('merge when ready sends only the fixed enable and disable auto-merge documents with validated variables', async () => {
  const requests: { url: string; method: string; body: string }[] = [];
  const fetcher = (async (url: any, options: any) => { requests.push({ url: String(url), method: options.method, body: options.body }); return Response.json({ data: null }); }) as typeof fetch;
  const auth = { accounts: async () => [], token: async () => 'fixture-token' }, transport = githubMergeTransport('fixture', auth, fetcher);
  await transport.merge!({ pullRequestId: 'PR_kwDOfixture42', expectedHeadOid: head, method: 'SQUASH', whenReady: true }, signal());
  await transport.merge!({ pullRequestId: 'PR_kwDOfixture42', expectedHeadOid: head, method: 'QUEUE', whenReady: true }, signal());
  await transport.disableAutoMerge!('PR_kwDOfixture42', signal());
  assert.deepEqual(requests.map(r => [r.url, r.method, JSON.parse(r.body)]), [
    ['https://api.github.com/graphql', 'POST', { query: ENABLE_AUTO_MERGE_MUTATION, variables: { pullRequestId: 'PR_kwDOfixture42', expectedHeadOid: head, mergeMethod: 'SQUASH' } }],
    ['https://api.github.com/graphql', 'POST', { query: ENABLE_AUTO_MERGE_QUEUE_MUTATION, variables: { pullRequestId: 'PR_kwDOfixture42', expectedHeadOid: head } }],
    ['https://api.github.com/graphql', 'POST', { query: DISABLE_AUTO_MERGE_MUTATION, variables: { pullRequestId: 'PR_kwDOfixture42' } }],
  ]);
  assert.match(ENABLE_AUTO_MERGE_MUTATION, /enablePullRequestAutoMerge\(input: \{ pullRequestId: \$pullRequestId, expectedHeadOid: \$expectedHeadOid, mergeMethod: \$mergeMethod \}\)/);
  assert.doesNotMatch(ENABLE_AUTO_MERGE_QUEUE_MUTATION, /mergeMethod:/);
  for (const request of [{ pullRequestId: 'PR x', expectedHeadOid: head, method: 'SQUASH', whenReady: true }, { pullRequestId: 'PR_x', expectedHeadOid: 'abc', method: 'QUEUE', whenReady: true }])
    await assert.rejects(transport.merge!(request as any, signal()), /Unsupported/);
  await assert.rejects(transport.disableAutoMerge!('PR"x', signal()), /Unsupported/);
  for (const reader of [githubTransport('fixture', auth, fetcher), githubCommentTransport('fixture', auth, fetcher)]) assert.equal(reader.disableAutoMerge, undefined);
  const enable = { pullRequestId: 'PR_kwDOfixture42', expectedHeadOid: head, mergeMethod: 'REBASE' }, queue = { pullRequestId: 'PR_kwDOfixture42', expectedHeadOid: head };
  assert.equal(mergeDocument({ query: ENABLE_AUTO_MERGE_MUTATION, variables: enable }), 'write');
  assert.equal(mergeDocument({ query: ENABLE_AUTO_MERGE_QUEUE_MUTATION, variables: queue }), 'write');
  assert.equal(mergeDocument({ query: DISABLE_AUTO_MERGE_MUTATION, variables: { pullRequestId: 'PR_kwDOfixture42' } }), 'write');
  for (const payload of [{ query: ENABLE_AUTO_MERGE_MUTATION, variables: queue }, { query: ENABLE_AUTO_MERGE_MUTATION, variables: { ...enable, commitHeadline: 'x' } }, { query: ENABLE_AUTO_MERGE_MUTATION, variables: { ...enable, mergeMethod: 'FAST_FORWARD' } },
    { query: ENABLE_AUTO_MERGE_QUEUE_MUTATION, variables: enable }, { query: `${ENABLE_AUTO_MERGE_MUTATION} `, variables: enable }, { query: DISABLE_AUTO_MERGE_MUTATION, variables: queue },
    { query: DISABLE_AUTO_MERGE_MUTATION, variables: { pullRequestId: 'PR"x' } }]) assert.equal(mergeDocument(payload), undefined, JSON.stringify(payload));
});

test('merge when ready writes once, says plainly when the pull request became mergeable, and never reports an uncertain write as success', async () => {
  const f = githubFixture(), request = { pullRequestId: 'PR_kwDOfixture42', expectedHeadOid: head, method: 'SQUASH' as const, whenReady: true };
  f.mergeSettings = { ...f.mergeSettings, autoMergeAllowed: true, status: 'CLEAN' };
  await assert.rejects(f.client.merge(key, request, signal()), (error: any) => error.code === 'GITHUB_REJECTED' && !error.outcomeUnknown
    && error.message === 'GitHub declined merge when ready because the pull request can be merged now. Open Merge again to merge it.');
  f.mergeSettings = { ...f.mergeSettings, autoMergeAllowed: false, status: 'BLOCKED' };
  await assert.rejects(f.client.merge(key, request, signal()), (error: any) => error.code === 'GITHUB_REJECTED' && error.message === 'GitHub declined merge when ready: Pull request Auto merge is not allowed for this repository');
  f.mergeSettings = { ...f.mergeSettings, autoMergeAllowed: true };
  await f.client.merge(key, request, signal());
  assert.equal(f.autoMerge?.method, 'SQUASH'); assert.deepEqual(f.merges.at(-1), request); assert.equal(f.merges.length, 3);
  const reply = (status: number, body: unknown, headers: Record<string, string> = {}) => f.replyToMerge(() => ({ status, body, headers: new Headers(headers) }));
  reply(403, { message: 'Resource not accessible by integration' });
  await assert.rejects(f.client.merge(key, request, signal()), (error: any) => error.code === 'GITHUB_FORBIDDEN' && /doesn’t have permission to change this pull request/.test(error.message));
  for (const [status, body] of [[502, null], [200, { data: { enablePullRequestAutoMerge: { pullRequest: { id: 'PR_kwDOfixture42', autoMergeRequest: null } } } }], [200, { data: { enablePullRequestAutoMerge: { pullRequest: { id: 'PR_other', autoMergeRequest: { enabledAt: null, mergeMethod: 'SQUASH' } } } } }]] as const) {
    reply(status, body); await assert.rejects(f.client.merge(key, request, signal()), (error: any) => error.outcomeUnknown === true && error.message === 'GitHub may have turned on merge when ready. Check the PR before trying again.');
  }
  f.replyToMerge(undefined);
  await f.client.cancelMergeWhenReady(key, 'PR_kwDOfixture42', signal());
  assert.deepEqual(f.mergeCancels, ['PR_kwDOfixture42']); assert.equal(f.autoMerge, null);
  await assert.rejects(new GitHubClient({ get: async () => { throw new Error('unused'); } }).cancelMergeWhenReady(key, 'PR_kwDOfixture42', signal()), /unavailable for this connection/);
  const declining = new GitHubClient({ get: async () => { throw new Error('unused'); }, disableAutoMerge: async () => ({ status: 200, headers: new Headers(), body: { data: { disablePullRequestAutoMerge: null }, errors: [{ message: 'Pull request auto merge is not enabled' }] } }) });
  await assert.rejects(declining.cancelMergeWhenReady(key, 'PR_kwDOfixture42', signal()), (error: any) => error.code === 'GITHUB_REJECTED' && error.message === 'GitHub declined to cancel merge when ready: Pull request auto merge is not enabled');
  const unconfirmed = new GitHubClient({ get: async () => { throw new Error('unused'); }, disableAutoMerge: async () => ({ status: 200, headers: new Headers(), body: { data: { disablePullRequestAutoMerge: { pullRequest: { id: 'PR_kwDOfixture42', autoMergeRequest: { enabledAt: null } } } } } }) });
  await assert.rejects(unconfirmed.cancelMergeWhenReady(key, 'PR_kwDOfixture42', signal()), (error: any) => error.outcomeUnknown === true && error.message === 'GitHub may have cancelled merge when ready. Check the PR before trying again.');
  const interrupted = new GitHubClient({ get: async () => { throw new Error('unused'); }, disableAutoMerge: async () => { throw Object.assign(new Error('interrupted'), { code: 'GITHUB_POST_UNCERTAIN' }); } });
  await assert.rejects(interrupted.cancelMergeWhenReady(key, 'PR_kwDOfixture42', signal()), (error: any) => error.outcomeUnknown === true);
});

test('the Merge menu offers merge when ready while GitHub cannot merge yet and auto-merge is allowed, and otherwise stays as it was', () => {
  const choices = (pull: Partial<PullMergeState['pullRequest']> = {}, repository: Partial<Omit<PullMergeState, 'pullRequest'>> = {}) => mergeChoices(state(pull, { autoMergeAllowed: true, ...repository })) as { prompt: string; options: { id: string; label: string }[] };
  const name = '#42 “Make billing plan changes predictable”';
  for (const [status, warning] of [['BLOCKED', 'Required reviews or checks are not satisfied.'], ['UNKNOWN', 'GitHub is still checking whether it can merge.'], ['BEHIND', 'The branch is out of date with main.']] as const) {
    assert.deepEqual(choices({ mergeStateStatus: status }), { prompt: `Merge ${name} into main at aaaaaaa when ready? ${warning}`, options: [
      { id: 'MERGE_WHEN_READY', label: 'Create a merge commit when ready' }, { id: 'SQUASH_WHEN_READY', label: 'Squash and merge when ready' }, { id: 'REBASE_WHEN_READY', label: 'Rebase and merge when ready' }] }, status);
  }
  assert.deepEqual(choices({ mergeStateStatus: 'BLOCKED' }, { mergeCommitAllowed: false, viewerDefaultMergeMethod: 'REBASE' }).options.map(option => option.id), ['REBASE_WHEN_READY', 'SQUASH_WHEN_READY']);
  assert.deepEqual(choices({ mergeStateStatus: 'BLOCKED', isMergeQueueEnabled: true }), { prompt: `Add ${name} to the main merge queue at aaaaaaa when ready? Required reviews or checks are not satisfied.`,
    options: [{ id: 'QUEUE_WHEN_READY', label: 'Add to merge queue when ready' }] });
  const today = (pull: Partial<PullMergeState['pullRequest']>, repository: Partial<Omit<PullMergeState, 'pullRequest'>> = {}) => assert.deepEqual(choices(pull, repository), mergeChoices(state(pull, repository)), JSON.stringify([pull, repository]));
  for (const status of ['CLEAN', 'UNSTABLE', 'HAS_HOOKS', 'DIRTY'] as const) today({ mergeStateStatus: status });
  today({ mergeStateStatus: 'BEHIND', isMergeQueueEnabled: true });
  for (const pull of [{ mergeStateStatus: 'BLOCKED', isDraft: true }, { mergeStateStatus: 'DRAFT' }, { mergeStateStatus: 'BLOCKED', state: 'CLOSED' }, { mergeStateStatus: 'BLOCKED', isMergeQueueEnabled: true, isInMergeQueue: true }] as const) today(pull);
  assert.deepEqual(choices({ mergeStateStatus: 'CLEAN' }).options.map(option => option.id), ['MERGE', 'SQUASH', 'REBASE']);
  assert.deepEqual(mergeChoices(state({ mergeStateStatus: 'BLOCKED' }, { autoMergeAllowed: false })), mergeChoices(state({ mergeStateStatus: 'BLOCKED' })));
  assert.deepEqual((mergeChoices(state({ mergeStateStatus: 'BLOCKED' })) as { options: { id: string }[] }).options.map(option => option.id), ['MERGE', 'SQUASH', 'REBASE'], 'without autoMergeAllowed the menu is as it was');
});

test('with merge when ready already on, the Merge menu says so and offers only to cancel it', () => {
  const enabledAt = '2026-10-30T09:00:00Z', name = '#42 “Make billing plan changes predictable”';
  assert.deepEqual(mergeChoices(state({ mergeStateStatus: 'BLOCKED', autoMergeRequest: { enabledAt, mergeMethod: 'SQUASH' } }, { autoMergeAllowed: true })), {
    prompt: `Merge when ready is on: GitHub will squash and merge ${name} into main once it can. Required reviews or checks are not satisfied.`, options: [{ id: 'CANCEL_WHEN_READY', label: 'Cancel merge when ready' }] });
  assert.equal((mergeChoices(state({ mergeStateStatus: 'CLEAN', autoMergeRequest: { enabledAt, mergeMethod: 'REBASE' } })) as { prompt: string }).prompt, `Merge when ready is on: GitHub will rebase and merge ${name} into main once it can.`);
  assert.equal((mergeChoices(state({ mergeStateStatus: 'BLOCKED', autoMergeRequest: { enabledAt, mergeMethod: 'MERGE' } })) as { prompt: string }).prompt, `Merge when ready is on: GitHub will merge ${name} into main once it can. Required reviews or checks are not satisfied.`);
  assert.equal((mergeChoices(state({ mergeStateStatus: 'BLOCKED', isMergeQueueEnabled: true, autoMergeRequest: { enabledAt, mergeMethod: 'MERGE' } })) as { prompt: string }).prompt, `Merge when ready is on: GitHub will add ${name} to the main merge queue once it can. Required reviews or checks are not satisfied.`);
  assert.match((mergeChoices(state({ state: 'MERGED', merged: true, autoMergeRequest: { enabledAt, mergeMethod: 'SQUASH' } })) as { refusal: string }).refusal, /already merged/);
});

test('merge readiness keeps the immediate merge method and reports merge when ready', () => {
  for (const status of ['BLOCKED', 'UNKNOWN', 'BEHIND', 'CLEAN'] as const) {
    assert.equal(mergeReadiness(state({ mergeStateStatus: status }, { autoMergeAllowed: true })).method, mergeReadiness(state({ mergeStateStatus: status })).method, status);
    assert.equal(mergeReadiness(state({ mergeStateStatus: status, isMergeQueueEnabled: true }, { autoMergeAllowed: true })).method, 'QUEUE', status);
  }
  assert.equal(mergeReadiness(state({ mergeStateStatus: 'BLOCKED' }, { autoMergeAllowed: true })).mergeWhenReady, false);
  const on = mergeReadiness(state({ mergeStateStatus: 'BLOCKED', autoMergeRequest: { enabledAt: null, mergeMethod: 'SQUASH' } }, { autoMergeAllowed: true }));
  assert.deepEqual([on.mergeWhenReady, on.method], [true, 'MERGE']);
});

test('connector applies merge when ready and its cancel to this PR and returns the refreshed snapshot', async () => {
  const f = githubFixture(), connector = githubPullRequestConnector(() => f.client), resource = { id: 'pr', pluginId: 'github.pull-request', schemaVersion: 1, title: 'PR', data: key } as any;
  f.mergeSettings = { ...f.mergeSettings, autoMergeAllowed: true, status: 'BLOCKED' };
  const choices = await connector.execute!(resource, 'pr.merge.options', signal()) as any;
  assert.deepEqual(choices.options.map((option: { id: string }) => option.id), ['SQUASH_WHEN_READY', 'MERGE_WHEN_READY', 'REBASE_WHEN_READY']);
  await assert.rejects(connector.execute!(resource, 'pr.merge', signal(), { ...choices.context, value: 'FAST_FORWARD_WHEN_READY', requestId: 'x' }), /incomplete/);
  const enabled = await connector.execute!(resource, 'pr.merge', signal(), { ...choices.context, value: 'SQUASH_WHEN_READY', requestId: 'x' }) as any;
  assert.deepEqual(f.merges, [{ pullRequestId: 'PR_kwDOfixture42', expectedHeadOid: head, method: 'SQUASH', whenReady: true }]);
  assert.equal(enabled.snapshot.detail.status, 'merge-when-ready'); assert.equal(enabled.snapshot.indicators[0].label, 'Merge when ready (squash)');
  assert.deepEqual(enabled.snapshot.detail.mergeWhenReady, { method: 'SQUASH', enabledAt: f.autoMerge!.enabledAt, statusWithout: 'open' });
  const on = await connector.execute!(resource, 'pr.merge.options', signal()) as any;
  assert.match(on.prompt, /^Merge when ready is on: GitHub will squash and merge #42 /); assert.deepEqual(on.options, [{ id: 'CANCEL_WHEN_READY', label: 'Cancel merge when ready' }]);
  const cancelled = await connector.execute!(resource, 'pr.merge', signal(), { ...on.context, value: 'CANCEL_WHEN_READY', requestId: 'y' }) as any;
  assert.deepEqual(f.mergeCancels, ['PR_kwDOfixture42']); assert.equal(f.merges.length, 1);
  assert.equal(cancelled.snapshot.detail.status, 'open'); assert.equal(cancelled.snapshot.detail.mergeWhenReady, undefined);

  f.mergeSettings = { ...f.mergeSettings, status: 'CLEAN' };
  await assert.rejects(connector.execute!(resource, 'pr.merge', signal(), { ...choices.context, value: 'SQUASH_WHEN_READY', requestId: 'z' }), /^Error: GitHub declined merge when ready because the pull request can be merged now\. Open Merge again to merge it\.$/);
  assert.equal(f.autoMerge, null);

  const q = githubFixture(), queued = githubPullRequestConnector(() => q.client); q.mergeSettings = { ...q.mergeSettings, autoMergeAllowed: true, queueEnabled: true, status: 'BLOCKED' };
  const queueChoices = await queued.execute!(resource, 'pr.merge.options', signal()) as any;
  assert.deepEqual(queueChoices.options, [{ id: 'QUEUE_WHEN_READY', label: 'Add to merge queue when ready' }]);
  const queueResult = await queued.execute!(resource, 'pr.merge', signal(), { ...queueChoices.context, value: 'QUEUE_WHEN_READY', requestId: 'x' }) as any;
  assert.deepEqual(q.merges, [{ pullRequestId: 'PR_kwDOfixture42', expectedHeadOid: head, method: 'QUEUE', whenReady: true }]);
  assert.equal(queueResult.snapshot.indicators[0].label, 'Merge when ready (merge queue)');

  const r = githubFixture(), refreshing = githubPullRequestConnector(() => r.client); r.mergeSettings = { ...r.mergeSettings, autoMergeAllowed: true, status: 'BLOCKED' };
  const context = (await refreshing.execute!(resource, 'pr.merge.options', signal()) as any).context;
  r.delay(async () => { if (r.merges.length || r.mergeCancels.length) throw new Error('offline'); });
  await assert.rejects(refreshing.execute!(resource, 'pr.merge', signal(), { ...context, value: 'REBASE_WHEN_READY', requestId: 'x' }), (error: any) => error.outcomeUnknown === true && /^Merge when ready turned on, but refresh failed/.test(error.message));
  await assert.rejects(refreshing.execute!(resource, 'pr.merge', signal(), { ...context, value: 'CANCEL_WHEN_READY', requestId: 'y' }), (error: any) => error.outcomeUnknown === true && /^Merge when ready cancelled, but refresh failed/.test(error.message));
});
