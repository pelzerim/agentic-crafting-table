import test from 'node:test';
import assert from 'node:assert/strict';
import { createResourcePluginRegistry } from '../../builtins.ts';
import type { ResourceRecord, ResourceSnapshot } from '../../types.ts';
import { githubIssueConnector } from './connector.ts';
import { githubIssueFixture } from '../../../../tests/fixtures/github-issue.ts';

const resource: ResourceRecord = { id: 'issue-r', pluginId: 'github.issue', schemaVersion: 1, title: 'fixture/web #7', connectionId: 'github-fixture', data: { owner: 'fixture', repo: 'web', number: 7 } };
const signal = () => AbortSignal.timeout(10_000);
const run = async (fixture: ReturnType<typeof githubIssueFixture>, action: string, input: Record<string, string> = {}) => githubIssueConnector(() => fixture.client).execute!(resource, action, signal(), { sourceResourceId: resource.id, requestId: '00000000-0000-4000-8000-000000000001', ...input });

test('an issue URL attaches as a GitHub issue named owner/repo #N; a pull request URL never does', () => {
  const registry = createResourcePluginRegistry();
  assert.deepEqual(registry.matchUrl('https://github.com/acme/web/issues/7').map(candidate => [candidate.pluginId, candidate.title, candidate.data]), [['github.issue', 'acme/web #7', { owner: 'acme', repo: 'web', number: 7 }]]);
  assert.equal(registry.matchInput('https://github.com/acme/web/pull/7').some(candidate => candidate.pluginId === 'github.issue'), false);
  assert.equal(registry.matchInput('http://github.com/acme/web/issues/7').some(candidate => candidate.pluginId === 'github.issue'), false);
  assert.equal(registry.matchInput('https://github.com/acme/web/issues/0').some(candidate => candidate.pluginId === 'github.issue'), false);
  assert.equal(registry.get('github.issue')?.todoSupport, true);
  assert.deepEqual(registry.conversions({ id: 'link', pluginId: 'web.link', schemaVersion: 1, title: 'github.com', data: { url: 'https://github.com/acme/web/issues/7' } }).map(candidate => candidate.pluginId), ['github.issue'], 'an issue saved as a web link upgrades in place (RES-10)');
});

test('a read shows the title, the state as a green Open cue and the description and comments; closing is done', async () => {
  const fixture = githubIssueFixture(), connector = githubIssueConnector(() => fixture.client);
  const open = await connector.load!(resource, signal());
  assert.equal(open.title, 'Search ignores accents'); assert.equal(open.label, 'Open'); assert.equal(open.done, false); assert.equal(open.activity, 'idle');
  assert.deepEqual(open.indicators, [{ id: 'state', label: 'Open', tone: 'green', icon: 'clock', showLabel: true }]);
  assert.equal(open.detail?.url, 'https://github.com/fixture/web/issues/7'); assert.deepEqual(open.detail?.labels, ['bug']);
  assert.deepEqual(open.detail?.comments, [{ id: 11, author: 'fixture-reviewer', body: 'Reproduced with **é** too.', date: '2026-10-02T08:00:00Z' }]);
  fixture.comments = []; fixture.reads.length = 0;
  await connector.load!(resource, signal());
  assert.deepEqual(fixture.reads, ['/repos/fixture/web/issues/7'], 'an issue without comments is read once');
  Object.assign(fixture.issue, { state: 'closed', state_reason: 'not_planned' });
  const closed = await connector.load!(resource, signal());
  assert.equal(closed.label, 'Not planned'); assert.equal(closed.done, true); assert.equal(closed.activity, 'complete'); assert.equal(closed.indicators?.[0]?.stage, 'done');
  const context = await connector.getContext!(resource, signal());
  assert.match(context.content, /GitHub issue fixture\/web#7 · Not planned/); assert.equal(context.sourceUrl, 'https://github.com/fixture/web/issues/7');
});

test('Change state offers open, completed and not planned with the current one marked, and refuses a stale choice', async () => {
  const fixture = githubIssueFixture();
  assert.deepEqual(await run(fixture, 'issue.state.options'), { current: 'open', context: { expectedState: 'open', sourceResourceId: 'issue-r' },
    options: [{ id: 'open', label: 'Open' }, { id: 'completed', label: 'Close as completed' }, { id: 'not_planned', label: 'Close as not planned' }] });
  const result = await run(fixture, 'issue.state.set', { value: 'not_planned', expectedState: 'open' }) as unknown as { snapshot: ResourceSnapshot };
  assert.deepEqual(fixture.writes, ['closed:not_planned']); assert.equal(result.snapshot.label, 'Not planned');
  await assert.rejects(run(fixture, 'issue.state.set', { value: 'open', expectedState: 'open' }), /changed on GitHub/);
  await run(fixture, 'issue.state.set', { value: 'open', expectedState: 'not_planned' });
  assert.deepEqual(fixture.writes, ['closed:not_planned', 'open:reopened']);
  await assert.rejects(run(fixture, 'issue.state.set', { value: 'duplicate', expectedState: 'open' }), /Choose open/);
  await assert.rejects(run(fixture, 'issue.state.set', { value: 'completed', expectedState: 'open', sourceResourceId: 'other' }), /another item/);
});

test('Mark done closes the issue as completed and Reopen reopens it; an issue already there is not written', async () => {
  const fixture = githubIssueFixture();
  assert.equal(((await run(fixture, 'issue.state.complete', { done: 'true' })) as unknown as { snapshot: ResourceSnapshot }).snapshot.done, true);
  await run(fixture, 'issue.state.complete', { done: 'true' });
  assert.deepEqual(fixture.writes, ['closed:completed']);
  assert.equal(((await run(fixture, 'issue.state.complete', { done: 'false' })) as unknown as { snapshot: ResourceSnapshot }).snapshot.done, false);
  assert.deepEqual(fixture.writes, ['closed:completed', 'open:reopened']);
  fixture.stateReply = () => ({ status: 200, headers: new Headers(), body: { ...fixture.issue } });
  await assert.rejects(run(fixture, 'issue.state.complete', { done: 'true' }), (error: Error & { outcomeUnknown?: boolean }) => error.outcomeUnknown === true);
});

test('linked pull requests are read from GitHub when asked for', async () => {
  const fixture = githubIssueFixture();
  assert.deepEqual(await run(fixture, 'issue.pulls'), { pulls: [{ owner: 'fixture', repo: 'web', number: 12 }] });
});
