import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startWorkspaceService } from './server.ts';
import { githubFixture, pullFixture } from '../../tests/fixtures/github.ts';

test('merging a PR with an unresolved blocker warns in the prompt and needs the explicit anyway choice', async () => {
  const blocker = { ...structuredClone(pullFixture), id: 64, number: 64, title: 'Thumbnail refresh loop' };
  const directory = await mkdtemp(join(tmpdir(), 'craft-blocking-')), providers = githubFixture([blocker]);
  const service = await startWorkspaceService(directory, undefined, undefined, providers);
  const signal = AbortSignal.timeout(10_000);
  const apply = async (commands: unknown[]) => service.control.dispatch({ commandId: crypto.randomUUID(), expectedRevision: (await service.control.read()).revision, actor: { kind: 'user', id: 'test' }, commands: commands as never });
  try {
    await apply([
      { type: 'item.add', id: 'pr', resourceId: 'pr-resource', pluginId: 'github.pull-request', title: 'PR', position: { x: 0, y: 0 }, data: { owner: 'fixture', repo: 'billing', number: 42 } },
      { type: 'item.add', id: 'blocker', resourceId: 'blocker-resource', pluginId: 'github.pull-request', title: 'Thumbnail refresh loop', position: { x: 400, y: 0 }, data: { owner: 'fixture', repo: 'billing', number: 64 } },
      { type: 'link.save', link: { id: 'blocks', sourceId: 'blocker', targetId: 'pr', kind: 'blocks', label: '' } },
    ]);
    await service.resources.poll();
    const options = await service.resources.execute('pr', 'pr.merge.options', {}, signal) as { prompt: string; context: Record<string, string>; options: { id: string; label: string }[] };
    assert.equal(options.prompt, 'Blocked by #64 Thumbnail refresh loop (open). Merge #42 “Make billing plan changes predictable” into main at aaaaaaa?');
    assert.deepEqual(options.options.map(option => [option.id, option.label]), [['SQUASH', 'Squash and merge anyway'], ['MERGE', 'Create a merge commit anyway'], ['REBASE', 'Rebase and merge anyway']]);
    const { overrideBlockers, ...plain } = options.context;
    assert.equal(overrideBlockers, 'blocker');
    await assert.rejects(service.resources.execute('pr', 'pr.merge', { ...plain, value: 'SQUASH', requestId: crypto.randomUUID() }, signal), /Blocked by #64 Thumbnail refresh loop\. Reopen the menu and choose an option marked “anyway”/);
    assert.equal(providers.merges.length, 0);

    // Once the blocker merges, the prompt and choices are the ordinary ones again.
    blocker.merged = true; blocker.state = 'closed';
    await service.resources.read('blocker', true);
    const clear = await service.resources.execute('pr', 'pr.merge.options', {}, signal) as typeof options;
    assert.equal(clear.prompt, 'Merge #42 “Make billing plan changes predictable” into main at aaaaaaa?');
    assert.equal(clear.options[0].label, 'Squash and merge'); assert.equal(clear.context.overrideBlockers, undefined);
    await service.resources.execute('pr', 'pr.merge', { ...clear.context, value: 'SQUASH', requestId: crypto.randomUUID() }, signal);
    await service.resources.writing();
    assert.equal(providers.merges.length, 1);
  } finally { await service.close(); await rm(directory, { recursive: true, force: true }); }
});

test('the anyway choice merges a blocked PR, and a blocker added after the prompt refuses it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-blocking-anyway-')), providers = githubFixture();
  const service = await startWorkspaceService(directory, undefined, undefined, providers);
  const signal = AbortSignal.timeout(10_000);
  const apply = async (commands: unknown[]) => service.control.dispatch({ commandId: crypto.randomUUID(), expectedRevision: (await service.control.read()).revision, actor: { kind: 'user', id: 'test' }, commands: commands as never });
  try {
    await apply([
      { type: 'item.add', id: 'pr', resourceId: 'pr-resource', pluginId: 'github.pull-request', title: 'PR', position: { x: 0, y: 0 }, data: { owner: 'fixture', repo: 'billing', number: 42 } },
      { type: 'item.add', id: 'agent', resourceId: 'agent-resource', pluginId: 'agent.session', title: 'Claude', position: { x: 400, y: 0 }, data: { sessionId: 'session', provider: 'claude' } },
      { type: 'item.add', id: 'todo', resourceId: 'todo-resource', pluginId: 'workspace.todo', title: 'Write the migration', position: { x: 400, y: 200 }, data: {} },
      { type: 'link.save', link: { id: 'agent-blocks', sourceId: 'agent', targetId: 'pr', kind: 'blocks', label: '' } },
    ]);
    await service.resources.poll();
    const options = await service.resources.execute('pr', 'pr.merge.options', {}, signal) as { prompt: string; context: Record<string, string> };
    assert.match(options.prompt, /^Blocked by Claude \(open\)\. Merge #42/);
    await apply([{ type: 'link.save', link: { id: 'todo-blocks', sourceId: 'todo', targetId: 'pr', kind: 'blocks', label: '' } }]);
    await assert.rejects(service.resources.execute('pr', 'pr.merge', { ...options.context, value: 'SQUASH', requestId: crypto.randomUUID() }, signal), /Blocked by Write the migration\. Reopen the menu/);
    await apply([{ type: 'link.remove', id: 'todo-blocks' }]);
    await service.resources.execute('pr', 'pr.merge', { ...options.context, value: 'SQUASH', requestId: crypto.randomUUID() }, signal);
    await service.resources.writing();
    assert.deepEqual(providers.merges.map(merge => merge.method), ['SQUASH']);
  } finally { await service.close(); await rm(directory, { recursive: true, force: true }); }
});
