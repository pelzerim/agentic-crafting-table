import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ResourceCoordinator } from './resources.ts';
import { SqliteStore } from './sqlite-store.ts';
import { WorkspaceControl } from '../core/control.ts';
import { githubFixture } from '../../tests/fixtures/github.ts';
import { rolloutFixture } from '../../tests/fixtures/rollout.ts';
import { githubRolloutConnector } from '../../src/resource-plugins/items/github-rollout/connector.ts';

test('a merged PR adds its deploy runs once, beside and linked to the PR, and never re-adds a deleted one', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'craft-merge-rollouts-')), store = new SqliteStore(join(directory, 'workspace.sqlite')), control = new WorkspaceControl(store);
  const github = githubFixture(), rollouts = rolloutFixture(); let now = Date.now();
  rollouts.run.repository.full_name = 'fixture/billing';
  const host = github.host(control.registry); host.register('github.rollout', githubRolloutConnector(() => rollouts.client));
  const coordinator = new ResourceCoordinator(store, control, host, github.connections, async () => {}, () => now);
  const apply = async (commands: any[]) => { await control.dispatch({ commandId: randomUUID(), expectedRevision: (await control.read()).revision, actor: { kind: 'user', id: 'fixture' }, commands }); };
  const poll = async () => { now += 61_000; await coordinator.poll(); };
  const rolloutNodes = async () => { const state = await control.read(); return state.nodes.filter(node => state.resources.find(r => r.id === node.resourceId)?.pluginId === 'github.rollout'); };
  try {
    await apply([{ type: 'project.create', id: 'project', title: 'Billing', summary: '', position: { x: 0, y: 0 } }]);
    const { nodeId } = await coordinator.attach({ requestId: randomUUID(), nodeId: randomUUID(), resourceId: randomUUID(), expectedRevision: 0, pluginId: 'github.pull-request', title: 'PR', projectId: 'project', position: { x: 100, y: 100 }, data: { url: 'https://github.com/fixture/billing/pull/42' } }) as { nodeId: string };
    github.runs = [{ id: 101, name: 'Web / Release', path: '.github/workflows/release.yml', event: 'push', status: 'in_progress', head_sha: 'c'.repeat(40) },
      { id: 102, name: 'CI', path: '.github/workflows/ci.yml', event: 'push', status: 'in_progress', head_sha: 'c'.repeat(40) }];
    await poll(); assert.equal((await rolloutNodes()).length, 0, 'open PRs do not look for rollouts');
    const calls = github.requests;
    github.pull = { ...github.pull, state: 'closed', merged: true, merge_commit_sha: 'c'.repeat(40), merged_at: new Date(now).toISOString() } as any;
    await poll();
    let state = await control.read(), added = await rolloutNodes();
    assert.equal(added.length, 1); assert.equal(added[0].projectId, 'project'); assert.equal(added[0].title, 'Web / Release');
    assert.ok(state.links.some(link => link.sourceId === nodeId && link.targetId === added[0].id && link.kind === 'reference'));
    assert.equal(state.resources.find(r => r.id === added[0].resourceId)?.connectionId, 'github-fixture');
    assert.ok(github.requests > calls);
    await poll(); assert.equal((await rolloutNodes()).length, 1, 'repeat polls do not duplicate');
    await apply([{ type: 'node.archive', id: added[0].id }]); await apply([{ type: 'node.delete', id: added[0].id }]);
    await poll(); assert.equal((await rolloutNodes()).length, 0, 'a deleted rollout stays deleted');
    github.runs = [...github.runs, { id: 103, name: 'Deploy chained', path: '.github/workflows/deploy.yml', event: 'workflow_run', status: 'waiting', head_sha: 'c'.repeat(40) }];
    rollouts.run = { ...rollouts.run, id: 103 }; rollouts.jobs = rollouts.jobs.map(job => ({ ...job, run_id: 103 }));
    await poll(); added = await rolloutNodes(); assert.equal(added.length, 1); assert.equal(added[0].title, 'Web / Release');
    github.pull = { ...github.pull, merged_at: new Date(Date.now() - 7 * 60 * 60_000).toISOString() } as any;
    const requests = github.requests; await poll();
    assert.equal(github.requests - requests, 4, 'outside the window only the PR, reviews and comments are read');
  } finally { await coordinator.close(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('a merged PR also finds rollouts that closed-PR events start on its head commit, once per head and deduplicated', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'craft-merge-head-rollouts-')), store = new SqliteStore(join(directory, 'workspace.sqlite')), control = new WorkspaceControl(store);
  const github = githubFixture(); let now = Date.now();
  const coordinator = new ResourceCoordinator(store, control, github.host(control.registry), github.connections, async () => {}, () => now);
  const apply = async (commands: any[]) => { await control.dispatch({ commandId: randomUUID(), expectedRevision: (await control.read()).revision, actor: { kind: 'user', id: 'fixture' }, commands }); };
  const poll = async () => { now += 61_000; await coordinator.poll(); };
  try {
    await apply([{ type: 'project.create', id: 'project', title: 'Billing', summary: '', position: { x: 0, y: 0 } }]);
    const { nodeId } = await coordinator.attach({ requestId: randomUUID(), nodeId: randomUUID(), resourceId: randomUUID(), expectedRevision: 0, pluginId: 'github.pull-request', title: 'PR', projectId: 'project', position: { x: 100, y: 100 }, data: { url: 'https://github.com/fixture/billing/pull/42' } }) as { nodeId: string };
    const discovered = async () => (await coordinator.cached(nodeId))?.discovered?.map(item => item.key).sort();
    const head = github.pull.head.sha, merge = 'c'.repeat(40), mergedAt = Date.now() - 120_000;
    github.runs = [
      { id: 301, name: 'Deploy API', path: '.github/workflows/deploy-api.yml', event: 'pull_request', status: 'in_progress', head_sha: head, created_at: new Date(mergedAt + 3000).toISOString() },
      { id: 302, name: 'Deploy preview', path: '.github/workflows/preview-deploy.yml', event: 'pull_request', status: 'completed', head_sha: head, created_at: new Date(mergedAt - 3_600_000).toISOString() },
      { id: 303, name: 'Web CD', path: '.github/workflows/web-cd.yml', event: 'push', status: 'in_progress', head_sha: merge, created_at: new Date(mergedAt + 5000).toISOString() },
    ];
    github.pull = { ...github.pull, state: 'closed', merged: true, merge_commit_sha: merge, merged_at: new Date(mergedAt).toISOString() } as any;
    let calls = github.requests; await poll();
    assert.equal(github.requests - calls, 6, 'the PR reads plus one runs read for each commit');
    assert.deepEqual(await discovered(), ['rollout:301', 'rollout:303']);
    calls = github.requests; await poll();
    assert.equal(github.requests - calls, 5, 'the head commit is not read again once its post-merge runs were seen');
    assert.deepEqual(await discovered(), ['rollout:301', 'rollout:303'], 'no duplicates');
    github.pull = { ...github.pull, merge_commit_sha: head } as any;
    calls = github.requests; await poll();
    assert.equal(github.requests - calls, 5, 'a fast-forward merge reads its single commit once');
    assert.deepEqual(await discovered(), ['rollout:301']);
  } finally { await coordinator.close(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('a merged PR whose REST read carries no merge commit still finds its deploy runs through the merge-commit read', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'craft-merge-rollouts-')), store = new SqliteStore(join(directory, 'workspace.sqlite')), control = new WorkspaceControl(store);
  const github = githubFixture(), rollouts = rolloutFixture(); let now = Date.now();
  rollouts.run.repository.full_name = 'fixture/billing';
  const host = github.host(control.registry); host.register('github.rollout', githubRolloutConnector(() => rollouts.client));
  const coordinator = new ResourceCoordinator(store, control, host, github.connections, async () => {}, () => now);
  const poll = async () => { now += 61_000; await coordinator.poll(); };
  const rolloutNodes = async () => { const state = await control.read(); return state.nodes.filter(node => state.resources.find(r => r.id === node.resourceId)?.pluginId === 'github.rollout'); };
  try {
    await control.dispatch({ commandId: randomUUID(), expectedRevision: (await control.read()).revision, actor: { kind: 'user', id: 'fixture' }, commands: [{ type: 'project.create', id: 'project', title: 'Billing', summary: '', position: { x: 0, y: 0 } }] });
    await coordinator.attach({ requestId: randomUUID(), nodeId: randomUUID(), resourceId: randomUUID(), expectedRevision: 0, pluginId: 'github.pull-request', title: 'PR', projectId: 'project', position: { x: 100, y: 100 }, data: { url: 'https://github.com/fixture/billing/pull/42' } });
    github.runs = [{ id: 101, name: 'Docs / Deploy', path: '.github/workflows/docs-deploy.yml', event: 'push', status: 'in_progress', head_sha: 'c'.repeat(40) }];
    await poll(); assert.equal(github.mergeCommitReads, 0, 'open PRs do not read a merge commit');
    const { merge_commit_sha: dropped, ...merged } = { ...github.pull, state: 'closed', merged: true, merged_at: new Date(now).toISOString() } as any; void dropped;
    github.pull = merged; github.mergeCommit = 'C'.repeat(40);
    await poll();
    const added = await rolloutNodes();
    assert.equal(added.length, 1); assert.equal(added[0].projectId, 'project');
    await poll(); await poll();
    assert.equal(github.mergeCommitReads, 1, 'the merge commit never changes, so it is read once');
    assert.equal((await rolloutNodes()).length, 1);
    github.pull = { ...github.pull, merged_at: new Date(now - 7 * 60 * 60_000).toISOString() } as any;
    await poll(); assert.equal(github.mergeCommitReads, 1, 'outside the window nothing more is read');
  } finally { await coordinator.close(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});
