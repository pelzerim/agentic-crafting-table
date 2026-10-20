import { githubRollout } from './items/github-rollout/definition.ts';
import { githubRolloutConnector } from './items/github-rollout/connector.ts';
import { rolloutFixture } from '../../tests/fixtures/rollout.ts';
import { slackMessage } from './items/slack-message/definition.ts';
import { slackMessageConnector } from './items/slack-message/connector.ts';
import { slackFixture, slackInput } from '../../tests/fixtures/slack.ts';
import { linearTicket } from './items/linear-ticket/definition.ts';
import { linearTicketConnector } from './items/linear-ticket/connector.ts';
import { linearFixture } from '../../tests/fixtures/linear.ts';
import { notionPage } from './items/notion-page/definition.ts';
import { notionPageConnector } from './items/notion-page/connector.ts';
import { notionFixture, notionPageId } from '../../tests/fixtures/notion.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { itemDefinitions } from './catalog.ts';
import { resourcePluginContract } from './testing.ts';
import type { JsonObject } from './types.ts';

const data: Record<string, JsonObject> = {
  'agent.session': { sessionId: 'fixture-agent', provider: 'claude' },
  'terminal.session': { sessionId: 'fixture-terminal', workspaceId: 'local', shell: 'zsh', cwd: '/fixture' },
  'github.rollout': { owner: 'fixture', repo: 'web', runId: 101 },
  'github.pull-request': { owner: 'fixture', repo: 'app', number: 42 },
  'claude.artifact': { url: 'https://claude.ai/code/artifact/00000000-0000-4000-8000-000000000042', artifactId: '00000000-0000-4000-8000-000000000042', sourcePrId: 'pr', headSha: 'a'.repeat(40), sessionId: 'agent' },
  'code.review': { provider: 'claude', sessionId: 'review', sourcePrId: 'pr', baseSha: 'b'.repeat(40), headSha: 'a'.repeat(40), model: 'opus' },
  'github.review-run': { requestId: 'request', sourcePrId: 'pr', repository: 'fixture/app' },
  'linear.ticket': { issueId: 'BIL-128' }, 'notion.page': { pageId: notionPageId },
  'slack.message': slackInput,
  'web.bookmark': { url: 'https://example.com' },
  'web.link': { url: 'https://example.com' }, 'workspace.todo': { notes: 'Fixture notes' }, 'workspace.note': { text: 'First line\nSecond line' },
};
test('every shipped item definition supplies an explicit shared-contract fixture', () => {
  assert.deepEqual(Object.keys(data).sort(), itemDefinitions.map(plugin => plugin.id).sort());
});
for (const plugin of itemDefinitions) resourcePluginContract(plugin, { valid: data[plugin.id], invalid: [Object.fromEntries(Object.keys(data[plugin.id]).map(key => [key, null]))] });

// Factory injection is explicit: this shared suite cannot fall through to a live API.
import { resourceConnectorContract } from './testing.ts';
import { bookmark } from './items/bookmark/definition.ts';
import { bookmarkConnector } from './items/bookmark/connector.ts';
import { todoItem } from './items/todo/definition.ts';
import { todoConnector } from './items/todo/connector.ts';
import { noteItem } from './items/note/definition.ts';
import { noteConnector } from './items/note/connector.ts';
import { webLink } from './items/web-link/definition.ts';
import { createWebLinkConnector } from './items/web-link/connector.ts';
import { githubPullRequest } from './items/github-pull-request/definition.ts';
import { githubPullRequestConnector } from './items/github-pull-request/connector.ts';
import { githubFixture } from '../../tests/fixtures/github.ts';
import { claudeArtifact } from './items/claude-artifact/definition.ts';
import { claudeArtifactConnector } from './items/claude-artifact/connector.ts';
import { createResourcePluginHost } from './catalog.server.ts';
import { createResourcePluginRegistry } from './builtins.ts';
const connectors = [
  { plugin: githubRollout, connector: () => {
    const fixture = rolloutFixture(); fixture.run.status = 'waiting'; fixture.gates = [{ environment: { id: 1, name: 'production' }, wait_timer: 0, current_user_can_approve: true, reviewers: [{ type: 'Team' }] }];
    return githubRolloutConnector(() => fixture.client);
  }, actions: { 'rollout.approval.options': {}, 'rollout.approve': { value: 'approve', runId: '101', attempt: '1', environmentIds: '1', sourceResourceId: 'contract-resource', requestId: '99999999-9999-4999-8999-999999999999' }, 'rollout.shipped': { runId: 101, workflowId: 9, runNumber: 28, head: 'a'.repeat(40), branch: 'main' } } },
  { plugin: noteItem, connector: () => noteConnector, actions: {} },
  { plugin: slackMessage, connector: () => slackMessageConnector(async () => slackFixture().client), actions: {} },
  { plugin: linearTicket, connector: () => linearTicketConnector(async () => linearFixture().client), actions: { 'linear.status.options': {}, 'linear.status.complete': { done: 'true', restore: '', sourceResourceId: 'contract-resource', requestId: '99999999-9999-4999-8999-999999999998' }, 'linear.status.set': { value: '88888888-8888-4888-8888-888888888888', expectedStateId: '44444444-4444-4444-8444-444444444444', expectedUpdatedAt: '2026-09-26T12:00:00.000Z', sourceResourceId: 'contract-resource', requestId: '99999999-9999-4999-8999-999999999999' } } },
  { plugin: notionPage, connector: () => notionPageConnector(async () => notionFixture().client), actions: {} },
  { plugin: bookmark, connector: () => bookmarkConnector, actions: { reference: {} } },
  { plugin: todoItem, connector: () => todoConnector, actions: {} },
  { plugin: webLink, connector: () => createWebLinkConnector(async () => 'Fixture page'), actions: { reference: {} } },
  { plugin: claudeArtifact, connector: () => claudeArtifactConnector, actions: { reference: {} } },
  { plugin: githubPullRequest, connector: () => githubPullRequestConnector(() => githubFixture().client), actions: { files: { head: 'a'.repeat(40), base: 'b'.repeat(40) }, comments: {}, reviews: {}, reply: { kind: 'discussion', commentId: '5', body: 'Fixture reply', sourceResourceId: 'contract-resource', requestId: '00000000-0000-4000-8000-000000000001' },
    'pr.merge.options': {}, 'pr.mergeReadiness': {}, 'pr.merge': { value: 'SQUASH', pullRequestId: 'PR_kwDOfixture42', expectedHeadOid: 'a'.repeat(40), sourceResourceId: 'contract-resource', requestId: '00000000-0000-4000-8000-000000000002' },
    'pr.showShip.options': {}, 'pr.showShip': { value: 'ship', expectedTitle: 'Make billing plan changes predictable', sourceResourceId: 'contract-resource', requestId: '00000000-0000-4000-8000-000000000003' },
    'pr.state.options': {}, 'pr.state': { value: 'close', pullRequestId: 'PR_kwDOfixture42', expectedState: 'open', comment: 'Fixture closing comment', sourceResourceId: 'contract-resource', requestId: '00000000-0000-4000-8000-000000000004' } } },
] as const;
for (const fixture of connectors) resourceConnectorContract(fixture.plugin, { valid: data[fixture.plugin.id], connector: fixture.connector, actions: fixture.actions });
test('every shipped backend connector runs the shared fixture contract', () => {
  const registry = createResourcePluginRegistry(), host = createResourcePluginHost(registry, githubFixture().connections);
  assert.deepEqual(registry.list().filter(plugin => host.capabilities(plugin.id).load).map(plugin => plugin.id).sort(), connectors.map(fixture => fixture.plugin.id).sort());
});
