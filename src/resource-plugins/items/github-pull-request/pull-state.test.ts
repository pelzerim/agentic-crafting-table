import test from 'node:test';
import assert from 'node:assert/strict';
import { pullStateChoices } from './pull-state.ts';
import { githubPullRequestConnector } from './connector.ts';
import { githubPullRequest } from './definition.ts';
import { githubFixture, pullFixture } from '../../../../tests/fixtures/github.ts';
import type { PullMergeState } from '../../../../packages/provider-runtime/github.ts';
import type { ResourceRecord } from '../../types.ts';

const signal = () => AbortSignal.timeout(10_000), title = pullFixture.title;
const resource: ResourceRecord = { id: 'pr', pluginId: 'github.pull-request', schemaVersion: 1, title: 'PR', data: { owner: 'fixture', repo: 'billing', number: 42 } };
const pull = (overrides: Partial<PullMergeState['pullRequest']> = {}) => ({ id: 'PR_kwDOfixture42', number: 42, title, state: 'OPEN' as const, isDraft: false, merged: false, ...overrides });
const ids = (value: ReturnType<typeof pullStateChoices>) => 'options' in value ? value.options.map(option => option.id) : value.refusal;

test('open PRs offer Convert to draft and Close…, drafts Mark ready and Close…, closed PRs Reopen, merged PRs nothing', () => {
  assert.deepEqual(ids(pullStateChoices(pull())), ['draft', 'close']);
  assert.deepEqual(ids(pullStateChoices(pull({ isDraft: true }))), ['ready', 'close']);
  assert.deepEqual(ids(pullStateChoices(pull({ state: 'CLOSED' }))), ['reopen']);
  assert.equal(ids(pullStateChoices(pull({ state: 'MERGED', merged: true }))), 'Merged pull requests can’t be closed, reopened or converted to a draft.');
  const open = pullStateChoices(pull()) as Exclude<ReturnType<typeof pullStateChoices>, { refusal: string }>;
  assert.equal(open.prompt, `Change #42 “${title}” on GitHub?`);
  assert.deepEqual(open.options.map(option => option.label), ['Convert to draft', 'Close pull request…']);
  assert.deepEqual(open.options[1].confirm, { prompt: `Close #42 “${title}”?`, note: 'You can reopen it later.', action: 'Close pull request',
    text: { field: 'comment', label: 'Comment (optional)', placeholder: 'Posted on the pull request before it closes', maxLength: 60_000 } });
  assert.equal(open.options[0].confirm, undefined, 'converting to a draft is reversible and applies at once');
  assert.deepEqual((pullStateChoices(pull({ isDraft: true })) as typeof open).options.map(option => option.label), ['Mark ready for review', 'Close pull request…']);
  assert.deepEqual((pullStateChoices(pull({ state: 'CLOSED' })) as typeof open).options.map(option => option.label), ['Reopen pull request']);
});

test('the state actions are human-only, declared once and shown as one map menu group', () => {
  const connector = githubPullRequestConnector(() => githubFixture().client), actions = connector.actions!(resource);
  const apply = actions.find(action => action.id === 'pr.state')!;
  assert.equal(apply.humanOnly, true); assert.equal(apply.updatesSnapshot, true); assert.equal(apply.inputFields?.comment?.required, false);
  assert.equal(actions.find(action => action.id === 'pr.state.options')?.readOnly, true);
  const group = githubPullRequest.contextMenu?.find(group => group.id === 'state');
  assert.deepEqual(group, { id: 'state', label: 'Change state', children: [], choices: { load: 'pr.state.options', apply: 'pr.state', loadingLabel: 'Checking the pull request…' } });
});

test('connector closes with a comment, comment first, and returns the refreshed snapshot', async () => {
  const f = githubFixture(), connector = githubPullRequestConnector(() => f.client);
  const choices = await connector.execute!(resource, 'pr.state.options', signal()) as any;
  assert.deepEqual(choices.context, { sourceResourceId: 'pr', pullRequestId: 'PR_kwDOfixture42', expectedState: 'open' });
  const closed = await connector.execute!(resource, 'pr.state', signal(), { ...choices.context, value: 'close', comment: 'Superseded by #43.', requestId: 'x' }) as any;
  assert.deepEqual(f.writes, ['comment', 'state:closed']); assert.equal(f.posts[0].body, 'Superseded by #43.');
  assert.equal(closed.snapshot.detail.pull.state, 'closed');
  const reopen = await connector.execute!(resource, 'pr.state.options', signal()) as any;
  assert.deepEqual(reopen.options.map((option: any) => option.id), ['reopen']); assert.equal(reopen.context.expectedState, 'closed');
  await connector.execute!(resource, 'pr.state', signal(), { ...reopen.context, value: 'reopen', requestId: 'x' });
  assert.deepEqual(f.writes, ['comment', 'state:closed', 'state:open']);
});

test('connector toggles draft and ready and posts nothing for an empty comment', async () => {
  const f = githubFixture(), connector = githubPullRequestConnector(() => f.client);
  let choices = await connector.execute!(resource, 'pr.state.options', signal()) as any;
  const draft = await connector.execute!(resource, 'pr.state', signal(), { ...choices.context, value: 'draft', requestId: 'x' }) as any;
  assert.equal(draft.snapshot.detail.pull.draft, true);
  choices = await connector.execute!(resource, 'pr.state.options', signal());
  assert.deepEqual(choices.options.map((option: any) => option.id), ['ready', 'close']);
  await connector.execute!(resource, 'pr.state', signal(), { ...choices.context, value: 'ready', requestId: 'x' });
  choices = await connector.execute!(resource, 'pr.state.options', signal());
  await connector.execute!(resource, 'pr.state', signal(), { ...choices.context, value: 'close', comment: '   ', requestId: 'x' });
  assert.deepEqual(f.writes, ['draft:true', 'draft:false', 'state:closed']); assert.equal(f.posts.length, 0);
  assert.deepEqual(f.drafts.map(entry => entry.pullRequestId), ['PR_kwDOfixture42', 'PR_kwDOfixture42']);
});

test('connector refuses another item, incomplete input and merged PRs, sends a stale change and lets GitHub decide; a refresh failure is outcome-unknown', async () => {
  const f = githubFixture(), connector = githubPullRequestConnector(() => f.client);
  const choices = await connector.execute!(resource, 'pr.state.options', signal()) as any;
  await assert.rejects(connector.execute!(resource, 'pr.state', signal(), { ...choices.context, value: 'close', sourceResourceId: 'other', requestId: 'x' }), /another item/);
  for (const input of [{ value: 'merge' }, { expectedState: 'gone' }, { pullRequestId: 'PR x' }, { comment: 42 }])
    await assert.rejects(connector.execute!(resource, 'pr.state', signal(), { ...choices.context, value: 'close', requestId: 'x', ...input } as any), /incomplete/);
  assert.deepEqual(f.writes, []);
  await connector.execute!(resource, 'pr.state', signal(), { ...choices.context, value: 'ready', requestId: 'x' });
  assert.deepEqual(f.writes, ['draft:false']);
  f.pull = { ...f.pull, state: 'closed', merged: true };
  await assert.rejects(connector.execute!(resource, 'pr.state.options', signal()), /Merged pull requests/);

  const r = githubFixture(), refreshing = githubPullRequestConnector(() => r.client);
  const context = (await refreshing.execute!(resource, 'pr.state.options', signal()) as any).context;
  r.delay(async () => { if (r.writes.length) throw new Error('offline'); });
  await assert.rejects(refreshing.execute!(resource, 'pr.state', signal(), { ...context, value: 'close', requestId: 'x' }), (error: any) => error.outcomeUnknown === true && /Closed, but refresh failed/.test(error.message));
  assert.deepEqual(r.writes, ['state:closed']);
});
