import test from 'node:test';
import assert from 'node:assert/strict';
import { UPDATE_BRANCH_MUTATION, mergeDocument, githubMergeTransport, githubTransport } from './github-transport.ts';
import { githubFixture } from '../../tests/fixtures/github.ts';
import { githubPullRequestConnector } from '../../src/resource-plugins/items/github-pull-request/connector.ts';

const signal = () => AbortSignal.timeout(10_000), key = { owner: 'fixture', repo: 'billing', number: 42 }, head = 'a'.repeat(40);
const request = { pullRequestId: 'PR_kwDOfixture42', expectedHeadOid: head };

test('the branch update is one fixed rebase mutation with the pull request and the head it was read at', async () => {
  const sent: unknown[] = [], auth = { accounts: async () => [], token: async () => 'fixture-token' };
  const transport = githubMergeTransport('fixture', auth, (async (_url: any, options: any) => { sent.push(JSON.parse(options.body)); return Response.json({ data: null }); }) as typeof fetch);
  await transport.updateBranch!(request, signal());
  assert.deepEqual(sent, [{ query: UPDATE_BRANCH_MUTATION, variables: request }]);
  assert.match(UPDATE_BRANCH_MUTATION, /updateMethod: REBASE/);
  assert.equal(mergeDocument({ query: UPDATE_BRANCH_MUTATION, variables: request }), 'write');
  for (const variables of [{ ...request, updateMethod: 'MERGE' }, { pullRequestId: request.pullRequestId }, { ...request, expectedHeadOid: 'abc' }, { ...request, pullRequestId: 'PR"x' }])
    assert.equal(mergeDocument({ query: UPDATE_BRANCH_MUTATION, variables }), undefined, JSON.stringify(variables));
  assert.equal(mergeDocument({ query: UPDATE_BRANCH_MUTATION.replace('REBASE', 'MERGE'), variables: request }), undefined);
  assert.equal(githubTransport('fixture', auth).updateBranch, undefined);
});

test('the client sends the update once, reports a refusal as GitHub declining it and any doubt as outcome unknown', async () => {
  const f = githubFixture();
  const reply = (status: number, body: unknown) => f.replyToBranchUpdate(() => ({ status, headers: new Headers(), body }));
  reply(200, { data: { updatePullRequestBranch: null }, errors: [{ type: 'UNPROCESSABLE', message: 'Merge conflict between base and head' }] });
  await assert.rejects(f.client.updateBranch(key, request, signal()), (error: any) => error.code === 'GITHUB_REJECTED' && error.message === 'GitHub declined the branch update: Merge conflict between base and head');
  for (const [status, body] of [[502, null], [200, { data: { updatePullRequestBranch: { pullRequest: { id: 'PR_other', headRefOid: 'd'.repeat(40) } } } }], [200, { unexpected: true }]] as const) {
    reply(status, body); await assert.rejects(f.client.updateBranch(key, request, signal()), (error: any) => error.outcomeUnknown === true && /may have updated the branch/.test(error.message));
  }
  f.replyToBranchUpdate(undefined);
  assert.equal(await f.client.updateBranch(key, request, signal()), f.pull.head.sha);
  assert.notEqual(f.pull.head.sha, head, 'GitHub rebased the branch onto its base');
  assert.equal(f.branchUpdates.length, 5);
  await assert.rejects(f.client.updateBranch(key, request, signal()), (error: any) => error.code === 'GITHUB_REJECTED' && /Head branch was modified/.test(error.message), 'a moved head is refused');
});

test('pr.updateBranch is a human-only write bound to this pull request that returns the refreshed snapshot', async () => {
  const f = githubFixture(), connector = githubPullRequestConnector(() => f.client);
  const resource = { id: 'pr', pluginId: 'github.pull-request', schemaVersion: 1, title: 'PR', data: key } as any;
  const action = connector.actions!(resource).find(entry => entry.id === 'pr.updateBranch')!;
  assert.deepEqual([action.readOnly, action.humanOnly, action.updatesSnapshot], [false, true, true]);
  await assert.rejects(connector.execute!(resource, 'pr.updateBranch', signal(), { ...request, sourceResourceId: 'other', requestId: 'x' }), /another item/);
  await assert.rejects(connector.execute!(resource, 'pr.updateBranch', signal(), { ...request, expectedHeadOid: 'nope', sourceResourceId: 'pr', requestId: 'x' }), /incomplete/);
  assert.equal(f.branchUpdates.length, 0);
  const result = await connector.execute!(resource, 'pr.updateBranch', signal(), { ...request, sourceResourceId: 'pr', requestId: 'x' }) as any;
  assert.equal(result.snapshot.detail.pull.head.sha, f.pull.head.sha);
  assert.deepEqual(f.branchUpdates, [request]);
  const readiness = await connector.execute!(resource, 'pr.mergeReadiness', signal()) as any;
  assert.equal(readiness.baseHead, f.pull.base.sha, 'readiness names the base head an update is sent once for');
});
