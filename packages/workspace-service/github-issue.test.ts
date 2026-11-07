import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startWorkspaceService } from './server.ts';
import { connectWorkspace } from './client.ts';
import { githubIssueFixture } from '../../tests/fixtures/github-issue.ts';
import { ResourcePluginHost } from '../../src/resource-plugins/host.ts';
import { githubIssueConnector } from '../../src/resource-plugins/items/github-issue/connector.ts';
import type { ResourcePluginRegistry } from '../../src/resource-plugins/registry.ts';
import { resourceWebPage } from '../../src/resource-plugins/web-page.ts';
import type { ResourceChoices, ResourceSnapshot } from '../../src/resource-plugins/types.ts';

function providers() {
  const github = githubIssueFixture();
  return Object.assign(github, { host(registry: ResourcePluginRegistry) { const host = new ResourcePluginHost(registry); host.register('github.issue', githubIssueConnector(() => github.client)); return host; } });
}

test('a GitHub issue URL attaches the issue with its title and state; Mark done closes it on GitHub and Reopen reopens it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-github-issue-')), github = providers(), issue = randomUUID();
  const service = await startWorkspaceService(directory, undefined, undefined, github), client = await connectWorkspace(directory);
  const apply = async (type: 'node.complete' | 'node.reopen') => client.call('apply', { commandId: randomUUID(), expectedRevision: (await service.control.read()).revision, actor: { kind: 'user', id: 'test' }, commands: [{ type, id: issue }] });
  const node = async () => (await service.control.read()).nodes.find(candidate => candidate.id === issue)!;
  try {
    await client.call('item.create', { requestId: randomUUID(), nodeId: issue, resourceId: randomUUID(), title: 'Issue', pluginId: 'github.issue', expectedRevision: 0, position: { x: 200, y: 300 }, data: { url: 'https://github.com/fixture/web/issues/7' } });
    let state = await service.control.read();
    const resource = state.resources[0];
    assert.deepEqual([resource.pluginId, resource.data, resource.connectionId], ['github.issue', { owner: 'fixture', repo: 'web', number: 7 }, 'github-fixture']);
    assert.deepEqual(resourceWebPage(resource, service.control.registry, () => undefined), { label: 'Open on GitHub', url: 'https://github.com/fixture/web/issues/7' });
    const read = await client.call<ResourceSnapshot>('runtime.run', { nodeId: issue, action: 'resource.read', arguments: { refresh: true } });
    assert.equal(read.title, 'Search ignores accents'); assert.equal((await node()).summary, 'Open');
    await assert.rejects(client.call('runtime.run', { nodeId: issue, action: 'resource.action', arguments: { actionId: 'issue.state.complete', input: { done: 'true', sourceResourceId: resource.id } } }), /Use Mark done/);

    await apply('node.complete');
    assert.deepEqual(github.writes, ['closed:completed']); assert.ok((await node()).completedAt); assert.equal((await node()).summary, 'Closed');
    await apply('node.reopen');
    assert.deepEqual(github.writes, ['closed:completed', 'open:reopened']); assert.equal((await node()).completedAt, undefined);

    github.stateReply = () => ({ status: 403, headers: new Headers(), body: { message: 'Forbidden' } });
    await assert.rejects(apply('node.complete'), /permission to change this issue/);
    assert.equal((await node()).completedAt, undefined, 'a refused write reverts Mark done');

    const choices = await client.call<ResourceChoices>('runtime.run', { nodeId: issue, action: 'resource.action', arguments: { actionId: 'issue.state.options', input: {} } });
    await client.call('runtime.run', { nodeId: issue, action: 'resource.action', arguments: { actionId: 'issue.state.set', input: { ...choices.context, value: 'not_planned', requestId: randomUUID() } } });
    state = await service.control.read();
    assert.equal(github.writes.at(-1), 'closed:not_planned'); assert.equal((await node()).summary, 'Not planned'); assert.ok((await node()).completedAt, 'closing on GitHub checks Mark done');
  } finally { client.close(); await service.close(); await rm(directory, { recursive: true, force: true }); }
});
