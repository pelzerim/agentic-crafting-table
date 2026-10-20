import assert from 'node:assert/strict';
import test from 'node:test';
import { agentSession, createResourcePluginRegistry, githubPullRequest } from './builtins.ts';
import { registryFromDescriptions } from './describe.client.ts';
import type { ResourceRecord } from './types.ts';
import { presentResource } from './views.ts';
import { registryWithSinglePartner, singlePartner } from '../../tests/fixtures/single-partner.ts';

test('Claude artifact provenance is optional but its artifact id is not', () => {
  const registry = createResourcePluginRegistry();
  const resource: ResourceRecord = { id: 'artifact-1', pluginId: 'claude.artifact', schemaVersion: 2, title: 'PR architecture', data: { artifactId: 'artifact-1', sourcePrId: 'PR_1', headSha: 'head-one', sessionId: 'claude-1' } };
  assert.equal(registry.resolve(resource).available, true);
  assert.equal(registry.resolve({ ...resource, data: { artifactId: 'artifact-1' } }).available, true);
  assert.equal(registry.resolve({ ...resource, data: { ...resource.data, artifactId: '' } }).available, false);
});

test('a plain terminal needs shell identity, not an AI provider, and cannot receive agent context', () => {
  const registry = createResourcePluginRegistry();
  const terminal: ResourceRecord = {
    id: 'shell-1', pluginId: 'terminal.session', schemaVersion: 1, title: 'Billing shell',
    data: { sessionId: 'pty-1', workspaceId: 'billing-dev-01', shell: 'zsh', cwd: '/workspace/app' },
  };
  const result = registry.resolve(terminal);
  assert.equal(result.available, true);
  if (result.available) assert.equal(result.plugin.acceptsContext, false);
  assert.equal(registry.resolve({ ...terminal, data: { ...terminal.data, sessionId: '' } }).available, false);
});

test('PR paste resolves through registration and rejects unrelated URLs', () => {
  const registry = createResourcePluginRegistry();
  assert.deepEqual(registry.matchInput(' https://github.com/acme/app/pull/483/files ').filter(p => p.pluginId === 'github.pull-request'), [{
    pluginId: 'github.pull-request', schemaVersion: 1,
    title: 'acme/app #483', data: { owner: 'acme', repo: 'app', number: 483 },
  }]);
  assert.equal(registry.matchInput('https://github.com.example.org/acme/app/pull/483').some(p => p.pluginId === 'github.pull-request'), false);
  assert.equal(registry.matchInput('https://github.com/acme/app/issues/483').some(p => p.pluginId === 'github.pull-request'), false);
});

test('a one-off review is an independent resource tied to a PR and immutable comparison', () => {
  const registry = createResourcePluginRegistry();
  const review: ResourceRecord = {
    id: 'review-1', pluginId: 'code.review', schemaVersion: 1, title: 'Claude review',
    data: { sessionId: 'claude-review-1', sourcePrId: 'PR_482', provider: 'claude', model: 'opus', baseSha: 'base-one', headSha: 'head-one' },
  };
  const result = registry.resolve(review);
  assert.equal(result.available, true);
  if (result.available) assert.equal(result.plugin.acceptsContext, false);
  for (const field of ['sourcePrId', 'sessionId', 'baseSha', 'headSha', 'model']) {
    assert.equal(registry.resolve({ ...review, data: { ...review.data, [field]: '' } }).available, false);
  }
  assert.equal(registry.resolve({ ...review, data: { ...review.data, provider: 'unknown' } }).available, false);
});

test('duplicate registration cannot silently replace a resource implementation', () => {
  const registry = createResourcePluginRegistry();
  assert.throws(() => registry.register(agentSession), /already registered/);
});

test('plugin discovery describes one or many relationships and rejects invalid rules', () => {
  const registry = registryWithSinglePartner();
  assert.deepEqual(registry.describe().find(p => p.id === singlePartner.id)?.relationships, { cardinality: 'one' });
  assert.deepEqual(registry.describe().find(p => p.id === 'agent.session')?.relationships, { cardinality: 'many' });
  assert.equal(registryFromDescriptions(JSON.parse(JSON.stringify(registry.describe()))).get('github.rollout')?.manualAcknowledge, true);
  assert.deepEqual(presentResource(registry, { id: 'device', pluginId: singlePartner.id, schemaVersion: 1, title: 'Device', data: { deviceId: 'device' } }).relationships, { cardinality: 'one' });
  assert.throws(() => registry.register({ ...githubPullRequest, id: 'test.invalid', relationships: { cardinality: 'invalid' as any } }), /cardinality/);
});

test('multiple matching plugins remain explicit choices', () => {
  const registry = createResourcePluginRegistry();
  registry.register({ ...githubPullRequest, id: 'custom.review' });
  assert.deepEqual(registry.matchInput('https://github.com/acme/app/pull/483').map(p => p.pluginId), ['github.pull-request', 'web.link', 'custom.review']);
});

test('missing plugins and incompatible data preserve the saved resource', () => {
  const registry = createResourcePluginRegistry();
  const resource: ResourceRecord = {
    id: 'r1', pluginId: 'agent.session', schemaVersion: 1, title: 'Implementation',
    data: { sessionId: 'session-1', provider: 'claude' },
  };
  const available = registry.resolve(resource);
  assert.equal(available.available, true);
  if (available.available) assert.equal(available.plugin.preferredView, 'focus');
  for (const variant of [
    { ...resource, pluginId: 'missing.widget' },
    { ...resource, schemaVersion: 2 },
    { ...resource, data: {} },
  ]) {
    const result = registry.resolve(variant);
    assert.equal(result.available, false);
    assert.equal(result.resource, variant);
  }
});

test('header pipelines come from plugin metadata that survives the renderer description', () => {
  const registry = registryFromDescriptions(createResourcePluginRegistry().describe());
  const pull: ResourceRecord = { id: 'pr', pluginId: 'github.pull-request', schemaVersion: 1, title: 'Thumbnail refresh loop', data: { owner: 'o', repo: 'r', number: 64 } };
  const ticket: ResourceRecord = { id: 't', pluginId: 'linear.ticket', schemaVersion: 1, title: 'APP-12 · Upload timeouts', data: { issueId: 'APP-12' } };
  assert.deepEqual(presentResource(registry, pull).overview?.pipeline, { singular: 'PR', plural: 'PRs' });
  assert.equal(presentResource(registry, ticket).overview?.pipeline, undefined);
  assert.deepEqual(presentResource(registry, ticket).overview?.tally, { singular: 'ticket', plural: 'tickets' }, 'dashboards count tickets by state');
  assert.equal(presentResource(registry, pull).overview?.tally, undefined);
});
