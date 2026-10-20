import test from 'node:test';
import assert from 'node:assert/strict';
import { githubPullRequestConnector } from './connector.ts';
import { githubFixture, pullFixture } from '../../../../tests/fixtures/github.ts';
import type { JsonObject, ResourceRecord, ResourceSnapshot } from '../../types.ts';

const resource: ResourceRecord = { id: 'pr', pluginId: 'github.pull-request', schemaVersion: 1, title: 'PR', data: { owner: 'fixture', repo: 'billing', number: 42 } };
const signal = () => AbortSignal.timeout(10_000);
async function setup(change: (fixture: ReturnType<typeof githubFixture>) => void = () => {}) {
  const fixture = githubFixture(); change(fixture);
  const connector = githubPullRequestConnector(() => fixture.client), snapshot = await connector.load(resource, signal());
  const optimistic = (actionId: string, input: JsonObject) => connector.actions!(resource).find(action => action.id === actionId)!.optimistic?.(snapshot, input);
  return { fixture, connector, snapshot, optimistic, read: () => connector.load(resource, signal()) };
}
const pull = (snapshot: ResourceSnapshot) => snapshot.detail?.pull as unknown as typeof pullFixture;
const cue = (snapshot: ResourceSnapshot) => snapshot.indicators?.find(indicator => indicator.id === 'review-state');
const merge = (value: string) => ({ value, pullRequestId: 'PR_kwDOfixture42', expectedHeadOid: 'a'.repeat(40), sourceResourceId: 'pr', requestId: crypto.randomUUID() });
const state = (value: string, expectedState = 'open') => ({ value, pullRequestId: 'PR_kwDOfixture42', expectedState, sourceResourceId: 'pr', requestId: crypto.randomUUID() });

test('a merge shows Merged at once and only a read of the merged pull request confirms it', async () => {
  const { fixture, connector, snapshot, optimistic, read } = await setup();
  const expected = optimistic('pr.merge', merge('SQUASH'))!;
  assert.equal(expected.pending, 'Merged · confirming');
  assert.equal(expected.subject, 'Merge of #42');
  assert.deepEqual(cue(expected.snapshot), { id: 'review-state', label: 'Merged', tone: 'violet', icon: 'git-merge', stage: 'done' });
  assert.equal(expected.snapshot.label, 'Merged · 1 comment');
  assert.equal(expected.snapshot.activity, 'complete');
  assert.equal(expected.snapshot.detail?.status, 'merged');
  assert.equal(pull(expected.snapshot).merged, true); assert.equal(pull(expected.snapshot).state, 'closed');
  assert.equal(pull(snapshot).merged, false, 'the saved read is left as it was');
  assert.equal(expected.landed(snapshot), false);
  await connector.execute!(resource, 'pr.merge', signal(), merge('SQUASH'));
  assert.equal(expected.landed(await read()), true);
  assert.equal(expected.landed({ ...snapshot, detail: undefined }), undefined, 'a read without content cannot tell');
  assert.equal(fixture.merges.length, 1, 'computing the expected result never writes');
});

test('adding to the merge queue shows Queued, confirmed by a queued or merged read', async () => {
  const { fixture, connector, snapshot, optimistic, read } = await setup(fixture => { fixture.mergeSettings = { ...fixture.mergeSettings, queueEnabled: true }; });
  const expected = optimistic('pr.merge', merge('QUEUE'))!;
  assert.equal(expected.pending, 'Queued · confirming'); assert.equal(expected.subject, 'Adding #42 to the merge queue');
  assert.deepEqual(cue(expected.snapshot), { id: 'review-state', label: 'Queued', tone: 'amber', icon: 'git-merge' });
  assert.equal(expected.snapshot.detail?.status, 'queued'); assert.equal(pull(expected.snapshot).merged, false);
  assert.equal(expected.landed(snapshot), false);
  await connector.execute!(resource, 'pr.merge', signal(), merge('QUEUE'));
  assert.equal(expected.landed(await read()), true);
  fixture.queue = { queued: false, position: null }; fixture.pull = { ...fixture.pull, state: 'closed', merged: true };
  assert.equal(expected.landed(await read()), true);
});

test('Show/Ship shows the tagged title at once; the current tag expects nothing', async () => {
  const { connector, snapshot, optimistic, read } = await setup();
  const input = { value: 'ship', expectedTitle: pullFixture.title, sourceResourceId: 'pr', requestId: crypto.randomUUID() };
  const expected = optimistic('pr.showShip', input)!;
  assert.equal(expected.snapshot.title, `[ship] ${pullFixture.title}`); assert.equal(pull(expected.snapshot).title, `[ship] ${pullFixture.title}`);
  assert.equal(expected.pending, 'Tagged [ship] · confirming'); assert.equal(expected.subject, 'Retitle of #42');
  assert.equal(expected.snapshot.label, snapshot.label);
  assert.equal(expected.landed(snapshot), false);
  await connector.execute!(resource, 'pr.showShip', signal(), input);
  assert.equal(expected.landed(await read()), true);
  const removed = optimistic('pr.showShip', { ...input, value: 'none', expectedTitle: `[show] ${pullFixture.title}` })!;
  assert.equal(removed.snapshot.title, pullFixture.title); assert.equal(removed.pending, 'Tag removed · confirming');
  assert.equal(optimistic('pr.showShip', { ...input, value: 'none' }), undefined, 'an untagged title has no tag to remove');
});

test('state changes show the lifecycle they ask for and a read of that lifecycle confirms them', async () => {
  const { connector, snapshot, optimistic, read } = await setup();
  const close = optimistic('pr.state', state('close'))!;
  assert.equal(close.pending, 'Closed · confirming'); assert.equal(close.subject, 'Closing #42');
  assert.deepEqual(cue(close.snapshot), { id: 'review-state', label: 'Closed', tone: 'red', icon: 'x', stage: 'done' });
  assert.equal(pull(close.snapshot).state, 'closed'); assert.equal(close.snapshot.activity, 'complete');
  assert.equal(close.landed(snapshot), false);
  const draft = optimistic('pr.state', state('draft'))!;
  assert.equal(draft.pending, 'Draft · confirming'); assert.equal(draft.subject, 'Converting #42 to a draft');
  assert.equal(pull(draft.snapshot).draft, true); assert.equal(cue(draft.snapshot)?.label, 'Draft');
  await connector.execute!(resource, 'pr.state', signal(), state('close'));
  const closed = await read();
  assert.equal(close.landed(closed), true); assert.equal(draft.landed(closed), false);
  const reopen = (await setup(fixture => { fixture.pull = { ...fixture.pull, state: 'closed' }; })).optimistic('pr.state', state('reopen', 'closed'))!;
  assert.equal(reopen.subject, 'Reopening #42'); assert.equal(cue(reopen.snapshot)?.label, 'Open'); assert.equal(reopen.landed(closed), false);
  const ready = (await setup(fixture => { fixture.pull = { ...fixture.pull, draft: true }; })).optimistic('pr.state', state('ready', 'draft'))!;
  assert.equal(ready.subject, 'Marking #42 ready for review'); assert.equal(pull(ready.snapshot).draft, false); assert.equal(cue(ready.snapshot)?.label, 'Open');
});

test('only the person’s writes declare an expected result', async () => {
  const { connector } = await setup();
  const declared = connector.actions!(resource).filter(action => action.optimistic).map(action => action.id);
  assert.deepEqual(declared, ['pr.merge', 'pr.state', 'pr.showShip']);
  for (const action of connector.actions!(resource).filter(action => action.optimistic)) assert.equal(action.humanOnly, true);
});
