import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startWorkspaceService } from './server.ts';
import { githubFixture, pullFixture } from '../../tests/fixtures/github.ts';

type Choices = { prompt: string; context: Record<string, string>; options: { id: string; label: string }[]; cachedAt?: number };

async function start(prefix: string, providers = githubFixture()) {
  const directory = await mkdtemp(join(tmpdir(), prefix)), service = await startWorkspaceService(directory, undefined, undefined, providers);
  const apply = async (commands: unknown[]) => service.control.dispatch({ commandId: crypto.randomUUID(), expectedRevision: (await service.control.read()).revision, actor: { kind: 'user', id: 'test' }, commands: commands as never });
  await apply([{ type: 'item.add', id: 'pr', resourceId: 'pr-resource', pluginId: 'github.pull-request', title: 'PR', position: { x: 0, y: 0 }, data: { owner: 'fixture', repo: 'billing', number: 42 } }]);
  await service.resources.poll();
  const choices = (actionId: string, input: Record<string, boolean> = {}) => service.resources.execute('pr', actionId, input, AbortSignal.timeout(10_000)) as Promise<Choices>;
  return { providers, service, apply, choices, close: async () => { await service.close(); await rm(directory, { recursive: true, force: true }); } };
}
const methods = (choices: Choices) => choices.options.map(option => option.id);

test('a cached ask answers from the last read without asking GitHub, and a refresh replaces it', async () => {
  const { providers, choices, close } = await start('craft-choices-cache-');
  try {
    const first = await choices('pr.merge.options', { cached: true });
    assert.equal(first.cachedAt, undefined);
    assert.deepEqual(methods(first), ['SQUASH', 'MERGE', 'REBASE']);
    providers.mergeSettings = { ...providers.mergeSettings, squash: false };
    const requests = providers.requests, cached = await choices('pr.merge.options', { cached: true });
    assert.equal(providers.requests, requests);
    assert.equal(typeof cached.cachedAt, 'number');
    assert.deepEqual(methods(cached), ['SQUASH', 'MERGE', 'REBASE']);
    const live = await choices('pr.merge.options', { refresh: true });
    assert.ok(providers.requests > requests);
    assert.equal(live.cachedAt, undefined);
    assert.deepEqual(methods(live), ['MERGE', 'REBASE']);
    assert.deepEqual(methods(await choices('pr.merge.options', { cached: true })), ['MERGE', 'REBASE']);
    const plain = await choices('pr.merge.options');
    assert.equal(plain.cachedAt, undefined);
  } finally { await close(); }
});

test('a write on the pull request forgets every cached menu, even when GitHub declines it', async () => {
  const { providers, service, choices, close } = await start('craft-choices-forget-');
  try {
    const stale = await choices('pr.merge.options', { cached: true });
    await choices('pr.state.options', { cached: true });
    providers.mergeSettings = { ...providers.mergeSettings, squash: false };
    assert.equal(typeof (await choices('pr.merge.options', { cached: true })).cachedAt, 'number');
    await service.resources.execute('pr', 'pr.merge', { ...stale.context, value: 'SQUASH', requestId: crypto.randomUUID() }, AbortSignal.timeout(10_000)).catch(() => {});
    await service.resources.writing();
    assert.deepEqual(providers.merges.map(merge => merge.method), ['SQUASH']);
    assert.equal(providers.pull.merged, false);
    for (const actionId of ['pr.merge.options', 'pr.state.options']) {
      const requests = providers.requests, next = await choices(actionId, { cached: true });
      assert.equal(next.cachedAt, undefined, actionId);
      assert.ok(providers.requests > requests, actionId);
    }
    assert.deepEqual(methods(await choices('pr.merge.options', { cached: true })), ['MERGE', 'REBASE']);
  } finally { await close(); }
});

test('a cached merge menu still names the blockers added since it was read', async () => {
  const blocker = { ...structuredClone(pullFixture), id: 64, number: 64, title: 'Thumbnail refresh loop' };
  const { providers, apply, choices, close } = await start('craft-choices-blockers-', githubFixture([blocker]));
  try {
    await choices('pr.merge.options', { cached: true });
    await apply([
      { type: 'item.add', id: 'blocker', resourceId: 'blocker-resource', pluginId: 'github.pull-request', title: 'Thumbnail refresh loop', position: { x: 400, y: 0 }, data: { owner: 'fixture', repo: 'billing', number: 64 } },
      { type: 'link.save', link: { id: 'blocks', sourceId: 'blocker', targetId: 'pr', kind: 'blocks', label: '' } },
    ]);
    const requests = providers.requests, cached = await choices('pr.merge.options', { cached: true });
    assert.equal(providers.requests, requests);
    assert.equal(typeof cached.cachedAt, 'number');
    assert.match(cached.prompt, /^Blocked by #64 Thumbnail refresh loop/);
    assert.equal(cached.options[0].label, 'Squash and merge anyway');
    assert.equal(cached.context.overrideBlockers, 'blocker');
  } finally { await close(); }
});

test('only actions that declare cacheChoices are answered from the cache', async () => {
  const { providers, choices, close } = await start('craft-choices-undeclared-');
  try {
    await choices('pr.mergeReadiness', { cached: true });
    const requests = providers.requests, again = await choices('pr.mergeReadiness', { cached: true });
    assert.ok(providers.requests > requests);
    assert.equal(again.cachedAt, undefined);
  } finally { await close(); }
});
